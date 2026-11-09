"""Tests for scripts/build_nfl.py (NFL Lab data from nflverse + Mingus Football). Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_nfl  # noqa: E402

GAME = {"game_id": "2026_09_JAX_BAL", "season": "2026", "game_type": "REG", "week": "9", "gameday": "2026-11-05",
        "gametime": "20:15", "away_team": "JAX", "home_team": "BAL", "away_score": "NA", "home_score": "NA",
        "spread_line": "-9.5", "total_line": "42.5", "away_moneyline": "-470", "home_moneyline": "360",
        "home_spread_odds": "-120", "away_spread_odds": "-111", "over_odds": "-105", "under_odds": "-115",
        "stadium": "M&T Bank Stadium", "roof": "outdoors", "temp": "NA", "wind": "NA", "div_game": "0"}
PLAYER = {"player_id": "00-1", "player_display_name": "Trevor Lawrence", "position": "QB", "headshot_url": "x.png",
          "season": "2026", "week": "8", "season_type": "REG", "team": "JAX", "opponent_team": "IND",
          "completions": "10", "attempts": "14", "passing_yards": "210", "passing_tds": "3", "passing_interceptions": "0",
          "carries": "2", "rushing_yards": "5", "rushing_tds": "0", "targets": "NA", "receptions": "NA",
          "receiving_yards": "NA", "receiving_tds": "NA", "target_share": "NA", "air_yards_share": "NA"}
TEAM = {"season": "2026", "week": "8", "team": "JAX", "season_type": "REG", "opponent_team": "IND", "completions": "10",
        "attempts": "14", "passing_yards": "210", "sacks_suffered": "1", "carries": "40", "rushing_yards": "200",
        "passing_first_downs": "8", "rushing_first_downs": "12", "passing_interceptions": "0",
        "sack_fumbles_lost": "0", "rushing_fumbles_lost": "1", "receiving_fumbles_lost": "0"}


def fake_fetch(path, cache=None):
    if path.startswith("schedules/"):
        return [GAME, dict(GAME, season="2020", game_id="old")]
    if path.startswith("stats_team/"):
        return [TEAM] if "2026" in path else []
    if path.startswith("stats_player/"):
        return [PLAYER, dict(PLAYER, player_id="00-9", position="K")] if "2026" in path else []
    if path.startswith("weekly_rosters/"):
        return [{"week": "8", "gsis_id": "00-1", "team": "JAX", "status": "ACT", "status_description_abbr": "A01"}]
    if path.startswith("injuries/"):
        return [{"week": "9", "gsis_id": "00-1", "report_status": "Questionable", "report_primary_injury": "Ankle", "report_secondary_injury": ""}]
    raise AssertionError(path)


class BuildNflTest(unittest.TestCase):
    def setUp(self):
        self.mingus = Path(tempfile.mkdtemp())
        (self.mingus / "site" / "data").mkdir(parents=True)
        (self.mingus / "site" / "data" / "teams.json").write_text(json.dumps({"JAX": {"nickname": "Jaguars"}}))
        self.data = Path(tempfile.mkdtemp())
        (self.data / "odds" / "props").mkdir(parents=True)
        (self.data / "odds" / "props" / "2026_09_JAX_BAL.json").write_text(json.dumps({"game": "2026_09_JAX_BAL", "pulled": "t",
            "rows": [{"pid": "00-1", "stat": "pass_yds", "line": 219.5, "over": -168, "under": 130}, {"pid": "00-1", "stat": "kick_pts", "line": 6.5}]}))
        self.out = Path(tempfile.mkdtemp()) / "nfl"

    def read(self, name):
        return json.loads((self.out / f"{name}.json").read_text())

    def test_build(self):
        msg = build_nfl.build(self.mingus, self.data, self.out, season=2026, fetch=fake_fetch)
        self.assertIn("1 games (0 final)", msg)
        g = self.read("games")[0]
        # nflverse spread_line is positive when the home team is favored; ours is the home team's number.
        self.assertEqual(g["home_spread"], 9.5)
        self.assertEqual((g["home_implied"], g["away_implied"]), (16.5, 26.0))
        self.assertEqual(g["away_ml"], -470)
        self.assertEqual(self.read("meta")["week"], 9)
        logs = self.read("logs")
        self.assertEqual(logs["logs"]["00-1"][0][:4], [2026, 8, "JAX", "IND"])
        self.assertNotIn("00-9", logs["logs"])          # kickers aren't tracked
        p = self.read("players")["00-1"]
        self.assertEqual((p["st"], p["det"]), ("Questionable", "Ankle"))
        ts = self.read("teamstats")["JAX"][0]
        self.assertEqual((ts["fd"], ts["fl"]), (20, 1))
        props = self.read("props")["games"]["2026_09_JAX_BAL"]
        self.assertEqual([r["stat"] for r in props], ["pass_yds"])   # unknown prop stats are dropped

    def test_reserve_list_beats_the_injury_report(self):
        def fetch(path, cache=None):
            if path.startswith("weekly_rosters/"):
                return [{"week": "8", "gsis_id": "00-1", "team": "JAX", "status": "RES", "status_description_abbr": "R01"}]
            return fake_fetch(path, cache)
        build_nfl.build(self.mingus, self.data, self.out, season=2026, fetch=fetch)
        self.assertEqual(self.read("players")["00-1"]["st"], "IR")

    def test_traded_player_shows_his_new_team_not_released(self):
        # nflverse lists a traded player twice in the trade week: CUT for the old team, ACT for the new one.
        rows = [{"season": "2026", "week": "10", "gsis_id": "00-9", "team": "BAL", "status": "ACT"},
                {"season": "2026", "week": "10", "gsis_id": "00-9", "team": "ARI", "status": "CUT"}]
        for order in (rows, rows[::-1]):
            players = {"00-9": {"n": "Jacoby Brissett", "pos": "QB", "t": "ARI"}}
            p = build_nfl.apply_status(players, order, [], 2026)["00-9"]
            self.assertEqual(p["t"], "BAL")
            self.assertNotIn("st", p)
            self.assertEqual(p["_rt"], (2026, 10))
        released = build_nfl.apply_status({"00-8": {"n": "X", "t": "ARI"}},
                                          [{"season": "2026", "week": "10", "gsis_id": "00-8", "team": "ARI", "status": "CUT"}], [], 2026)
        self.assertEqual(released["00-8"]["st"], "Released")   # cut with no new team still says so

    def test_props_and_picks_come_from_mingus_picks(self):
        picks = Path(tempfile.mkdtemp())
        (picks / "odds" / "props").mkdir(parents=True)
        (picks / "odds" / "props" / "2026_09_JAX_BAL.json").write_text(json.dumps({"game": "2026_09_JAX_BAL", "pulled": "t2",
            "rows": [{"pid": "00-1", "stat": "pass_yds", "line": 224.5, "over": -110, "under": -110}]}))
        build_nfl.build(self.mingus, self.data, self.out, season=2026, fetch=fake_fetch, picks_data=picks)
        self.assertEqual(self.read("props")["games"]["2026_09_JAX_BAL"][0]["line"], 224.5)   # new home wins
        # No picks/ folder there yet: the old copy on mingus's data branch is used (none here, so empty).
        self.assertEqual(self.read("picks")["history"], [])
        self.assertEqual(build_nfl.pick_source(picks, self.data, "picks"), self.data)

    def test_draftkings_move_shows_the_new_line_and_keeps_the_priced_one_as_was(self):
        props = {"games": {"g": [{"pid": "p1", "stat": "rec_yds", "line": 53.5, "over": -111, "under": -115, "book_o": "DraftKings",
                                  "book_u": "FanDuel", "fair_o": 0.5, "fair_u": 0.5},
                                 {"pid": "p2", "stat": "rec", "line": 4.5, "over": -143, "under": 110, "book_o": "BetOnline.ag", "book_u": "x"}]},
                 "pulled": {}}
        espn = {"g": [{"eid": "1", "stat": "rec_yds", "line": 48.5, "open": 53.5}, {"eid": "2", "stat": "rec", "line": 4.5, "open": 4.5}]}
        ids = {"1": ("p1", "TE", "Colston Loveland"), "2": ("p2", "WR", "Luther Burden")}
        build_nfl.merge_props(props, espn, ids, {})
        moved, same = props["games"]["g"]
        self.assertEqual((moved["line"], moved["over"], moved["book_o"], moved["src"]), (48.5, None, "DraftKings", "espn"))
        self.assertEqual(moved["was"], {"line": 53.5, "over": -111, "under": -115, "book_o": "DraftKings", "book_u": "FanDuel"})
        self.assertEqual((same["line"], same["over"], same.get("was")), (4.5, -143, None))   # unmoved: keeps its price

    def test_season(self):
        import datetime as dt
        self.assertEqual(build_nfl.season_now(dt.date(2026, 11, 3)), 2026)
        self.assertEqual(build_nfl.season_now(dt.date(2027, 1, 20)), 2026)


if __name__ == "__main__":
    unittest.main()
