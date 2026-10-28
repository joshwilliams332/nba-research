#!/usr/bin/env python3
"""Download NBA data and write the JSON files the Hoop Lab site reads.

Sources:
  ESPN's public site API   schedule, scores, quarter scores, game lines (spread / total / moneyline),
                           box scores and the injury report. Free, no key.
  The Odds API             player prop lines (points first, then rebounds / assists / threes when
                           the month's free credits allow). Needs ODDS_API_KEY; skipped without it.

Everything that never changes once a game is final (box scores, finished days, past prop lines) is
kept in a "store" folder so each run only downloads what's new. The deploy workflow keeps that folder
on the repo's `data` branch. The script only uses the standard library (Python 3.9+):

    python3 scripts/build_data.py                  # normal run (store in ./store)
    python3 scripts/build_data.py --offline        # rebuild site/data from the store, no downloads
    python3 scripts/build_data.py --no-odds        # skip The Odds API

Output (site/data/):
    meta.json      build time, season, stat column order, odds credit status
    teams.json     abbreviation -> name, conference, division, color, logo
    games.json     every game this season and last (regular season, play-in, playoffs) + next 7 days
    players.json   ESPN id -> name, position, current team
    logs.json      ESPN id -> game log rows (column order in meta.cols)
    props.json     today's prop lines by game
    proplines.json past prop lines: player id -> game id -> stat -> line
    injuries.json  the current injury report
    periods.json   player id -> game id -> 1st-quarter / 1st-half pts, reb, ast, 3pm (from play-by-play)
    shots.json     shot zones: league, each player and each team defense (allowed), per season
    wp/<id>.json   win probability and season series for each final game
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "site" / "data"
ET = ZoneInfo("America/New_York")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ODDS = "https://api.the-odds-api.com/v4/sports/basketball_nba"
UA = "Mozilla/5.0 (compatible; HoopLab/1.0; +https://github.com/joshwilliams332/nba-research)"

# abbreviation: (city, nickname, conference, division, color, ESPN code)
TEAMS = {
    "ATL": ("Atlanta", "Hawks", "East", "Southeast", "#E03A3E", "atl"),
    "BOS": ("Boston", "Celtics", "East", "Atlantic", "#007A33", "bos"),
    "BKN": ("Brooklyn", "Nets", "East", "Atlantic", "#777D84", "bkn"),
    "CHA": ("Charlotte", "Hornets", "East", "Southeast", "#00788C", "cha"),
    "CHI": ("Chicago", "Bulls", "East", "Central", "#CE1141", "chi"),
    "CLE": ("Cleveland", "Cavaliers", "East", "Central", "#860038", "cle"),
    "DAL": ("Dallas", "Mavericks", "West", "Southwest", "#00538C", "dal"),
    "DEN": ("Denver", "Nuggets", "West", "Northwest", "#1D428A", "den"),
    "DET": ("Detroit", "Pistons", "East", "Central", "#C8102E", "det"),
    "GSW": ("Golden State", "Warriors", "West", "Pacific", "#1D428A", "gs"),
    "HOU": ("Houston", "Rockets", "West", "Southwest", "#CE1141", "hou"),
    "IND": ("Indiana", "Pacers", "East", "Central", "#FDBB30", "ind"),
    "LAC": ("Los Angeles", "Clippers", "West", "Pacific", "#C8102E", "lac"),
    "LAL": ("Los Angeles", "Lakers", "West", "Pacific", "#552583", "lal"),
    "MEM": ("Memphis", "Grizzlies", "West", "Southwest", "#5D76A9", "mem"),
    "MIA": ("Miami", "Heat", "East", "Southeast", "#98002E", "mia"),
    "MIL": ("Milwaukee", "Bucks", "East", "Central", "#00471B", "mil"),
    "MIN": ("Minnesota", "Timberwolves", "West", "Northwest", "#236192", "min"),
    "NOP": ("New Orleans", "Pelicans", "West", "Southwest", "#85714D", "no"),
    "NYK": ("New York", "Knicks", "East", "Atlantic", "#F58426", "ny"),
    "OKC": ("Oklahoma City", "Thunder", "West", "Northwest", "#007AC1", "okc"),
    "ORL": ("Orlando", "Magic", "East", "Southeast", "#0077C0", "orl"),
    "PHI": ("Philadelphia", "76ers", "East", "Atlantic", "#006BB6", "phi"),
    "PHX": ("Phoenix", "Suns", "West", "Pacific", "#E56020", "phx"),
    "POR": ("Portland", "Trail Blazers", "West", "Northwest", "#E03A3E", "por"),
    "SAC": ("Sacramento", "Kings", "West", "Pacific", "#5A2D81", "sac"),
    "SAS": ("San Antonio", "Spurs", "West", "Southwest", "#C4CED4", "sa"),
    "TOR": ("Toronto", "Raptors", "East", "Atlantic", "#CE1141", "tor"),
    "UTA": ("Utah", "Jazz", "West", "Northwest", "#753BBD", "utah"),
    "WAS": ("Washington", "Wizards", "East", "Southeast", "#E31837", "wsh"),
}
# ESPN abbreviations (and a few other spellings) -> ours.
ALIASES = {code.upper(): abbr for abbr, t in TEAMS.items() for code in (t[5], abbr)}
ALIASES.update({"GS": "GSW", "NY": "NYK", "NO": "NOP", "SA": "SAS", "UTAH": "UTA", "WSH": "WAS", "PHO": "PHX", "BRK": "BKN"})
# Full names as The Odds API writes them ("Los Angeles Clippers", "Philadelphia 76ers").
FULL_NAME = {f"{t[0]} {t[1]}": abbr for abbr, t in TEAMS.items()}

# Game log columns, in the order each row stores them (after the game id, team and starter flag).
COLS = ["min", "pts", "reb", "ast", "fg3m", "fg3a", "fgm", "fga", "ftm", "fta",
        "oreb", "dreb", "stl", "blk", "tov", "pf", "pm"]
# Box score label -> the column(s) it fills. "8-17" style labels fill made and attempted.
LABELS = {
    "MIN": ("min",), "PTS": ("pts",), "REB": ("reb",), "AST": ("ast",),
    "FG": ("fgm", "fga"), "3PT": ("fg3m", "fg3a"), "FT": ("ftm", "fta"),
    "OREB": ("oreb",), "DREB": ("dreb",), "STL": ("stl",), "BLK": ("blk",),
    "TO": ("tov",), "PF": ("pf",), "+/-": ("pm",),
}
# ESPN's long stat keys, used when a box score has no labels.
KEY_LABEL = {
    "minutes": "MIN", "points": "PTS", "rebounds": "REB", "assists": "AST",
    "fieldGoalsMade-fieldGoalsAttempted": "FG",
    "threePointFieldGoalsMade-threePointFieldGoalsAttempted": "3PT",
    "freeThrowsMade-freeThrowsAttempted": "FT",
    "offensiveRebounds": "OREB", "defensiveRebounds": "DREB", "steals": "STL", "blocks": "BLK",
    "turnovers": "TO", "fouls": "PF", "plusMinus": "+/-",
}
# Regular season, playoffs and play-in. Preseason (1) is left out.
SEASON_TYPES = {2, 3, 5}

# The Odds API prop markets, in the order credits are spent on them.
MARKETS = [("player_points", "pts"), ("player_rebounds", "reb"), ("player_assists", "ast"), ("player_threes", "fg3m")]
CREDIT_RESERVE = 10        # never spend the last few credits of the month
PROPS_EARLIEST_HOUR = 10   # ET; books post most NBA props by late morning


def log(*args):
    print(*args, flush=True)


def fetch_json(url, tries=3, headers_out=None):
    """GET a JSON document, retrying network errors and 5xx/429 responses."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                if headers_out is not None:
                    headers_out.update({k.lower(): v for k, v in r.headers.items()})
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as e:
            last = e
        time.sleep(2 * (attempt + 1))
    raise last


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, data, pretty=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1 if pretty else None, separators=None if pretty else (",", ":"))
    path.write_text(text)


def num(v):
    """'12' -> 12, '+5' -> 5, '34:12' -> 34.2, '--' / '' / None -> None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else v
    s = str(v).strip()
    if not s or s in ("-", "--"):
        return None
    if ":" in s:
        m, _, sec = s.partition(":")
        try:
            return round(int(m) + int(sec) / 60, 1)
        except ValueError:
            return None
    try:
        f = float(s.replace("+", ""))
    except ValueError:
        return None
    return int(f) if f.is_integer() else f


def team_abbr(team):
    """Our abbreviation for an ESPN team object (or None for All-Star / international teams)."""
    if not team:
        return None
    return ALIASES.get(str(team.get("abbreviation", "")).upper())


def season_of(d):
    """The season an ET date belongs to, named by its ending year (2026-27 -> 2027), like ESPN."""
    return d.year + 1 if d.month >= 8 else d.year


def season_days(season, through):
    start, end = date(season - 1, 10, 1), min(date(season, 6, 30), through)
    return [start + timedelta(n) for n in range((end - start).days + 1)]


def name_key(name):
    """Normalize a player name for matching across sources: 'Kelly Oubre Jr.' -> 'kelly oubre'."""
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z ]", "", s.replace("-", " "))
    return " ".join(w for w in s.split() if w not in ("jr", "sr", "ii", "iii", "iv", "v"))


# ---------------------------------------------------------------- game lines


def first(*vals):
    return next((v for v in vals if v is not None), None)


def dig(obj, *path):
    for p in path:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(p)
    return obj


def side_odds(o, *path):
    """A price/line from ESPN's newer odds format, preferring the closing number."""
    for when in ("close", "current", "open"):
        raw = dig(o, *path, when, "odds")
        v = num(str(raw).upper().replace("EVEN", "100")) if raw is not None else None
        if v is not None:
            return v
    return None


def parse_line(odds_list, home, away):
    """ESPN odds (scoreboard `odds` or summary `pickcenter`) -> {sp (home spread), tot, mlh, mla, ...}."""
    if not odds_list:
        return None
    o = odds_list[0]
    line = {}
    details = str(o.get("details") or "").strip()
    m = re.match(r"^([A-Za-z]+)\s+([-+]?\d+(?:\.\d+)?)$", details)
    if m and ALIASES.get(m.group(1).upper()) in (home, away):
        val = float(m.group(2))
        line["sp"] = val if ALIASES[m.group(1).upper()] == home else -val
    elif details.upper() in ("EVEN", "PK", "PICK"):
        line["sp"] = 0.0
    elif o.get("spread") is not None:
        line["sp"] = num(o.get("spread"))
    tot = num(o.get("overUnder"))
    if tot is None:
        tot = num(str(dig(o, "total", "over", "close", "line") or "").lstrip("ou"))
    if tot is not None:
        line["tot"] = tot
    line["mlh"] = first(num(dig(o, "homeTeamOdds", "moneyLine")), side_odds(o, "moneyline", "home"))
    line["mla"] = first(num(dig(o, "awayTeamOdds", "moneyLine")), side_odds(o, "moneyline", "away"))
    line["sph"] = first(num(dig(o, "homeTeamOdds", "spreadOdds")), side_odds(o, "pointSpread", "home"))
    line["spa"] = first(num(dig(o, "awayTeamOdds", "spreadOdds")), side_odds(o, "pointSpread", "away"))
    line["ov"] = first(num(o.get("overOdds")), side_odds(o, "total", "over"))
    line["un"] = first(num(o.get("underOdds")), side_odds(o, "total", "under"))
    line["bk"] = dig(o, "provider", "name")
    line = {k: v for k, v in line.items() if v is not None}
    return line if ("sp" in line or "tot" in line or "mlh" in line) else None


# ---------------------------------------------------------------- schedule


def parse_event(ev, day):
    comp = (ev.get("competitions") or [{}])[0]
    sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
    home, away = sides.get("home"), sides.get("away")
    if not home or not away:
        return None
    h, a = team_abbr(home.get("team")), team_abbr(away.get("team"))
    stype = num(dig(ev, "season", "type"))
    if not h or not a or stype not in SEASON_TYPES:
        return None
    status = comp.get("status") or ev.get("status") or {}
    state = dig(status, "type", "state") or "pre"
    g = {
        "id": str(ev["id"]), "d": day.isoformat(), "t": ev.get("date"),
        "s": num(dig(ev, "season", "year")) or season_of(day), "st": stype,
        "h": h, "a": a, "state": state, "detail": dig(status, "type", "shortDetail"),
    }
    if comp.get("neutralSite"):
        g["n"] = 1
    for key, side in (("h", home), ("a", away)):
        rec = next((r.get("summary") for r in side.get("records") or []
                    if r.get("type") == "total" or r.get("name") in ("overall", "All Splits")), None)
        if rec:
            g[key + "r"] = rec
        if state != "pre":
            g[key + "s"] = num(side.get("score"))
            g[key + "q"] = [num(x.get("value", x.get("displayValue"))) for x in side.get("linescores") or []]
    line = parse_line(comp.get("odds"), h, a)
    if line:
        g["line"] = line
    venue = comp.get("venue") or {}
    if venue.get("fullName"):
        g["v"] = venue["fullName"]
    tv = [n for b in comp.get("broadcasts") or [] for n in b.get("names") or []]
    if tv:
        g["tv"] = ", ".join(tv[:2])
    return g


def build_schedule(store, today, offline):
    """Every game from last season through the next week. Finished days are cached in the store."""
    days_dir = store / "days"
    current = season_of(today)
    days = season_days(current - 1, today) + season_days(current, today + timedelta(7))
    todo = []
    for d in days:
        cached = read_json(days_dir / f"{d:%Y%m%d}.json")
        stale = cached is None or d >= today - timedelta(2) or any(g["state"] != "post" for g in cached)
        if stale and not offline:
            todo.append(d)

    def get(d):
        try:
            data = fetch_json(f"{ESPN}/scoreboard?dates={d:%Y%m%d}&limit=100")
        except Exception as e:  # keep the cached copy if ESPN hiccups
            log(f"  scoreboard {d}: {e}")
            return d, None
        if not (store / "samples" / "scoreboard.json").exists() and data.get("events"):
            write_json(store / "samples" / "scoreboard.json", data, pretty=True)
        return d, [g for g in (parse_event(ev, d) for ev in data.get("events", [])) if g]

    log(f"Schedule: {len(days)} days, fetching {len(todo)}")
    with ThreadPoolExecutor(8) as pool:
        for d, games in pool.map(get, todo):
            if games is not None:
                write_json(days_dir / f"{d:%Y%m%d}.json", games)

    games = {}
    for d in days:
        for g in read_json(days_dir / f"{d:%Y%m%d}.json", []):
            games[g["id"]] = g
    return sorted(games.values(), key=lambda g: (g["t"] or "", g["id"]))


# ---------------------------------------------------------------- box scores


def parse_stats(stats, labels):
    vals = dict.fromkeys(COLS)
    for i, label in enumerate(labels):
        cols = LABELS.get(label)
        if not cols or i >= len(stats):
            continue
        raw = str(stats[i])
        parts = raw.split("-", 1) if len(cols) == 2 else [raw]
        for col, part in zip(cols, parts):
            vals[col] = num(part)
    return [vals[c] if vals[c] is not None else 0 for c in COLS]


def parse_box(summary, gid):
    """ESPN game summary -> {rows: [[pid, team, starter, *COLS]], dnp, athletes, line}."""
    rows, dnp, athletes = [], [], {}
    for side in dig(summary, "boxscore", "players") or []:
        abbr = team_abbr(side.get("team"))
        if not abbr:
            continue
        for block in side.get("statistics") or []:
            labels = [str(x).upper() for x in block.get("labels") or []]
            if not labels:
                labels = [KEY_LABEL.get(k, k) for k in block.get("keys") or block.get("names") or []]
            for a in block.get("athletes") or []:
                ath = a.get("athlete") or {}
                pid = str(ath.get("id") or "")
                if not pid:
                    continue
                athletes[pid] = [ath.get("displayName"), ath.get("shortName"),
                                 dig(ath, "position", "abbreviation"), ath.get("jersey")]
                stats = a.get("stats") or []
                vals = parse_stats(stats, labels) if stats else None
                if a.get("didNotPlay") or not vals or (vals[0] == 0 and not any(vals[1:])):
                    dnp.append([pid, abbr, a.get("reason") or ""])
                    continue
                rows.append([pid, abbr, 1 if a.get("starter") else 0] + vals)
    box = {"id": gid, "rows": rows, "dnp": dnp, "athletes": athletes}
    comps = dig(summary, "header", "competitions") or [{}]
    sides = {c.get("homeAway"): team_abbr(c.get("team")) for c in comps[0].get("competitors", [])}
    line = parse_line(summary.get("pickcenter"), sides.get("home"), sides.get("away"))
    if line:
        box["line"] = line
    return box


def build_boxes(store, games, offline):
    """Box scores and play-by-play for final games. Both come from the same ESPN summary; games that already
    have a box score but no play-by-play (saved before play-by-play was kept) are fetched again for it."""
    box_dir, pbp_dir = store / "box", store / "pbp"
    finals = [g for g in games if g["state"] == "post"]
    todo = [g for g in finals if not (box_dir / f"{g['id']}.json").exists() or not (pbp_dir / f"{g['id']}.json").exists()]
    if offline:
        todo = []

    def get(g):
        try:
            data = fetch_json(f"{ESPN}/summary?event={g['id']}")
        except Exception as e:
            log(f"  summary {g['id']}: {e}")
            return g, None, None
        if not (store / "samples" / "summary.json").exists():
            write_json(store / "samples" / "summary.json", data, pretty=True)
        return g, parse_box(data, g["id"]), parse_pbp(data, g["id"])

    log(f"Box scores / play-by-play: fetching {len(todo)}")
    boxes_done = pbp_done = 0
    with ThreadPoolExecutor(8) as pool:
        for g, box, pbp in pool.map(get, todo):
            # A summary right after the buzzer can come back without player stats; try again next run.
            # An existing box file is never rewritten, so its format and contents stay as first saved.
            if box and box["rows"] and not (box_dir / f"{g['id']}.json").exists():
                write_json(box_dir / f"{g['id']}.json", box)
                boxes_done += 1
            if pbp and pbp["plays"] and (box_dir / f"{g['id']}.json").exists():
                write_json(pbp_dir / f"{g['id']}.json", pbp)
                pbp_done += 1
    log(f"  saved {boxes_done} box scores, {pbp_done} play-by-play")
    return {g["id"]: read_json(box_dir / f"{g['id']}.json") for g in finals}


# ---------------------------------------------------------------- play-by-play

REBOUND_TYPES = {"155", "156"}  # defensive, offensive
# Shot zones, in the order the site stores them.
ZONES = ["ra", "paint", "mid", "lc3", "rc3", "atb3"]
# Period stats kept per player per game (1st quarter, then 1st half), in this order.
PERIOD_COLS = ["q1pts", "q1reb", "q1ast", "q1fg3m", "h1pts", "h1reb", "h1ast", "h1fg3m"]


def clock_sec(text):
    """'11:26' -> 686, '45.2' -> 45.2 (ESPN shows tenths in the last minute)."""
    s = str(text or "").strip()
    if ":" in s:
        m, _, sec = s.partition(":")
        return int(m) * 60 + float(sec)
    try:
        return float(s)
    except ValueError:
        return 0.0


def elapsed(period, clock):
    """Seconds since tip-off at a play: four 12-minute quarters, then 5-minute overtimes."""
    if period <= 4:
        return round((period - 1) * 720 + 720 - clock)
    return round(2880 + (period - 5) * 300 + 300 - clock)


def coord(play):
    """Shot location in feet, hoop at (25, 0): x across the court 0-50, y out from the hoop.
    ESPN marks plays without a location with huge negative numbers."""
    c = play.get("coordinate") or {}
    x, y = c.get("x"), c.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or x < -100 or y < -100:
        return None, None
    return x, y


def shot_zone(x, y, value):
    """Zone for a field goal attempt worth `value` (2 or 3). Corner threes are below the break (y <= 9)."""
    if x is None or value not in (2, 3):
        return None
    if value == 3:
        if y <= 9:
            return "lc3" if x < 25 else "rc3"
        return "atb3"
    if ((x - 25) ** 2 + y ** 2) ** 0.5 <= 4:
        return "ra"
    if abs(x - 25) <= 8 and y <= 14:
        return "paint"
    return "mid"


def parse_pbp(summary, gid):
    """ESPN summary -> compact play-by-play.

    plays: shots as [period, clock, team, shooter, "s", made, value, x, y, assister] and rebounds as
    [period, clock, team, rebounder, "r"]; wp: thinned [seconds elapsed, home win %]; ss: season series line."""
    comps = dig(summary, "header", "competitions") or [{}]
    team_of = {str(dig(c, "team", "id")): team_abbr(c.get("team")) for c in comps[0].get("competitors", [])}
    rows, at = [], {}
    for p in summary.get("plays") or []:
        period = num(dig(p, "period", "number")) or 0
        clock = clock_sec(dig(p, "clock", "displayValue"))
        at[str(p.get("id"))] = elapsed(period, clock)
        ids = [str(dig(a, "athlete", "id") or "") for a in p.get("participants") or []]
        team = team_of.get(str(dig(p, "team", "id")))
        if p.get("shootingPlay") and ids and ids[0]:
            value = num(p.get("pointsAttempted"))
            if value is None:
                value = 1 if "free throw" in str(dig(p, "type", "text")).lower() else 2
            made = 1 if p.get("scoringPlay") else 0
            x, y = coord(p) if value > 1 else (None, None)
            rows.append([period, clock, team, ids[0], "s", made, value, x, y, ids[1] if made and len(ids) > 1 else ""])
        elif str(dig(p, "type", "id")) in REBOUND_TYPES and ids and ids[0]:
            rows.append([period, clock, team, ids[0], "r"])
    wp = [[at[str(w.get("playId"))], round(w["homeWinPercentage"], 3)] for w in summary.get("winprobability") or []
          if str(w.get("playId")) in at and isinstance(w.get("homeWinPercentage"), (int, float))]
    if len(wp) > 90:  # ~90 points is plenty for a small chart
        step = len(wp) / 90
        wp = [wp[int(i * step)] for i in range(90)] + [wp[-1]]
    series = next((s.get("summary") for s in summary.get("seasonseries") or [] if s.get("type") == "season"), None)
    return {"id": gid, "plays": rows, "wp": wp, "ss": series}


def period_stats(pbp, pids):
    """{player id: [q1 pts, reb, ast, 3pm, 1st-half pts, reb, ast, 3pm]} for one game; pids start at zeros."""
    out = {pid: [0] * len(PERIOD_COLS) for pid in pids}
    for r in pbp["plays"]:
        period = r[0]
        if period > 2:
            continue
        slots = (0, 4) if period == 1 else (4,)
        if r[4] == "r":
            if r[3] in out:
                for s in slots:
                    out[r[3]][s + 1] += 1
            continue
        _, _, _, shooter, _, made, value, *_rest = r
        assister = r[9]
        if made and shooter in out:
            for s in slots:
                out[shooter][s] += value
                if value == 3:
                    out[shooter][s + 3] += 1
        if made and assister in out:
            for s in slots:
                out[assister][s + 2] += 1
    return out


def first_basket(pbp):
    """[player id, team] of the first made field goal (how sportsbooks settle first basket)."""
    for r in pbp["plays"]:
        if r[4] == "s" and r[5] and r[6] >= 2:
            return [r[3], r[2]]
    return None


def build_pbp_data(store, games, boxes):
    """Period stats, shot zones (players and team defenses) and first baskets from the stored play-by-play.
    Also writes a small site/data/wp/<game id>.json (win probability, season series) per game."""
    periods, shots = defaultdict(dict), {"zones": ZONES, "league": {}, "players": {}, "def": {}}
    zi = {z: i for i, z in enumerate(ZONES)}
    blank = lambda: [0] * (2 * len(ZONES))  # noqa: E731  attempts, makes per zone
    league, players, defense = defaultdict(blank), defaultdict(lambda: defaultdict(blank)), defaultdict(lambda: defaultdict(blank))
    pgames, tgames = defaultdict(Counter), defaultdict(Counter)
    wp_dir = OUT_DIR / "wp"
    have = 0
    for g in games:
        box = boxes.get(g["id"])
        pbp = read_json(store / "pbp" / f"{g['id']}.json") if box else None
        if not pbp:
            continue
        have += 1
        season, team_of = str(g["s"]), {}
        for row in box["rows"]:
            team_of[row[0]] = row[1]
            pgames[row[0]][season] += 1
        for t in (g["h"], g["a"]):
            tgames[t][season] += 1
        for pid, vals in period_stats(pbp, list(team_of)).items():
            periods[pid][g["id"]] = vals
        for r in pbp["plays"]:
            if r[4] != "s":
                continue
            z = shot_zone(r[7], r[8], r[6])
            if z is None:
                continue
            i, made = 2 * zi[z], r[5]
            offense = r[2] or team_of.get(r[3])
            opp = g["a"] if offense == g["h"] else g["h"]
            for bucket in (league[season], players[r[3]][season], defense[opp][season]):
                bucket[i] += 1
                bucket[i + 1] += made
        fb = first_basket(pbp)
        if fb:
            g["fb"] = fb
        if pbp.get("wp") or pbp.get("ss"):
            write_json(wp_dir / f"{g['id']}.json", {"wp": pbp.get("wp") or [], "ss": pbp.get("ss")})
    shots["league"] = dict(league)
    shots["players"] = {pid: {s: v + [pgames[pid][s]] for s, v in by.items()} for pid, by in players.items()}
    # Team defense: shots allowed per zone per season + games, and a 1-30 rank per zone by points allowed
    # per game there (1 = allows the most, the best matchup for a shooter).
    for team, by in defense.items():
        shots["def"][team] = {s: v + [tgames[team][s]] for s, v in by.items()}
    for season in {s for by in defense.values() for s in by}:
        for k, z in enumerate(ZONES):
            value = 3 if z.endswith("3") else 2
            per_game = {t: by[season][2 * k + 1] * value / max(1, tgames[t][season])
                        for t, by in defense.items() if season in by}
            for rank, t in enumerate(sorted(per_game, key=lambda t: -per_game[t]), 1):
                shots["def"][t][season].append(rank)
    log(f"Play-by-play: {have} games")
    return periods, shots


def build_players(games, boxes):
    players, logs = {}, defaultdict(list)
    for g in games:  # oldest first, so the latest team / name wins
        box = boxes.get(g["id"])
        if not box:
            continue
        if "line" not in g and box.get("line"):
            g["line"] = box["line"]
        for row in box["rows"]:
            pid, team = row[0], row[1]
            name, short, pos, jersey = box["athletes"].get(pid, [None] * 4)
            p = players.setdefault(pid, {})
            p.update({k: v for k, v in (("n", name), ("s", short), ("p", pos), ("j", jersey)) if v})
            p["t"] = team
            logs[pid].append([g["id"]] + row[1:])
    return players, logs


# ---------------------------------------------------------------- injuries


def build_injuries(players, offline):
    if offline:
        return None
    try:
        data = fetch_json(f"{ESPN}/injuries")
    except Exception as e:
        log(f"Injuries: {e}")
        return None
    by_name = {}
    for pid, p in players.items():
        by_name.setdefault(name_key(p.get("n")), pid)
    nick = {t[1].lower(): abbr for abbr, t in TEAMS.items()}
    out = []
    for team in data.get("injuries", []):
        tname = str(team.get("displayName") or "")
        abbr = next((a for n, a in nick.items() if tname.lower().endswith(n)), None)
        for inj in team.get("injuries") or []:
            ath = inj.get("athlete") or {}
            pid = str(ath.get("id") or "")
            if not pid:
                href = " ".join(str(l.get("href", "")) for l in ath.get("links") or [])
                m = re.search(r"/id/(\d+)", href)
                pid = m.group(1) if m else by_name.get(name_key(ath.get("displayName")), "")
            detail = inj.get("shortComment") or dig(inj, "details", "type") or dig(inj, "type", "description") or ""
            out.append({"id": pid, "n": ath.get("displayName"), "t": abbr or team_abbr(ath.get("team")),
                        "st": inj.get("status") or dig(inj, "type", "description"),
                        "det": detail, "d": (inj.get("date") or "")[:10],
                        "loc": dig(inj, "details", "location"), "side": dig(inj, "details", "side"),
                        "ret": dig(inj, "details", "returnDate")})
    log(f"Injuries: {len(out)}")
    return out


# ---------------------------------------------------------------- props (The Odds API)


def parse_props(event_odds, roster_keys):
    """One event's odds -> [{id, n, s, l, o, u, bk, books}], DraftKings first, else the most common line."""
    stat_of = dict(MARKETS)
    offers = defaultdict(dict)  # (name, stat) -> book -> {l, o, u}
    for bk in event_odds.get("bookmakers") or []:
        for mk in bk.get("markets") or []:
            stat = stat_of.get(mk.get("key"))
            if not stat:
                continue
            for o in mk.get("outcomes") or []:
                name, side = o.get("description"), str(o.get("name", "")).lower()
                if not name or side not in ("over", "under") or o.get("point") is None:
                    continue
                offer = offers[(name, stat)].setdefault(bk["key"], {})
                offer["l"] = o["point"]
                offer["o" if side == "over" else "u"] = o.get("price")
    out = []
    for (name, stat), books in offers.items():
        if "draftkings" in books:
            book = "draftkings"
        else:
            common = Counter(b["l"] for b in books.values()).most_common(1)[0][0]
            book = next(k for k, b in sorted(books.items()) if b["l"] == common)
        main = books[book]
        out.append({"id": roster_keys.get(name_key(name), ""), "n": name, "s": stat, "l": main["l"],
                    "o": main.get("o"), "u": main.get("u"), "bk": book,
                    "books": {k: [b["l"], b.get("o"), b.get("u")] for k, b in sorted(books.items())}})
    return out


def plan_markets(remaining, n_events, today):
    """How many prop markets (and events) today's credits can cover.

    Each event costs 1 credit per market. The month's remaining credits (minus a reserve) are spread
    evenly over the days left, then markets are added in MARKETS order while they fit."""
    if remaining is None or n_events == 0:
        return 0, 0
    next_month = date(today.year + (today.month == 12), today.month % 12 + 1, 1)
    days_left = (next_month - today).days
    budget = int(max(0, remaining - CREDIT_RESERVE) / days_left)
    markets = min(len(MARKETS), budget // n_events)
    if markets:
        return markets, n_events
    return (1, budget) if budget else (0, 0)


def build_props(store, games, players, today, now_et, offline, key):
    props_dir = store / "odds" / "props"
    usage_path = store / "odds" / "usage.json"
    usage = read_json(usage_path, {})
    path = props_dir / f"{today.isoformat()}.json"
    snap = read_json(path)
    todays = [g for g in games if g["d"] == today.isoformat()]
    status = {"remaining": usage.get("remaining"), "used": usage.get("used"), "checked": usage.get("checked")}

    why = None
    if snap:
        why = "already pulled today"
    elif offline:
        why = "offline"
    elif not key:
        why = "no ODDS_API_KEY"
    elif not any(g["state"] == "pre" for g in todays):
        why = "no games left today"
    elif now_et.hour < PROPS_EARLIEST_HOUR:
        why = f"waiting until {PROPS_EARLIEST_HOUR}:00 ET"
    if why:
        log(f"Props: {why}")
        return snap, status

    def call(path_, params):
        hdr = {}
        q = urllib.parse.urlencode({**params, "apiKey": key})
        data = fetch_json(f"{ODDS}{path_}?{q}", tries=2, headers_out=hdr)
        if "x-requests-remaining" in hdr:
            usage.update(remaining=num(hdr["x-requests-remaining"]), used=num(hdr.get("x-requests-used")),
                         checked=datetime.now(timezone.utc).isoformat(timespec="seconds"))
        return data

    try:
        events = call("/events", {})  # free: doesn't use credits
    except Exception as e:
        log(f"Props: events failed ({e})")
        return None, status
    by_teams = {(g["h"], g["a"]): g for g in todays if g["state"] == "pre"}
    matched = []
    for ev in events:
        g = by_teams.get((FULL_NAME.get(ev.get("home_team")), FULL_NAME.get(ev.get("away_team"))))
        tip = datetime.fromisoformat(str(ev.get("commence_time", "")).replace("Z", "+00:00") or "1970-01-01T00:00+00:00")
        if g and tip.astimezone(ET).date() == today:
            matched.append((ev, g))
    n_markets, n_events = plan_markets(usage.get("remaining"), len(matched), today)
    markets = [m for m, _ in MARKETS[:n_markets]]
    log(f"Props: {len(matched)} games, credits left {usage.get('remaining')}, pulling {markets} for {n_events}")

    roster = {}
    for g in todays:
        for pid, p in players.items():
            if p.get("t") in (g["h"], g["a"]):
                roster[name_key(p.get("n"))] = pid
    snap = {"date": today.isoformat(), "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "markets": [s for m, s in MARKETS[:n_markets]], "games": {}}
    for ev, g in matched[:n_events]:
        try:
            odds = call(f"/events/{ev['id']}/odds", {"regions": "us", "markets": ",".join(markets),
                                                      "oddsFormat": "american"})
        except Exception as e:
            log(f"  {g['a']}@{g['h']}: {e}")
            continue
        snap["games"][g["id"]] = parse_props(odds, roster)
    write_json(usage_path, usage, pretty=True)
    if snap["games"]:
        write_json(path, snap)
    status.update(remaining=usage.get("remaining"), used=usage.get("used"), checked=usage.get("checked"))
    return snap, status


def build_proplines(store):
    """Every stored day's prop lines: player id -> game id -> stat -> line (for past games in logs)."""
    out = defaultdict(dict)
    for f in sorted((store / "odds" / "props").glob("*.json")):
        for gid, props in (read_json(f, {}).get("games") or {}).items():
            for p in props:
                if p.get("id"):
                    out[p["id"]].setdefault(gid, {})[p["s"]] = p["l"]
    return out


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--store", default=str(ROOT / "store"), help="cache folder (the data branch in CI)")
    ap.add_argument("--offline", action="store_true", help="build only from the store, no downloads")
    ap.add_argument("--no-odds", action="store_true", help="skip The Odds API")
    args = ap.parse_args()
    store = Path(args.store)
    now_et = datetime.now(ET)
    today = now_et.date()
    season = season_of(today)

    games = build_schedule(store, today, args.offline)
    boxes = build_boxes(store, games, args.offline)
    players, logs = build_players(games, boxes)
    log(f"Games: {len(games)}  players: {len(players)}  log rows: {sum(map(len, logs.values()))}")

    injuries = build_injuries(players, args.offline)
    if injuries is None:  # keep the last report rather than showing nobody hurt
        injuries = read_json(store / "injuries.json", [])
    elif not args.offline:
        write_json(store / "injuries.json", injuries, pretty=True)

    key = None if args.no_odds else os.environ.get("ODDS_API_KEY", "").strip() or None
    props, odds_status = build_props(store, games, players, today, now_et, args.offline, key)

    teams = {abbr: {"city": t[0], "name": t[1], "conf": t[2], "div": t[3], "color": t[4],
                    "logo": f"https://a.espncdn.com/i/teamlogos/nba/500/{t[5]}.png"}
             for abbr, t in TEAMS.items()}
    meta = {"built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "today": today.isoformat(),
            "season": season, "label": f"{season - 1}-{str(season)[2:]}", "cols": COLS,
            "odds": {**odds_status, "markets": (props or {}).get("markets", []),
                     "fetched": (props or {}).get("fetched")}}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_json(OUT_DIR / "meta.json", meta)
    write_json(OUT_DIR / "teams.json", teams)
    periods, shots = build_pbp_data(store, games, boxes)  # also adds first baskets (g["fb"]) to games
    write_json(OUT_DIR / "periods.json", {"cols": PERIOD_COLS, "games": periods})
    write_json(OUT_DIR / "shots.json", shots)
    write_json(OUT_DIR / "games.json", games)
    write_json(OUT_DIR / "players.json", players)
    write_json(OUT_DIR / "logs.json", logs)
    write_json(OUT_DIR / "props.json", props or {"date": today.isoformat(), "games": {}})
    write_json(OUT_DIR / "proplines.json", build_proplines(store))
    write_json(OUT_DIR / "injuries.json", injuries)
    log(f"Wrote {OUT_DIR}")
    if not games:
        sys.exit("No games found: ESPN may be unreachable")


if __name__ == "__main__":
    main()
