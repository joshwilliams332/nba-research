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


class PlayByPlayTests(unittest.TestCase):
    SUMMARY = {
        "header": {"competitions": [{"competitors": [
            {"homeAway": "home", "team": {"id": "25", "abbreviation": "OKC"}},
            {"homeAway": "away", "team": {"id": "10", "abbreviation": "HOU"}}]}]},
        "plays": [
            {"id": "1", "period": {"number": 1}, "clock": {"displayValue": "11:40"}, "team": {"id": "10"},
             "shootingPlay": True, "scoringPlay": False, "pointsAttempted": 3, "type": {"id": "92", "text": "Jump Shot"},
             "coordinate": {"x": 7, "y": 18}, "participants": [{"athlete": {"id": "s1"}}]},
            {"id": "2", "period": {"number": 1}, "clock": {"displayValue": "11:35"}, "team": {"id": "25"},
             "type": {"id": "155", "text": "Defensive Rebound"}, "participants": [{"athlete": {"id": "c1"}}]},
            {"id": "3", "period": {"number": 1}, "clock": {"displayValue": "11:20"}, "team": {"id": "25"},
             "shootingPlay": True, "scoringPlay": True, "pointsAttempted": 2, "type": {"id": "110", "text": "Layup"},
             "coordinate": {"x": 25, "y": 2}, "participants": [{"athlete": {"id": "c1"}}, {"athlete": {"id": "g1"}}]},
            {"id": "4", "period": {"number": 2}, "clock": {"displayValue": "45.5"}, "team": {"id": "25"},
             "shootingPlay": True, "scoringPlay": True, "pointsAttempted": 3, "type": {"id": "92", "text": "Jump Shot"},
             "coordinate": {"x": 48, "y": 1}, "participants": [{"athlete": {"id": "g1"}}]},
            {"id": "5", "period": {"number": 3}, "clock": {"displayValue": "5:00"}, "team": {"id": "25"},
             "shootingPlay": True, "scoringPlay": True, "pointsAttempted": 1, "type": {"id": "97", "text": "Free Throw - 1 of 1"},
             "coordinate": {"x": -214748340, "y": -214748365}, "participants": [{"athlete": {"id": "g1"}}]},
        ],
        "winprobability": [{"playId": "1", "homeWinPercentage": 0.6}, {"playId": "5", "homeWinPercentage": 0.71234}],
        "seasonseries": [{"type": "season", "summary": "OKC leads series 1-0"}],
    }

    def test_parse_pbp(self):
        pbp = b.parse_pbp(self.SUMMARY, "g1")
        self.assertEqual(pbp["plays"][0], [1, 700.0, "HOU", "s1", "s", 0, 3, 7, 18, ""])
        self.assertEqual(pbp["plays"][1], [1, 695.0, "OKC", "c1", "r"])
        self.assertEqual(pbp["plays"][2][9], "g1")  # assist
        self.assertEqual(pbp["plays"][4][7:9], [None, None])  # free throws have no location
        self.assertEqual(pbp["wp"], [[20, 0.6], [1860, 0.712]])
        self.assertEqual(pbp["ss"], "OKC leads series 1-0")

    def test_period_stats_and_first_basket(self):
        pbp = b.parse_pbp(self.SUMMARY, "g1")
        stats = b.period_stats(pbp, ["c1", "g1", "s1"])
        cols = dict(zip(b.PERIOD_COLS, stats["g1"]))
        self.assertEqual((cols["q1pts"], cols["q1ast"], cols["h1pts"], cols["h1fg3m"]), (0, 1, 3, 1))
        self.assertEqual(dict(zip(b.PERIOD_COLS, stats["c1"]))["q1reb"], 1)
        self.assertEqual(b.first_basket(pbp), ["c1", "OKC"])

    def test_shot_zones(self):
        self.assertEqual(b.shot_zone(25, 2, 2), "ra")
        self.assertEqual(b.shot_zone(30, 10, 2), "paint")
        self.assertEqual(b.shot_zone(40, 12, 2), "mid")
        self.assertEqual(b.shot_zone(2, 3, 3), "lc3")
        self.assertEqual(b.shot_zone(48, 0, 3), "rc3")
        self.assertEqual(b.shot_zone(25, 25, 3), "atb3")
        self.assertIsNone(b.shot_zone(None, None, 2))
        self.assertEqual(b.elapsed(5, 300), 2880)


if __name__ == "__main__":
    unittest.main()
