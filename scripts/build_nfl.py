#!/usr/bin/env python3
"""NFL Lab data: copy Mingus Football's published data into site/data/nfl/ for the NFL side of Mingus Lab.

Mingus Football (github.com/joshwilliams332/mingus) owns all NFL data and models; this script only reads what its live
site already publishes, so it costs no Odds API credits and adds no data sources. Files copied:

    meta.json        season, last / next week, when it was built
    games.json       schedule with scores, spread, total, money lines and implied team totals
    teams.json       city, nickname, color, logo
    teamstats.json   each team's week-by-week box totals (passing, rushing, first downs, sacks, turnovers)

Usage:
    python3 scripts/build_nfl.py                       # from the live Mingus Football site
    python3 scripts/build_nfl.py --src-dir ../mingus/site/data   # from a local copy (offline / tests)
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

SITE = "https://joshwilliams332.github.io/mingus/data"
FILES = ["meta", "games", "teams", "teamstats"]
OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "nfl"
GAME_FIELDS = ["id", "week", "type", "date", "time", "away", "home", "away_score", "home_score", "home_spread",
               "total", "home_implied", "away_implied", "away_ml", "home_ml", "stadium", "roof", "temp", "wind", "div"]


def fetch(name, src_dir=None):
    if src_dir:
        return json.loads((Path(src_dir) / f"{name}.json").read_text())
    req = urllib.request.Request(f"{SITE}/{name}.json", headers={"User-Agent": "mingus-lab-build"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def check(data):
    """Fail loudly if Mingus Football's files changed shape."""
    if not isinstance(data["games"], list) or not data["games"]:
        raise ValueError("games.json: expected a non-empty list")
    missing = [f for f in ("id", "week", "date", "home", "away") if f not in data["games"][0]]
    if missing:
        raise ValueError(f"games.json: missing fields {missing}")
    if not isinstance(data["teams"], dict) or not isinstance(data["teamstats"], dict):
        raise ValueError("teams.json / teamstats.json: expected objects keyed by team")


def slim(data):
    data = dict(data)
    data["games"] = [{k: g.get(k) for k in GAME_FIELDS} for g in data["games"]]
    return data


def build(src_dir=None, out=OUT):
    data = {name: fetch(name, src_dir) for name in FILES}
    check(data)
    data = slim(data)
    out.mkdir(parents=True, exist_ok=True)
    for name, value in data.items():
        (out / f"{name}.json").write_text(json.dumps(value, separators=(",", ":")))
    final = sum(1 for g in data["games"] if g.get("home_score") is not None)
    return f"NFL Lab: {len(data['games'])} games ({final} final), {len(data['teams'])} teams, week {data['meta'].get('next_week')}"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src-dir", help="read Mingus Football's data from this folder instead of the live site")
    args = ap.parse_args()
    try:
        print(build(args.src_dir))
    except Exception as e:  # never break the Hoop Lab deploy over football data
        print(f"NFL Lab: skipped ({e}); NFL Lab pages will say the data is unavailable", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
