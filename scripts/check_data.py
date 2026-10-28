#!/usr/bin/env python3
"""Sanity-check the built site/data files and print a short report.

Run after build_data.py. The deploy workflow runs it and writes the report to the run's summary page;
the data-checker agent (.claude/agents/data-checker.md) starts from it.

    python3 scripts/check_data.py            # report, exit 0 unless the data is unusable
    python3 scripts/check_data.py --strict   # also exit 1 on warnings

Problems are split into ERRORS (the site would be broken or empty) and WARNINGS (something is
missing or looks odd, e.g. a final game without a box score or props that matched no player).
"""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "site" / "data"
# Single-game values above these are almost certainly parsing mistakes.
LIMITS = {"min": 65, "pts": 85, "reb": 35, "ast": 30, "fg3m": 16, "stl": 12, "blk": 15}


def load(name):
    return json.loads((DATA / f"{name}.json").read_text())


def check():
    errors, warnings, facts = [], [], []
    meta, games, players, logs = load("meta"), load("games"), load("players"), load("logs")
    props, injuries = load("props"), load("injuries")
    cols = meta["cols"]
    today = date.fromisoformat(meta["today"])

    built = datetime.fromisoformat(meta["built"])
    age = datetime.now(timezone.utc) - built
    facts.append(f"Built {meta['built']} ({age.total_seconds() / 3600:.1f} h ago), season {meta['label']}")
    if not games:
        errors.append("games.json is empty")
    if not players or not logs:
        errors.append("no players or game logs")

    by_id = {g["id"]: g for g in games}
    played = Counter(r[0] for rows in logs.values() for r in rows)
    finals = [g for g in games if g["state"] == "post"]
    facts.append(f"{len(games)} games ({len(finals)} final), {len(players)} players, "
                 f"{sum(played.values())} player game rows")

    recent = [g for g in finals if date.fromisoformat(g["d"]) >= today - timedelta(7)]
    no_box = [g for g in recent if played[g["id"]] == 0]
    if no_box:
        warnings.append(f"{len(no_box)} final game(s) in the last week have no box score yet: "
                        + ", ".join(f"{g['a']}@{g['h']} {g['d']}" for g in no_box[:8]))
    thin = [g for g in recent if 0 < played[g["id"]] < 14]
    if thin:
        warnings.append(f"{len(thin)} recent box score(s) have fewer than 14 players: "
                        + ", ".join(f"{g['a']}@{g['h']} ({played[g['id']]})" for g in thin[:8]))
    stuck = [g for g in games if g["state"] != "post" and date.fromisoformat(g["d"]) < today - timedelta(1)]
    if stuck:
        warnings.append(f"{len(stuck)} past game(s) never went final (postponed?): "
                        + ", ".join(f"{g['a']}@{g['h']} {g['d']}" for g in stuck[:8]))

    slate = [g for g in games if g["d"] == today.isoformat()]
    no_line = [g for g in slate if not g.get("line")]
    facts.append(f"Today ({today}): {len(slate)} games, {len(slate) - len(no_line)} with lines")
    if no_line and any(g["state"] == "pre" for g in no_line):
        warnings.append("no game lines yet for: " + ", ".join(f"{g['a']}@{g['h']}" for g in no_line))

    odd = []
    for pid, rows in logs.items():
        for r in rows:
            stats = dict(zip(cols, r[3:]))
            bad = [k for k, cap in LIMITS.items() if (stats.get(k) or 0) > cap or (stats.get(k) or 0) < 0]
            if bad or r[0] not in by_id:
                odd.append(f"{players.get(pid, {}).get('n', pid)} in {r[0]}: {', '.join(bad) or 'unknown game'}")
    if odd:
        warnings.append(f"{len(odd)} game log row(s) look wrong: " + "; ".join(odd[:5]))

    prop_list = [p for ps in (props.get("games") or {}).values() for p in ps]
    unmatched = sorted({p["n"] for p in prop_list if not p.get("id")})
    odds = meta.get("odds") or {}
    facts.append(f"Props for {props.get('date')}: {len(prop_list)} lines, markets {odds.get('markets') or []}, "
                 f"Odds API credits left {odds.get('remaining')}")
    if unmatched:
        warnings.append(f"{len(unmatched)} prop player(s) not matched to an ESPN id: " + ", ".join(unmatched[:10]))
    if odds.get("remaining") is not None and odds["remaining"] < 25:
        warnings.append(f"only {odds['remaining']} Odds API credits left this month")

    facts.append(f"Injury report: {len(injuries)} players")
    if not injuries:
        warnings.append("injury report is empty (ESPN may have failed; the last report is kept when it does)")
    return errors, warnings, facts


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--strict", action="store_true", help="exit 1 on warnings too")
    args = ap.parse_args()
    errors, warnings, facts = check()
    lines = ["### Data check", ""] + [f"- {f}" for f in facts] + [""]
    lines += [f"- ❌ {e}" for e in errors] + [f"- ⚠️ {w}" for w in warnings]
    if not errors and not warnings:
        lines.append("- ✅ No problems found")
    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(report + "\n")
    if errors or (args.strict and warnings):
        sys.exit(1)


if __name__ == "__main__":
    main()
