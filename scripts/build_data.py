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
    box_dir = store / "box"
    todo = [g for g in games if g["state"] == "post" and not (box_dir / f"{g['id']}.json").exists()]
    if offline:
        todo = []

    def get(g):
        try:
            data = fetch_json(f"{ESPN}/summary?event={g['id']}")
        except Exception as e:
            log(f"  summary {g['id']}: {e}")
            return g, None
        if not (store / "samples" / "summary.json").exists():
            write_json(store / "samples" / "summary.json", data, pretty=True)
        return g, parse_box(data, g["id"])

    log(f"Box scores: fetching {len(todo)}")
    done = 0
    with ThreadPoolExecutor(8) as pool:
        for g, box in pool.map(get, todo):
            # A summary right after the buzzer can come back without player stats; try again next run.
            if box and box["rows"]:
                write_json(box_dir / f"{g['id']}.json", box)
                done += 1
    log(f"  saved {done}")
    return {g["id"]: read_json(box_dir / f"{g['id']}.json") for g in games if g["state"] == "post"}


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
