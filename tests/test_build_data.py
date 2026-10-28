"""Tests for the parsing and budgeting in scripts/build_data.py (no network)."""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_data as b  # noqa: E402

LABELS = ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST", "TO", "STL", "BLK", "OREB", "DREB", "PF", "+/-"]


def athlete(pid, name, stats, starter=True, dnp=False):
    return {"athlete": {"id": pid, "displayName": name, "shortName": name[0] + ". " + name.split()[-1],
                        "position": {"abbreviation": "G"}, "jersey": "1"},
            "starter": starter, "didNotPlay": dnp, "reason": "COACH'S DECISION" if dnp else "", "stats": stats}


class LineTests(unittest.TestCase):
    def test_classic_odds_home_favorite(self):
        line = b.parse_line([{"details": "IND -4.5", "overUnder": 237.5, "homeTeamOdds": {"moneyLine": -170},
                              "awayTeamOdds": {"moneyLine": 142}, "provider": {"name": "DraftKings"}}], "IND", "PHI")
        self.assertEqual(line["sp"], -4.5)
        self.assertEqual(line["tot"], 237.5)
        self.assertEqual((line["mlh"], line["mla"]), (-170, 142))

    def test_away_favorite_uses_espn_abbreviation(self):
        line = b.parse_line([{"details": "GS -3"}], "LAL", "GSW")
        self.assertEqual(line["sp"], 3.0)

    def test_newer_odds_format(self):
        line = b.parse_line([{"details": "EVEN", "moneyline": {"home": {"close": {"odds": "EVEN"}},
                                                               "away": {"close": {"odds": "-120"}}},
                              "total": {"over": {"close": {"line": "o221.5", "odds": "-110"}}}}], "BOS", "NYK")
        self.assertEqual(line["sp"], 0.0)
        self.assertEqual(line["tot"], 221.5)
        self.assertEqual((line["mlh"], line["mla"], line["ov"]), (100, -120, -110))

    def test_no_odds(self):
        self.assertIsNone(b.parse_line([], "BOS", "NYK"))
        self.assertIsNone(b.parse_line([{"provider": {"name": "x"}}], "BOS", "NYK"))


class BoxTests(unittest.TestCase):
    def test_parse_stats_by_label(self):
        row = b.parse_stats(["34", "25", "8-17", "2-6", "7-8", "10", "5", "3", "1", "0", "2", "8", "4", "+7"], LABELS)
        self.assertEqual(dict(zip(b.COLS, row)), {
            "min": 34, "pts": 25, "reb": 10, "ast": 5, "fg3m": 2, "fg3a": 6, "fgm": 8, "fga": 17, "ftm": 7, "fta": 8,
            "oreb": 2, "dreb": 8, "stl": 1, "blk": 0, "tov": 3, "pf": 4, "pm": 7})

    def test_parse_box_keeps_players_and_dnps(self):
        summary = {"boxscore": {"players": [{"team": {"abbreviation": "NY"}, "statistics": [{
            "labels": LABELS,
            "athletes": [
                athlete("1", "Jalen Brunson", ["36", "30", "11-20", "3-7", "5-5", "4", "8", "2", "1", "0", "0", "4", "2", "+9"]),
                athlete("2", "Bench Guy", [], starter=False, dnp=True),
                athlete("3", "Garbage Time", ["0", "0", "0-0", "0-0", "0-0", "0", "0", "0", "0", "0", "0", "0", "0", "0"]),
            ]}]}]},
            "header": {"competitions": [{"competitors": [{"homeAway": "home", "team": {"abbreviation": "NY"}},
                                                         {"homeAway": "away", "team": {"abbreviation": "BOS"}}]}]},
            "pickcenter": [{"details": "NY -2.5", "overUnder": 220}]}
        box = b.parse_box(summary, "g1")
        self.assertEqual(len(box["rows"]), 1)
        self.assertEqual(box["rows"][0][:4], ["1", "NYK", 1, 36])
        self.assertEqual([d[0] for d in box["dnp"]], ["2", "3"])
        self.assertEqual(box["line"]["sp"], -2.5)

    def test_num(self):
        self.assertEqual(b.num("+5"), 5)
        self.assertEqual(b.num("34:30"), 34.5)
        self.assertEqual(b.num(38.0), 38)
        self.assertIsNone(b.num("--"))


class PropsTests(unittest.TestCase):
    def test_plan_spreads_credits_over_the_month(self):
        # 400 credits, 10 days left in October, 8 games: 39/day -> 4 markets
        self.assertEqual(b.plan_markets(400, 8, date(2026, 10, 22)), (4, 8))
        # 100 credits over 31 days: 2/day -> points only, for 2 games
        self.assertEqual(b.plan_markets(100, 8, date(2026, 12, 1)), (1, 2))
        self.assertEqual(b.plan_markets(5, 8, date(2026, 12, 1)), (0, 0))

    def test_parse_props_prefers_draftkings(self):
        def book(key, point, over):
            return {"key": key, "markets": [{"key": "player_points", "outcomes": [
                {"name": "Over", "description": "Kelly Oubre Jr.", "price": over, "point": point},
                {"name": "Under", "description": "Kelly Oubre Jr.", "price": -110, "point": point}]}]}
        props = b.parse_props({"bookmakers": [book("fanduel", 13.5, -105), book("draftkings", 14.5, -120)]},
                              {"kelly oubre": "42"})
        self.assertEqual(len(props), 1)
        p = props[0]
        self.assertEqual((p["id"], p["s"], p["l"], p["o"], p["bk"]), ("42", "pts", 14.5, -120, "draftkings"))
        self.assertEqual(p["books"]["fanduel"], [13.5, -105, -110])

    def test_name_key(self):
        self.assertEqual(b.name_key("Dennis Schröder"), "dennis schroder")
        self.assertEqual(b.name_key("Jaren Jackson Jr."), "jaren jackson")


if __name__ == "__main__":
    unittest.main()
