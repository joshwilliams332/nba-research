"""Tests for the parsing and budgeting in scripts/build_data.py (no network)."""

import sys
import unittest
from datetime import date, datetime, timezone
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
    # These tests check basketball's own budgeting; the shared-key reserve has its own test below.
    def setUp(self):
        self._other = b.OTHER_SPORTS_CREDITS
        b.OTHER_SPORTS_CREDITS = 0

    def tearDown(self):
        b.OTHER_SPORTS_CREDITS = self._other

    def test_football_share_is_held_back(self):
        # Nov 1 (30 days), 500 left, 200 a month for football: (500 - 10 - 200) / 30 = 9 a day for basketball.
        self.assertEqual(b.daily_budget(500, date(2026, 11, 1), other=200), 9)
        # Mid-month football has already spent part of its share (it's gone from `remaining`); only the
        # 16 days still to come are held back: (250 - 10 - 200 * 16/30) / 16 = 8.
        self.assertEqual(b.daily_budget(250, date(2026, 11, 15), other=200), 8)
        # Without a share it's the old even spread.
        self.assertEqual(b.daily_budget(500, date(2026, 11, 1), other=0), 16)
        # Never negative, even if football overspends.
        self.assertEqual(b.daily_budget(50, date(2026, 11, 15), other=200), 0)

    def test_plan_spreads_credits_over_the_month(self):
        # 400 credits, 10 days left in October, 8 games: 39/day, 8 set aside for closing lines -> 31 -> 3 markets
        self.assertEqual(b.plan_markets(400, 8, date(2026, 10, 22)), (3, 8))
        # 500 credits on Nov 1 (30 days), 8 games: 16/day -> 8 for closing lines, 8 for the morning (points only)
        self.assertEqual(b.plan_markets(500, 8, date(2026, 11, 1)), (1, 8))
        # A thin day (12/day for 8 games) keeps everything for the morning pull
        self.assertEqual(b.plan_markets(370, 8, date(2026, 11, 1)), (1, 8))
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

    def test_plan_close(self):
        self.assertEqual(b.plan_close(480, 6, date(2026, 11, 1)), 6)   # 15/day covers all 6
        self.assertEqual(b.plan_close(70, 6, date(2026, 11, 1)), 2)    # 2/day left
        self.assertEqual(b.plan_close(None, 6, date(2026, 11, 1)), 0)
        self.assertEqual(b.plan_close(480, 0, date(2026, 11, 1)), 0)

    def test_close_due_window(self):
        from datetime import datetime, timezone
        now = datetime(2026, 10, 28, 22, 47, tzinfo=timezone.utc)
        games = [{"id": "a", "state": "pre", "t": "2026-10-28T23:00Z"},   # 13 min away: due
                 {"id": "b", "state": "pre", "t": "2026-10-29T02:00Z"},   # 3 h away: not yet
                 {"id": "c", "state": "in", "t": "2026-10-28T22:30Z"},    # already started
                 {"id": "d", "state": "pre", "t": "2026-10-28T23:30Z"}]   # due but already captured
        self.assertEqual([g["id"] for g in b.close_due(games, now, {"d": []})], ["a"])

    def test_merge_props_open_and_close(self):
        prop = lambda l, o, bk="draftkings": {"id": "1", "n": "A B", "s": "pts", "l": l, "o": o, "u": -110,  # noqa: E731
                                              "bk": bk, "books": {bk: [l, o, -110]}}
        reb = dict(prop(7.5, -120), s="reb")
        merged = b.merge_props({"fetched": "t1", "markets": ["pts", "reb"], "games": {"g": [prop(24.5, -110), reb]}},
                               {"markets": ["pts"], "fetched": {"g": "t2"}, "games": {"g": [prop(25.5, -125)]}},
                               date(2026, 10, 28))
        pts, r = merged["games"]["g"]
        self.assertEqual((pts["l"], pts["o"]), (25.5, -125))          # latest numbers up front
        self.assertEqual(pts["open"], [24.5, -110, -110, "draftkings"])
        self.assertEqual(pts["close"], [25.5, -125, -110, "draftkings"])
        self.assertEqual(r["open"][0], 7.5)
        self.assertNotIn("close", r)
        self.assertEqual(merged["closed"], {"g": "t2"})
        self.assertEqual(b.merge_props(None, None, date(2026, 10, 28))["games"], {})

    def test_keep_open_line(self):
        g = {"state": "pre", "line": {"sp": -5.5}}
        b.keep_open_line(g, {"open": {"sp": -4.5}, "line": {"sp": -5}})
        self.assertEqual((g["open"], g["line"]), ({"sp": -4.5}, {"sp": -5.5}))
        g = {"state": "pre", "line": {"sp": -3}}
        b.keep_open_line(g, None)
        self.assertEqual(g["open"], {"sp": -3})
        g = {"state": "post"}
        b.keep_open_line(g, {"line": {"sp": 2}})                     # ESPN dropped the odds: keep ours
        self.assertEqual((g["line"], g["open"]), ({"sp": 2}, {"sp": 2}))

    def test_line_history_records_changes_before_tip(self):
        t1, t2 = datetime(2026, 10, 28, 15, 37, tzinfo=timezone.utc), datetime(2026, 10, 28, 21, 37, tzinfo=timezone.utc)
        g = {"state": "pre", "line": {"sp": -4.5, "tot": 236.5, "mlh": -190, "mla": 160}}
        b.keep_open_line(g, None, t1)
        self.assertEqual(g["lh"], [["2026-10-28T15:37Z", -4.5, 236.5, -190, 160]])
        same = {"state": "pre", "line": dict(g["line"])}
        b.keep_open_line(same, g, t2)                                 # unchanged: no new point
        self.assertEqual(len(same["lh"]), 1)
        moved = {"state": "pre", "line": {"sp": -5.5, "tot": 236.5, "mlh": -210, "mla": 175}}
        b.keep_open_line(moved, same, t2)
        self.assertEqual(moved["lh"][-1], ["2026-10-28T21:37Z", -5.5, 236.5, -210, 175])
        final = {"state": "post", "line": {"sp": -6}}
        b.keep_open_line(final, moved, t2)                            # after tip: history kept, not extended
        self.assertEqual(len(final["lh"]), 2)

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
