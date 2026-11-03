"""ESPN's public NFL site API for NFL Lab, the same source Hoop Lab uses for the NBA: weekly scoreboards (games,
scores, live state, records, DraftKings lines), game summaries (box scores with team totals, the closing line in
`pickcenter`) and the league injury report. Finished weeks and box scores are cached in the data store
(store/nfl/espn/), so each run only asks ESPN for what changed.

Parsing is pure and unit tested in tests/test_build_nfl.py against trimmed copies of real responses."""
import datetime as dt
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
ET = ZoneInfo("America/New_York")
# ESPN abbreviations -> ours (nflverse / Mingus Football style, so game ids and logos line up).
ALIASES = {"WSH": "WAS", "LAR": "LA"}
# ESPN postseason weeks -> nflverse week numbers (4 is the Pro Bowl, skipped).
POST_WEEKS = {1: 19, 2: 20, 3: 21, 5: 22}


def get(url, tries=3):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Mingus Lab data job)", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ConnectionError) as e:
            last = e
        time.sleep(2 * (attempt + 1))
    raise last


def dig(obj, *path):
    for p in path:
        if obj is None:
            return None
        obj = obj[p] if isinstance(obj, list) and isinstance(p, int) and len(obj) > p else obj.get(p) if isinstance(obj, dict) else None
    return obj


def num(v):
    try:
        return float(str(v).replace(",", "")) if v not in (None, "", "-", "--") else None
    except ValueError:
        return None


def inum(v):
    n = num(v)
    return int(n) if n is not None else None


def abbr(team):
    a = str((team or {}).get("abbreviation") or "").upper()
    return ALIASES.get(a, a) or None


def pair(v, sep):
    """'24/31' or '2-11' -> (24, 31)."""
    parts = str(v or "").split(sep)
    return (inum(parts[0]), inum(parts[1])) if len(parts) == 2 else (None, None)


def to_et(iso):
    t = dt.datetime.strptime(iso.replace("Z", ""), "%Y-%m-%dT%H:%M" if len(iso.replace("Z", "")) == 16 else "%Y-%m-%dT%H:%M:%S")
    return t.replace(tzinfo=dt.timezone.utc).astimezone(ET)


def game_id(season, week, away, home):
    return f"{season}_{week:02d}_{away}_{home}"


def side_odds(o, *path):
    """A price from ESPN's newer odds format (moneyline / pointSpread / total -> close / current / open -> odds),
    preferring the latest number. Same as the NBA build."""
    for when in ("close", "current", "open"):
        raw = dig(o, *path, when, "odds")
        v = inum(str(raw).upper().replace("EVEN", "100")) if raw is not None else None
        if v is not None:
            return v
    return None


def first(*vals):
    return next((v for v in vals if v is not None), None)


def parse_line(odds_list, home, away):
    """ESPN odds (scoreboard `odds` or summary `pickcenter`) -> our line fields: home_spread (the home team's number),
    total, money lines and prices, book."""
    o = (odds_list or [None])[0]
    if not o:
        return {}
    line = {}
    details = str(o.get("details") or "").strip()
    m = re.match(r"^([A-Za-z]+)\s+([-+]?\d+(?:\.\d+)?)$", details)
    if m:
        fav, val = ALIASES.get(m.group(1).upper(), m.group(1).upper()), float(m.group(2))
        if fav in (home, away):
            line["home_spread"] = val if fav == home else -val
    elif details.upper() in ("EVEN", "PK", "PICK"):
        line["home_spread"] = 0.0
    if "home_spread" not in line and o.get("spread") is not None:
        line["home_spread"] = num(o.get("spread"))
    line["total"] = first(num(o.get("overUnder")), num(str(dig(o, "total", "over", "close", "line") or "").lstrip("ou")))
    line["home_ml"] = first(inum(dig(o, "homeTeamOdds", "moneyLine")), side_odds(o, "moneyline", "home"))
    line["away_ml"] = first(inum(dig(o, "awayTeamOdds", "moneyLine")), side_odds(o, "moneyline", "away"))
    line["home_spread_odds"] = first(inum(dig(o, "homeTeamOdds", "spreadOdds")), side_odds(o, "pointSpread", "home"))
    line["away_spread_odds"] = first(inum(dig(o, "awayTeamOdds", "spreadOdds")), side_odds(o, "pointSpread", "away"))
    line["over_odds"] = first(inum(o.get("overOdds")), side_odds(o, "total", "over"))
    line["under_odds"] = first(inum(o.get("underOdds")), side_odds(o, "total", "under"))
    line["book"] = dig(o, "provider", "name")
    return {k: v for k, v in line.items() if v is not None}


def parse_event(ev):
    """One scoreboard event -> our game dict (None for exhibitions / Pro Bowl)."""
    comp = (ev.get("competitions") or [{}])[0]
    sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
    home, away = sides.get("home"), sides.get("away")
    stype = dig(ev, "season", "type")
    week = dig(ev, "week", "number")
    if not home or not away or stype not in (2, 3) or week is None:
        return None
    if stype == 3:
        week = POST_WEEKS.get(week)
        if week is None:
            return None
    h, a = abbr(home.get("team")), abbr(away.get("team"))
    season = dig(ev, "season", "year")
    kick = to_et(ev["date"])
    status = comp.get("status") or ev.get("status") or {}
    state = dig(status, "type", "state") or "pre"
    g = {
        "id": game_id(season, week, a, h), "eid": str(ev["id"]), "season": season, "week": week,
        "type": "REG" if stype == 2 else "POST", "date": kick.strftime("%Y-%m-%d"), "time": kick.strftime("%H:%M"),
        "away": a, "home": h, "state": state, "detail": dig(status, "type", "shortDetail"),
        "away_score": inum(away.get("score")) if state != "pre" else None,
        "home_score": inum(home.get("score")) if state != "pre" else None,
        "stadium": dig(comp, "venue", "fullName"), "roof": "dome" if dig(comp, "venue", "indoor") else None,
    }
    if state != "post":   # a live score isn't final: the pages treat home_score != null as final
        g["live"] = {"away": g.pop("away_score"), "home": g.pop("home_score")} if state == "in" else None
        g["away_score"] = g["home_score"] = None
    for key, side in (("away", away), ("home", home)):
        rec = next((r.get("summary") for r in side.get("records") or [] if r.get("type") == "total" or r.get("name") == "overall"), None)
        if rec:
            g[f"{key}_rec"] = rec
    g.update(parse_line(comp.get("odds"), h, a))
    return g


def team_totals(t):
    """A box score team's statistics list -> our team totals."""
    s = {x.get("name"): x.get("displayValue") for x in t.get("statistics", [])}
    cmp_, att = pair(s.get("completionAttempts"), "/")
    sk, _ = pair(s.get("sacksYardsLost"), "-")
    td_m, td_a = pair(s.get("thirdDownEff"), "-")
    rz_m, rz_a = pair(s.get("redZoneAttempts"), "-")
    return {
        "cmp": cmp_, "att": att, "pass_yds": inum(s.get("netPassingYards")), "sk": sk, "car": inum(s.get("rushingAttempts")),
        "rush_yds": inum(s.get("rushingYards")), "fd": inum(s.get("firstDowns")), "int": inum(s.get("interceptions")),
        "fl": inum(s.get("fumblesLost")), "yds": inum(s.get("totalYards")), "plays": inum(s.get("totalOffensivePlays")),
        "third": [td_m, td_a], "rz": [rz_m, rz_a],
    }


# Box score categories -> {label: our column}.
CATS = {
    "passing": {"C/ATT": ("cmp", "att"), "YDS": "pass_yds", "TD": "pass_td", "INT": "int"},
    "rushing": {"CAR": "car", "YDS": "rush_yds", "TD": "rush_td"},
    "receiving": {"REC": "rec", "YDS": "rec_yds", "TD": "rec_td", "TGTS": "tgt"},
}


def parse_box(summary):
    """Game summary -> {teams: {abbr: totals}, players: {espn id: {team, n, img, ...stats}}, line}."""
    box = summary.get("boxscore") or {}
    out = {"teams": {}, "players": {}}
    for t in box.get("teams", []):
        out["teams"][abbr(t.get("team"))] = team_totals(t)
    for side in box.get("players", []):
        team = abbr(side.get("team"))
        for cat in side.get("statistics", []):
            cols = CATS.get(cat.get("name"))
            if not cols:
                continue
            labels = cat.get("labels") or []
            for a in cat.get("athletes", []):
                ath = a.get("athlete") or {}
                pid = str(ath.get("id") or "")
                if not pid:
                    continue
                row = out["players"].setdefault(pid, {"team": team, "n": ath.get("displayName"), "img": dig(ath, "headshot", "href")})
                for label, val in zip(labels, a.get("stats") or []):
                    col = cols.get(label)
                    if isinstance(col, tuple):
                        x, y = pair(val, "/")
                        row[col[0]], row[col[1]] = x or 0, y or 0
                    elif col:
                        row[col] = inum(val) or 0
    header = dig(summary, "header", "competitions", 0) or {}
    sides = {c.get("homeAway"): abbr(c.get("team")) for c in header.get("competitors", [])}
    out["line"] = parse_line(summary.get("pickcenter"), sides.get("home"), sides.get("away"))
    return out


def parse_injuries(doc):
    """League injury report -> {espn id: {st, det, ret}}. 'Active' entries are skipped."""
    out = {}
    for team in doc.get("injuries", []):
        for i in team.get("injuries", []):
            if i.get("status") in (None, "Active"):
                continue
            href = next((l.get("href") for l in dig(i, "athlete", "links") or [] if "/id/" in (l.get("href") or "")), "")
            m = re.search(r"/id/(\d+)", href)
            if not m:
                continue
            st = {"Injured Reserve": "IR"}.get(i["status"], i["status"])
            out[m.group(1)] = {"st": st, "det": dig(i, "details", "type") or "", "ret": dig(i, "details", "returnDate"),
                               "note": i.get("shortComment") or ""}
    return out


CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
DRAFTKINGS = "100"   # ESPN's provider id for DraftKings
# ESPN prop bet types (main over / under lines) -> our stats. Milestones, quarter and TD-scorer markets are skipped.
PROP_TYPES = {
    "Total Passing Yards": "pass_yds", "Total Pass Completions": "cmp", "Total Passing Attempts": "att",
    "Total Passing Touchdowns": "pass_td", "Total Passing Interceptions": "int", "Total Rushing Yards": "rush_yds",
    "Total Carries": "car", "Total Receiving Yards": "rec_yds", "Total Receptions": "rec",
    "Total Rushing Plus Receiving Yards": "rush_rec_yds", "Total Passing Plus Rushing Yards": "pass_rush_yds",
}


def parse_propbets(doc):
    """ESPN's DraftKings player props for one game -> [{eid, stat, line, open, at}]. Lines only: ESPN gives no prices."""
    out = []
    for i in doc.get("items", []):
        name = re.sub(r"\s*\(incl\. overtime\)\s*$", "", dig(i, "type", "name") or "")
        stat = PROP_TYPES.get(name)
        m = re.search(r"/athletes/(\d+)", dig(i, "athlete", "$ref") or "")
        line = num(dig(i, "current", "target", "value"))
        if not stat or not m or line is None:
            continue
        out.append({"eid": m.group(1), "stat": stat, "line": line, "open": num(dig(i, "open", "target", "value")), "at": i.get("lastUpdated")})
    return out


# ---------------------------------------------------------------- fetching with the store cache

def fetch_season(season, cache, refresh_weeks=2, get=get):
    """Every game of a season from the weekly scoreboards. Weeks whose games are all final are cached; the current
    and next `refresh_weeks` weeks are fetched every run."""
    folder = Path(cache) / "weeks"
    folder.mkdir(parents=True, exist_ok=True)
    games, fetched = [], 0
    weeks = [(2, w) for w in range(1, 19)] + [(3, w) for w in (1, 2, 3, 5)]
    pending = 0
    for stype, w in weeks:
        f = folder / f"{season}-{stype}-{w:02d}.json"
        evs = None
        if f.exists():
            evs = json.loads(f.read_text())
            if any(e.get("state") != "post" for e in evs):
                evs = None   # not finished when cached: refresh
        if evs is None:
            if pending > refresh_weeks:
                continue      # far-future weeks: no need every run (they'd still have no scores)
            try:
                doc = get(f"{API}/scoreboard?dates={season}&seasontype={stype}&week={w}")
                fetched += 1
            except Exception:
                continue
            evs = [g for g in (parse_event(e) for e in doc.get("events", [])) if g]
            if evs:
                f.write_text(json.dumps(evs, separators=(",", ":")))
            if any(g["state"] != "post" for g in evs):
                pending += 1
        games += evs
    return games, fetched


def fetch_boxes(games, cache, limit=250, get=get):
    """Box scores for final games, cached by ESPN event id. At most `limit` new ones a run (the first run back-fills
    two seasons over a few runs)."""
    folder = Path(cache) / "box"
    folder.mkdir(parents=True, exist_ok=True)
    boxes, new = {}, 0
    for g in games:
        if g.get("home_score") is None:
            continue
        f = folder / f"{g['eid']}.json"
        if f.exists():
            boxes[g["id"]] = json.loads(f.read_text())
            continue
        if new >= limit:
            continue
        try:
            b = parse_box(get(f"{API}/summary?event={g['eid']}"))
        except Exception:
            continue
        new += 1
        f.write_text(json.dumps(b, separators=(",", ":")))
        boxes[g["id"]] = b
    return boxes, new


def fetch_props(games, cache, today, days=8, get=get):
    """DraftKings prop lines for games that haven't started and kick off within `days`, refreshed every run into
    store/nfl/espn/props/<event>.json. Once a game starts the file is left alone, so it holds the last pregame
    (closing) line. Returns {game id: rows} for every game with a file."""
    folder = Path(cache) / "props"
    folder.mkdir(parents=True, exist_ok=True)
    out, calls = {}, 0
    horizon = (today + dt.timedelta(days=days)).isoformat()
    for g in games:
        f = folder / f"{g['eid']}.json"
        if g["state"] == "pre" and today.isoformat() <= g["date"] <= horizon:
            try:
                rows = parse_propbets(get(f"{CORE}/events/{g['eid']}/competitions/{g['eid']}/odds/{DRAFTKINGS}/propBets?limit=1000"))
                calls += 1
                if rows:
                    f.write_text(json.dumps(rows, separators=(",", ":")))
            except Exception:
                pass
        if f.exists():
            out[g["id"]] = json.loads(f.read_text())
    return out, calls


def fetch_injuries(get=get):
    try:
        return parse_injuries(get(f"{API}/injuries"))
    except Exception:
        return {}
