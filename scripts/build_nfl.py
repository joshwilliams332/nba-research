#!/usr/bin/env python3
"""NFL Lab data: build site/data/nfl/ for the NFL side of Mingus Lab.

Sources (all public, no Odds API credits):
- nflverse (github.com/nflverse/nflverse-data releases): schedules with lines and scores, team and player weekly
  stats, weekly rosters (reserve / IR status) and injury reports, for last season and this one.
- Mingus Football (github.com/joshwilliams332/mingus), which owns the NFL models: team logos and colors from its site
  data, and from its `data` branch the sportsbook props it pulls (`odds/props/<game>.json`) and its projections
  (`model/projections/<season>-wNN.json`). The workflow checks both out (sparse) and passes the folders in.

Files written:
    meta.json       season, current week, seasons loaded, when built
    games.json      both seasons' games: scores, spread / total / money lines (with prices), weather
    teams.json      city, nickname, color, logo
    teamstats.json  team -> weekly box totals (both seasons)
    players.json    player id -> name, position, team, headshot, roster / injury status
    logs.json       {cols, logs: player id -> [[season, week, team, opp, ...cols]]}
    props.json      {games: game id -> prop rows, pulled: game id -> time}
    proj.json       game id -> player id -> stat -> {mean, sd, p_over, line}

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


def apply_status(players, roster_rows, injury_rows):
    """Latest weekly roster status (RES = reserve / IR, PUP...) and injury report status for each player."""
    if roster_rows:
        last = max(num(r["week"], int) or 0 for r in roster_rows)
        for r in roster_rows:
            if num(r["week"], int) != last or r["gsis_id"] not in players:
                continue
            p = players[r["gsis_id"]]
            p["t"] = r["team"] or p["t"]
            if r["status"] in ("RES", "INA", "CUT", "RET", "SUS", "EXE", "NON", "UFA"):
                p["st"] = {"RES": "IR", "INA": "Inactive", "CUT": "Released", "RET": "Retired", "SUS": "Suspended"}.get(r["status"], r["status"])
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


def current_week(games, season):
    open_ = [g for g in games if g["season"] == season and g["home_score"] is None and g["type"] == "REG"]
    if open_:
        return min(g["week"] for g in open_)
    weeks = [g["week"] for g in games if g["season"] == season]
    return max(weeks) if weeks else 1


def build(mingus=None, mingus_data=None, out=OUT, cache=None, season=None, fetch=fetch_csv):
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
    players = apply_status(players, roster, injuries)
    teams = json.loads((Path(mingus) / "site" / "data" / "teams.json").read_text()) if mingus else {}
    props = build_props(mingus_data)
    proj = build_proj(mingus_data)
    meta = {"season": season, "seasons": seasons, "week": current_week(games, season),
            "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "source": "nflverse + Mingus Football"}
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for name, value in (("meta", meta), ("games", games), ("teams", teams), ("teamstats", teamstats),
                        ("players", players), ("logs", logs), ("props", props), ("proj", proj)):
        (out / f"{name}.json").write_text(json.dumps(value, separators=(",", ":")))
    final = sum(1 for g in games if g["home_score"] is not None)
    return (f"NFL Lab: {len(games)} games ({final} final) over {seasons}, week {meta['week']}, {len(players)} players, "
            f"props for {len(props['games'])} games, projections for {len(proj)} games")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mingus", help="checkout of Mingus Football's main branch (for site/data/teams.json)")
    ap.add_argument("--mingus-data", help="checkout of Mingus Football's data branch (odds/props, model/projections)")
    ap.add_argument("--cache", help="folder to cache nflverse downloads in")
    args = ap.parse_args()
    try:
        print(build(args.mingus, args.mingus_data, cache=args.cache))
    except Exception as e:  # never break the deploy over football data
        print(f"NFL Lab: skipped ({e}); the NFL pages will say the data is unavailable", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
