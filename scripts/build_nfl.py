#!/usr/bin/env python3
"""NFL Lab data: build site/data/nfl/ for the NFL side of Mingus Lab.

Sources (all public, no Odds API credits):
- ESPN's NFL site API (scripts/nfl_espn.py) for this season: games, final and live scores, records, DraftKings lines
  (line history kept in the store), box scores (player logs, team totals with third down and red zone) and the injury
  report. ESPN athletes are matched to nflverse ids through the rosters' `espn_id`.
- nflverse (github.com/nflverse/nflverse-data releases): schedules with lines and scores, team and player weekly
  stats, weekly rosters (reserve / IR status) and injury reports. It covers last season and is the fallback for any
  game, box score or injury report ESPN doesn't give us this season.
- Mingus Football (github.com/joshwilliams332/mingus): team logos and colors from its site data, and from its `data`
  branch its projections (`model/projections/<season>-wNN.json`).
- Mingus Picks (github.com/joshwilliams332/mingus-picks), which does every NFL Odds API pull: from its `data` branch the
  sportsbook props (`odds/props/<game>.json`) and the locked model picks (`picks/`). NFL Lab never calls the Odds API.
  The workflow checks all three out (sparse) and passes the folders in; until a folder exists in mingus-picks the
  old copy on mingus's `data` branch is read instead.

Files written:
    meta.json       season, current week, seasons loaded, when built
    games.json      both seasons' games: scores, spread / total / money lines (with prices), weather
    teams.json      city, nickname, color, logo
    teamstats.json  team -> weekly box totals (both seasons)
    players.json    player id -> name, position, team, headshot, roster / injury status
    logs.json       {cols, logs: player id -> [[season, week, team, opp, ...cols]]}
    props.json      {games: game id -> prop rows, pulled: game id -> time}
    proj.json       game id -> player id -> stat -> {mean, sd, p_over, line}
    picks.json      Mingus Picks' locked model picks by slate + its official records

Usage:
    python3 scripts/build_nfl.py --mingus mingus --mingus-data mingus-data
    python3 scripts/build_nfl.py --mingus ... --mingus-data ... --cache store/nflverse   # reuse downloads
"""
import argparse
import csv
import datetime as dt
import io
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nfl_espn  # noqa: E402

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "nfl"
POSITIONS = {"QB", "RB", "WR", "TE", "FB"}
# Player log columns: our name -> nflverse stats_player_week column.
LOG_COLS = [
    ("cmp", "completions"), ("att", "attempts"), ("pass_yds", "passing_yards"), ("pass_td", "passing_tds"),
    ("int", "passing_interceptions"), ("car", "carries"), ("rush_yds", "rushing_yards"), ("rush_td", "rushing_tds"),
    ("tgt", "targets"), ("rec", "receptions"), ("rec_yds", "receiving_yards"), ("rec_td", "receiving_tds"),
    ("tgt_sh", "target_share"), ("ay_sh", "air_yards_share"),
]
SHARE = {"tgt_sh", "ay_sh"}
# Mingus Football prop stat names -> ours (they already match; kept as a map so a rename is a one-line fix).
PROP_STATS = {"pass_yds": "pass_yds", "rush_yds": "rush_yds", "rec_yds": "rec_yds", "rec": "rec", "receptions": "rec"}


def season_now(today=None):
    today = today or dt.date.today()
    return today.year if today.month >= 8 else today.year - 1


def num(v, cast=float):
    try:
        return cast(v) if v not in ("", "NA", None) else None
    except ValueError:
        try:
            return cast(float(v))
        except ValueError:
            return None


def fetch_csv(path, cache=None):
    """An nflverse release CSV as a list of dicts (cached on disk when `cache` is given)."""
    cached = Path(cache) / path.replace("/", "__") if cache else None
    if cached and cached.exists() and (dt.datetime.now().timestamp() - cached.stat().st_mtime) < 3 * 3600:
        text = cached.read_text()
    else:
        req = urllib.request.Request(f"{NFLVERSE}/{path}", headers={"User-Agent": "mingus-lab-build"})
        with urllib.request.urlopen(req, timeout=120) as r:
            text = r.read().decode("utf-8")
        if cached:
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_text(text)
    return list(csv.DictReader(io.StringIO(text)))


def build_games(rows, seasons):
    out = []
    for r in rows:
        s = num(r["season"], int)
        if s not in seasons or r["game_type"] not in ("REG", "WC", "DIV", "CON", "SB"):
            continue
        spread = num(r["spread_line"])      # nflverse: positive = home favored
        total = num(r["total_line"])
        home_spread = -spread if spread is not None else None
        implied = (None, None)
        if spread is not None and total is not None:
            implied = (round(total / 2 + spread / 2, 1), round(total / 2 - spread / 2, 1))
        out.append({
            "id": r["game_id"], "season": s, "week": num(r["week"], int), "type": "REG" if r["game_type"] == "REG" else "POST",
            "date": r["gameday"], "time": r["gametime"] or "13:00", "away": r["away_team"], "home": r["home_team"],
            "away_score": num(r["away_score"], int), "home_score": num(r["home_score"], int),
            "home_spread": home_spread, "total": total, "away_ml": num(r["away_moneyline"], int), "home_ml": num(r["home_moneyline"], int),
            "home_spread_odds": num(r["home_spread_odds"], int), "away_spread_odds": num(r["away_spread_odds"], int),
            "over_odds": num(r["over_odds"], int), "under_odds": num(r["under_odds"], int),
            "home_implied": implied[0], "away_implied": implied[1],
            "stadium": r["stadium"], "roof": r["roof"], "temp": num(r["temp"], int), "wind": num(r["wind"], int),
            "div": r["div_game"] == "1",
        })
    out.sort(key=lambda g: (g["date"], g["time"]))
    return out


def build_teamstats(rows):
    out = {}
    for r in rows:
        if r["season_type"] != "REG" and r["season_type"] != "POST":
            continue
        fd = sum(num(r[c], int) or 0 for c in ("passing_first_downs", "rushing_first_downs"))
        fl = sum(num(r[c], int) or 0 for c in ("sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"))
        out.setdefault(r["team"], []).append({
            "season": num(r["season"], int), "week": num(r["week"], int), "opp": r["opponent_team"],
            "cmp": num(r["completions"], int) or 0, "att": num(r["attempts"], int) or 0, "pass_yds": num(r["passing_yards"], int) or 0,
            "sk": num(r["sacks_suffered"], int) or 0, "car": num(r["carries"], int) or 0, "rush_yds": num(r["rushing_yards"], int) or 0,
            "fd": fd, "int": num(r["passing_interceptions"], int) or 0, "fl": fl,
        })
    for rows_ in out.values():
        rows_.sort(key=lambda x: (x["season"], x["week"]))
    return out


def build_logs(rows):
    players, logs = {}, {}
    for r in sorted(rows, key=lambda x: (num(x["season"], int), num(x["week"], int))):
        if r["position"] not in POSITIONS or r["season_type"] not in ("REG", "POST"):
            continue
        vals = []
        for ours, col in LOG_COLS:
            v = num(r[col])
            vals.append(None if v is None else round(v, 3) if ours in SHARE else int(v))
        if not any(v for v in vals):
            continue
        pid = r["player_id"]
        logs.setdefault(pid, []).append([num(r["season"], int), num(r["week"], int), r["team"], r["opponent_team"]] + vals)
        players[pid] = {"n": r["player_display_name"], "pos": r["position"], "t": r["team"], "img": r["headshot_url"] or None}
    return players, {"cols": [c for c, _ in LOG_COLS], "logs": logs}


# Roster statuses that mean the player left that team. A traded or re-signed player has a second row that week for his
# new team, and that row wins (Nov 9, 2026: Jacoby Brissett, traded ARI -> BAL, showed "Released" with ARI).
GONE = {"CUT", "UFA", "RET", "NON", "TRD", "TRC"}
FLAGGED = {"RES": "IR", "INA": "Inactive", "CUT": "Released", "RET": "Retired", "SUS": "Suspended", "EXE": "EXE", "NON": "NON",
           "UFA": "UFA"}


def apply_status(players, roster_rows, injury_rows, season=0):
    """Latest weekly roster status (RES = reserve / IR, PUP...) and injury report status for each player. The roster's
    team is kept in `_rt` (season, week) so a box score from an older week can't move a traded player back."""
    if roster_rows:
        last = max(num(r["week"], int) or 0 for r in roster_rows)
        best = {}
        for r in roster_rows:
            if num(r["week"], int) != last or r["gsis_id"] not in players:
                continue
            had = best.get(r["gsis_id"])
            if had is None or (had["status"] in GONE and r["status"] not in GONE):
                best[r["gsis_id"]] = r
        for pid, r in best.items():
            p = players[pid]
            p["t"] = r["team"] or p["t"]
            p["_rt"] = (num(r.get("season"), int) or season, last)
            p.pop("st", None)
            p.pop("det", None)
            if r["status"] in FLAGGED:
                p["st"] = FLAGGED[r["status"]]
                p["det"] = r.get("status_description_abbr") or ""
    if injury_rows:
        last = max(num(r["week"], int) or 0 for r in injury_rows)
        for r in injury_rows:
            if num(r["week"], int) != last or r["gsis_id"] not in players or players[r["gsis_id"]].get("st") == "IR":
                continue
            status = r["report_status"]
            if status:
                p = players[r["gsis_id"]]
                p["st"] = status
                p["det"] = ", ".join(x for x in (r["report_primary_injury"], r["report_secondary_injury"]) if x)
                p["wk"] = last
    return players


def build_props(data_dir):
    out, pulled = {}, {}
    folder = Path(data_dir) / "odds" / "props" if data_dir else None
    if not folder or not folder.exists():
        return {"games": out, "pulled": pulled}
    for f in sorted(folder.glob("*.json")):
        try:
            snap = json.loads(f.read_text())
        except ValueError:
            continue
        gid = snap.get("game") or f.stem
        rows = []
        for r in snap.get("rows", []):
            stat = PROP_STATS.get(r.get("stat"))
            if not stat or r.get("line") is None:
                continue
            rows.append({k: r.get(k) for k in ("pid", "name", "team", "pos", "line", "over", "under", "book_o", "book_u", "fair_o", "fair_u", "books")} | {"stat": stat})
        if rows:
            out[gid] = rows
            pulled[gid] = snap.get("pulled")
    return {"games": out, "pulled": pulled}


def build_proj(data_dir):
    out = {}
    folder = Path(data_dir) / "model" / "projections" if data_dir else None
    if not folder or not folder.exists():
        return out
    for f in sorted(folder.glob("*.json")):
        try:
            doc = json.loads(f.read_text())
        except ValueError:
            continue
        for gid, game in (doc.get("games") or {}).items():
            for r in game.get("rows", []):
                stat = PROP_STATS.get(r.get("st"))
                if stat and r.get("pid") and r.get("mean") is not None:
                    out.setdefault(gid, {}).setdefault(r["pid"], {})[stat] = {
                        "mean": r["mean"], "sd": r.get("sd"), "p_over": r.get("p_over"), "line": r.get("line")}
    return out


PICK_FIELDS = ("id", "gid", "week", "pid", "name", "team", "opp", "pos", "stat", "side", "line", "price", "book", "prob", "proj", "why")
SLATES = {"night": "Night game", "early": "Sunday 1 PM", "late": "Sunday 4 PM"}


def build_picks(data_dir):
    """Mingus Picks' locked model picks (night games and the Sunday slates), test nights left out, plus its
    official records. Graded in the browser from the same nflverse stats as saved picks."""
    root = Path(data_dir) / "picks" if data_dir else None
    out = {"history": [], "records": {}}
    if not root or not root.exists():
        return out
    files = [(f, None) for f in root.glob("[0-9]*.json")] + [(f, sub) for sub in ("sun-early", "sun-late") for f in (root / sub).glob("[0-9]*.json")]
    for f, sub in files:
        if not f.stem.count("-") == 2:            # 2026-11-01.json only (skip -results, -quick, -check)
            continue
        try:
            doc = json.loads(f.read_text())
        except ValueError:
            continue
        if doc.get("test") or not doc.get("picks"):
            continue
        slate = doc.get("slate") or ("early" if sub == "sun-early" else "late" if sub == "sun-late" else "night")
        picks = [{k: p.get(k) for k in PICK_FIELDS} | {"sport": "nfl"} for p in doc["picks"] if PROP_STATS.get(p.get("stat"))]
        for p in picks:
            p["stat"] = PROP_STATS[p["stat"]]
        out["history"].append({"date": doc.get("date") or f.stem, "slate": slate, "label": SLATES.get(slate, slate),
                               "week": doc.get("week"), "picks": picks})
    out["history"].sort(key=lambda d: (d["date"], ["early", "late", "night"].index(d["slate"]) if d["slate"] in ("early", "late", "night") else 9), reverse=True)
    for name, file in (("night", "record.json"), ("sunday", "sunday-record.json")):
        try:
            out["records"][name] = json.loads((root / file).read_text()).get("season")
        except (OSError, ValueError):
            pass
    return out


# ---------------------------------------------------------------- ESPN on top of nflverse (this season)

LINE_KEYS = ("home_spread", "total", "home_ml", "away_ml", "home_spread_odds", "away_spread_odds", "over_odds", "under_odds", "book")


def set_implied(g):
    if g.get("home_spread") is not None and g.get("total") is not None:
        g["home_implied"] = round(g["total"] / 2 - g["home_spread"] / 2, 1)
        g["away_implied"] = round(g["total"] / 2 + g["home_spread"] / 2, 1)
    return g


def merge_games(games, espn_games, boxes, history, now):
    """ESPN's games replace nflverse's for the same id (scores, state, records, DraftKings lines); nflverse keeps the
    weather and division flag and covers anything ESPN didn't return. `history` (gid -> [[time, spread, total]]) gets
    a new entry whenever a pregame line changes; games carry `open` (first line seen) and `lh`."""
    by_id = {g["id"]: g for g in games}
    for e in espn_games:
        g = by_id.get(e["id"])
        if g is None:
            g = by_id[e["id"]] = {"div": False}
        line = {k: e[k] for k in LINE_KEYS if k in e}
        if "home_spread" not in line and "total" not in line:
            line = (boxes.get(e["id"]) or {}).get("line") or {}
        if line:
            for k in LINE_KEYS:
                g.pop(k, None)
            g.update(line)
        g.update({k: v for k, v in e.items() if k not in LINE_KEYS and (v is not None or k not in g)})
        g["src"] = "espn"
        if e["state"] == "pre" and (g.get("home_spread") is not None or g.get("total") is not None):
            h = history.setdefault(e["id"], [])
            point = [g.get("home_spread"), g.get("total")]
            if not h or h[-1][1:] != point:
                h.append([now] + point)
        if history.get(e["id"]):
            h = history[e["id"]]
            g["open"] = {"home_spread": h[0][1], "total": h[0][2], "at": h[0][0]}
            g["lh"] = h
        set_implied(g)
    out = list(by_id.values())
    out.sort(key=lambda g: (g["date"], g["time"]))
    return out


def espn_ids(roster_rows):
    """ESPN athlete id -> (gsis id, position, name) from nflverse rosters (latest week wins)."""
    out = {}
    for r in sorted(roster_rows, key=lambda r: num(r.get("week"), int) or 0):
        if r.get("espn_id") and r.get("gsis_id"):
            out[str(num(r["espn_id"], int) or r["espn_id"])] = (r["gsis_id"], r.get("position"), r.get("full_name"))
    return out


def merge_boxes(games, boxes, players, logs, teamstats, ids):
    """ESPN box scores replace nflverse's rows for the same player-week (and team-week). Target share comes from the
    team's targets in that game; air-yard share isn't in the box score, so nflverse's is kept when it has one."""
    cols = logs["cols"]
    at = {c: i + 4 for i, c in enumerate(cols)}
    unmatched = set()
    by_id = {g["id"]: g for g in games}
    for gid, box in boxes.items():
        g = by_id.get(gid)
        if not g:
            continue
        season, week = g["season"], g["week"]
        opp = {g["home"]: g["away"], g["away"]: g["home"]}
        tgts = {}
        for row in box["players"].values():
            tgts[row["team"]] = tgts.get(row["team"], 0) + row.get("tgt", 0)
        for eid, row in box["players"].items():
            match = ids.get(eid)
            if not match:
                if any(row.get(k) for k in ("att", "car", "tgt", "rec")):
                    unmatched.add(eid)
                continue
            pid, pos, name = match
            if pos not in POSITIONS:
                continue
            vals = [row.get(c, 0) for c in cols]
            vals[cols.index("tgt_sh")] = round(row.get("tgt", 0) / tgts[row["team"]], 3) if tgts.get(row["team"]) else None
            mine = logs["logs"].setdefault(pid, [])
            old = next((r for r in mine if r[0] == season and r[1] == week), None)
            vals[cols.index("ay_sh")] = old[at["ay_sh"]] if old else None
            if not any(v for v in vals):
                continue
            new = [season, week, row["team"], opp.get(row["team"])] + vals
            if old:
                mine[mine.index(old)] = new
            else:
                mine.append(new)
                mine.sort(key=lambda r: (r[0], r[1]))
            p = players.setdefault(pid, {"n": row.get("n") or name, "pos": pos, "t": row["team"], "img": None})
            p["img"] = p.get("img") or row.get("img")
            if (season, week) >= max((r[0], r[1]) for r in mine) and (season, week) > p.get("_rt", (0, 0)):
                p["t"] = row["team"]
        for team, tot in box["teams"].items():
            rows = teamstats.setdefault(team, [])
            rows[:] = [r for r in rows if (r["season"], r["week"]) != (season, week)]
            rows.append({"season": season, "week": week, "opp": opp.get(team)} | {k: (v if v is not None else 0) if not isinstance(v, list) else v for k, v in tot.items()})
            rows.sort(key=lambda r: (r["season"], r["week"]))
    return len(unmatched)


def apply_espn_injuries(players, injuries, ids):
    """ESPN's current injury report (Out / Doubtful / Questionable / IR ...) for matched players, replacing nflverse's
    weekly report. A reserve status from the roster stays unless ESPN lists him."""
    n = 0
    for eid, i in injuries.items():
        match = ids.get(eid)
        if not match or match[0] not in players:
            continue
        p = players[match[0]]
        p["st"], p["det"] = i["st"], i["det"]
        if i.get("note"):
            p["note"] = i["note"]
        if i.get("ret"):
            p["ret"] = i["ret"]
        n += 1
    return n


def merge_props(props, espn_props, ids, players):
    """ESPN's DraftKings lines (no prices) fill in every player / stat Mingus Picks didn't pull; rows it did pull keep
    their prices and get the DraftKings open when the line matches. Every ESPN-sourced row is marked `src: 'espn'`."""
    added = 0
    for gid, rows in espn_props.items():
        mine = props["games"].setdefault(gid, [])
        have = {(r["pid"], r["stat"]): r for r in mine}
        for r in rows:
            match = ids.get(r["eid"])
            if not match:
                continue
            pid = match[0]
            if (pid, r["stat"]) in have:
                row = have[(pid, r["stat"])]
                if row.get("line") == r["line"] and r.get("open") is not None:
                    row["open"] = r["open"]
                continue
            p = players.get(pid, {})
            mine.append({"pid": pid, "name": p.get("n") or match[2], "team": p.get("t"), "pos": p.get("pos") or match[1],
                         "stat": r["stat"], "line": r["line"], "open": r.get("open"), "over": None, "under": None,
                         "book_o": "DraftKings", "book_u": "DraftKings", "src": "espn"})
            added += 1
        if not mine:
            del props["games"][gid]
        else:
            props["pulled"].setdefault(gid, max((r.get("at") or "" for r in rows), default=None))
    return added


def current_week(games, season):
    open_ = [g for g in games if g["season"] == season and g["home_score"] is None and g["type"] == "REG"]
    if open_:
        return min(g["week"] for g in open_)
    weeks = [g["week"] for g in games if g["season"] == season]
    return max(weeks) if weeks else 1


def pick_source(picks_data, mingus_data, sub):
    """mingus-picks' folder when it has `sub`, else the old copy on mingus's data branch."""
    return picks_data if picks_data and (Path(picks_data) / sub).exists() else mingus_data


def build(mingus=None, mingus_data=None, out=OUT, cache=None, season=None, fetch=fetch_csv, espn=None, espn_get=None, today=None,
          picks_data=None):
    """`espn`: the store folder for ESPN caches (store/nfl/espn); None builds from nflverse alone."""
    season = season or season_now()
    seasons = [season - 1, season]
    games = build_games(fetch("schedules/games.csv", cache), seasons)
    if not games:
        raise ValueError("no games for seasons %s" % seasons)
    team_rows, player_rows = [], []
    for s in seasons:
        team_rows += fetch(f"stats_team/stats_team_week_{s}.csv", cache)
        player_rows += fetch(f"stats_player/stats_player_week_{s}.csv", cache)
    teamstats = build_teamstats(team_rows)
    players, logs = build_logs(player_rows)
    try:
        roster = fetch(f"weekly_rosters/roster_weekly_{season}.csv", cache)
    except Exception:
        roster = []
    try:
        injuries = fetch(f"injuries/injuries_{season}.csv", cache)
    except Exception:
        injuries = []
    note = "nflverse only"
    if espn:
        get = espn_get or nfl_espn.get
        espn = Path(espn)
        espn_games, calls = nfl_espn.fetch_season(season, espn, get=get)
        boxes, new_boxes = nfl_espn.fetch_boxes(espn_games, espn, get=get)
        espn_inj = nfl_espn.fetch_injuries(get=get)
        hist_file = espn / "lines.json"
        history = json.loads(hist_file.read_text()) if hist_file.exists() else {}
        games = merge_games(games, espn_games, boxes, history, dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"))
        hist_file.write_text(json.dumps(history, separators=(",", ":")))
        ids = espn_ids(roster)
        players = apply_status(players, roster, [] if espn_inj else injuries, season)
        unmatched = merge_boxes(games, boxes, players, logs, teamstats, ids)
        hurt = apply_espn_injuries(players, espn_inj, ids)
        for eid, (pid, _, _) in ids.items():   # ESPN ids for the pages' live box scores
            if pid in players:
                players[pid]["eid"] = eid
        espn_props, prop_calls = nfl_espn.fetch_props([g for g in games if g.get("src") == "espn"], espn, today or dt.date.today(), get=get)
        note = (f"ESPN: {len(espn_games)} games ({calls} scoreboard calls), {len(boxes)} box scores ({new_boxes} new), "
                f"{hurt} injury-report players, {unmatched} box-score players without an nflverse id")
    else:
        players = apply_status(players, roster, injuries, season)
    teams = json.loads((Path(mingus) / "site" / "data" / "teams.json").read_text()) if mingus else {}
    props = build_props(pick_source(picks_data, mingus_data, "odds/props"))
    if espn:
        note += f", DraftKings prop lines for {len(espn_props)} games ({prop_calls} calls, {merge_props(props, espn_props, ids, players)} rows added)"
    proj = build_proj(mingus_data)
    picks = build_picks(pick_source(picks_data, mingus_data, "picks"))
    meta = {"season": season, "seasons": seasons, "week": current_week(games, season),
            "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "source": "ESPN + nflverse + Mingus Football + Mingus Picks" if espn else "nflverse + Mingus Football + Mingus Picks"}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for p in players.values():
        p.pop("_rt", None)
    for name, value in (("meta", meta), ("games", games), ("teams", teams), ("teamstats", teamstats),
                        ("players", players), ("logs", logs), ("props", props), ("proj", proj), ("picks", picks)):
        (out / f"{name}.json").write_text(json.dumps(value, separators=(",", ":")))
    final = sum(1 for g in games if g["home_score"] is not None)
    return (f"NFL Lab: {len(games)} games ({final} final) over {seasons}, week {meta['week']}, {len(players)} players, "
            f"props for {len(props['games'])} games, projections for {len(proj)} games, {sum(len(d['picks']) for d in picks['history'])} model picks. {note}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mingus", help="checkout of Mingus Football's main branch (for site/data/teams.json)")
    ap.add_argument("--mingus-data", help="checkout of Mingus Football's data branch (model/projections)")
    ap.add_argument("--picks-data", help="checkout of Mingus Picks' data branch (odds/props, picks)")
    ap.add_argument("--cache", help="folder to cache nflverse downloads in")
    ap.add_argument("--espn", help="store folder for ESPN caches (e.g. store/nfl/espn); leave out for nflverse only")
    args = ap.parse_args()
    try:
        print(build(args.mingus, args.mingus_data, cache=args.cache, espn=args.espn, picks_data=args.picks_data))
    except Exception as e:  # never break the deploy over football data
        print(f"NFL Lab: skipped ({e}); the NFL pages will say the data is unavailable", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
