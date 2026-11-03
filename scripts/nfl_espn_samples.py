#!/usr/bin/env python3
"""Save raw ESPN NFL JSON into the data store (store/nfl/samples/) so the NFL Lab parser can be written against the
real shapes. The cloud sandbox can't reach ESPN; GitHub Actions can. Small: one scoreboard, two game summaries
(one final, one upcoming), the injury report and the team list. Safe to run every time (it overwrites)."""
import json
import sys
import urllib.request
from pathlib import Path

API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Mingus Lab data job)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main(store):
    out = Path(store) / "nfl" / "samples"
    out.mkdir(parents=True, exist_ok=True)
    board = get(f"{API}/scoreboard")
    (out / "scoreboard.json").write_text(json.dumps(board, indent=1))
    season = board.get("season", {}).get("year")
    week = (board.get("week") or {}).get("number")
    prev = get(f"{API}/scoreboard?dates={season}&seasontype=2&week={max(1, (week or 2) - 1)}")
    (out / "scoreboard-prev.json").write_text(json.dumps(prev, indent=1))
    final = next((e["id"] for e in prev.get("events", []) if e.get("status", {}).get("type", {}).get("completed")), None)
    upcoming = next((e["id"] for e in board.get("events", []) if not e.get("status", {}).get("type", {}).get("completed")), None)
    if not upcoming and week:   # the default week is finished (Monday night to Wednesday): look at next week's games
        nxt = get(f"{API}/scoreboard?dates={season}&seasontype=2&week={week + 1}")
        upcoming = next((e["id"] for e in nxt.get("events", []) if not e.get("status", {}).get("type", {}).get("completed")), None)
    for name, eid in (("summary-final", final), ("summary-upcoming", upcoming)):
        if eid:
            (out / f"{name}.json").write_text(json.dumps(get(f"{API}/summary?event={eid}"), indent=1))
    # Does ESPN's odds feed carry player props? (core API: providers per game, then each provider's propBets)
    if upcoming:
        core = f"https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{upcoming}/competitions/{upcoming}/odds"
        try:
            odds = get(core)
            (out / "odds-upcoming.json").write_text(json.dumps(odds, indent=1))
            for item in (odds.get("items") or [])[:4]:
                ref = item.get("$ref", "").split("?")[0]
                pid = ref.rstrip("/").rsplit("/", 1)[-1]
                try:
                    props = get(f"{ref}/propBets?limit=1000")
                    (out / f"propbets-{pid}.json").write_text(json.dumps(props, indent=1))
                    print(f"propBets provider {pid}: {props.get('count')} entries")
                except Exception as e:
                    print(f"propBets provider {pid}: {e}")
        except Exception as e:
            print(f"odds: {e}", file=sys.stderr)
    for name, url in (("injuries", f"{API}/injuries"), ("teams", f"{API}/teams")):
        try:
            (out / f"{name}.json").write_text(json.dumps(get(url), indent=1))
        except Exception as e:  # keep the rest
            print(f"{name}: {e}", file=sys.stderr)
    print(f"ESPN NFL samples: season {season} week {week}, final {final}, upcoming {upcoming}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "store")
