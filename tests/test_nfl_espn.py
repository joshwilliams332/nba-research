"""Tests for scripts/nfl_espn.py and the ESPN merge in build_nfl.py, on trimmed copies of real ESPN responses.
Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_nfl  # noqa: E402
import nfl_espn as E  # noqa: E402
from test_build_nfl import fake_fetch  # noqa: E402


def team(abbr):
    return {"abbreviation": abbr, "displayName": abbr}


def event(eid, week, away, home, state="pre", scores=(None, None), odds=None, date="2026-11-06T01:15Z"):
    comp = {"competitors": [
        {"homeAway": "home", "team": team(home), "score": scores[1], "records": [{"type": "total", "summary": "6-2"}]},
        {"homeAway": "away", "team": team(away), "score": scores[0], "records": [{"type": "total", "summary": "5-3"}]}],
        "status": {"type": {"state": state, "shortDetail": "Final" if state == "post" else "Q3 4:12"}},
        "venue": {"fullName": "M&T Bank Stadium", "indoor": False}, "odds": odds}
    return {"id": eid, "date": date, "season": {"year": 2026, "type": 2}, "week": {"number": week}, "competitions": [comp]}


DK = [{"provider": {"name": "DraftKings"}, "details": "BAL -9.5", "overUnder": 42.5, "spread": -9.5, "overOdds": -105,
       "underOdds": -115, "homeTeamOdds": {"moneyLine": -470, "spreadOdds": -110}, "awayTeamOdds": {"moneyLine": 360, "spreadOdds": -110}}]


def stats(**kv):
    return [{"name": k, "displayValue": v} for k, v in kv.items()]


SUMMARY = {
    "header": {"competitions": [{"competitors": [{"homeAway": "home", "team": team("IND")}, {"homeAway": "away", "team": team("JAX")}]}]},
    "pickcenter": [{"provider": {"name": "DraftKings"}, "details": "JAX -2.5", "overUnder": 45.5, "homeTeamOdds": {"moneyLine": 120}, "awayTeamOdds": {"moneyLine": -140}}],
    "boxscore": {
        "teams": [{"team": team("JAX"), "statistics": stats(completionAttempts="24/31", netPassingYards="310", sacksYardsLost="2-11",
                                                            thirdDownEff="5-11", redZoneAttempts="3-4", rushingAttempts="25", rushingYards="99",
                                                            firstDowns="22", interceptions="0", fumblesLost="1", totalYards="409", totalOffensivePlays="58")},
                  {"team": team("IND"), "statistics": stats(completionAttempts="20/30")}],
        "players": [{"team": team("JAX"), "statistics": [
            {"name": "passing", "labels": ["C/ATT", "YDS", "AVG", "TD", "INT", "SACKS", "QBR", "RTG"],
             "athletes": [{"athlete": {"id": "4360310", "displayName": "Trevor Lawrence", "headshot": {"href": "tl.png"}}, "stats": ["24/31", "320", "10.3", "2", "0", "2-11", "70", "120"]}]},
            {"name": "receiving", "labels": ["REC", "YDS", "AVG", "TD", "LONG", "TGTS"],
             "athletes": [{"athlete": {"id": "111", "displayName": "Brian Thomas Jr."}, "stats": ["6", "88", "14.7", "1", "40", "9"]},
                          {"athlete": {"id": "222", "displayName": "Unknown Guy"}, "stats": ["1", "5", "5", "0", "5", "3"]}]},
            {"name": "kicking", "labels": ["FG"], "athletes": [{"athlete": {"id": "9"}, "stats": ["2/2"]}]}]}]},
}
ROSTER = [{"week": "8", "gsis_id": "00-1", "espn_id": "4360310", "position": "QB", "full_name": "Trevor Lawrence", "team": "JAX", "status": "ACT"},
          {"week": "8", "gsis_id": "00-2", "espn_id": "111", "position": "WR", "full_name": "Brian Thomas", "team": "JAX", "status": "ACT"}]
INJURIES = {"injuries": [{"displayName": "Jacksonville Jaguars", "injuries": [
    {"status": "Questionable", "shortComment": "Thomas (ankle) was limited.", "details": {"type": "Ankle", "returnDate": "2026-11-09"},
     "athlete": {"id": None, "links": [{"href": "https://www.espn.com/nfl/player/_/id/111/brian-thomas-jr"}]}},
    {"status": "Active", "athlete": {"links": [{"href": "https://www.espn.com/nfl/player/_/id/4360310/x"}]}}]}]}


class ParseTest(unittest.TestCase):
    def test_line_home_number(self):
        line = E.parse_line(DK, "BAL", "JAX")
        self.assertEqual(line["home_spread"], -9.5)
        self.assertEqual((line["total"], line["home_ml"], line["away_ml"], line["book"]), (42.5, -470, 360, "DraftKings"))
        self.assertEqual(E.parse_line([dict(DK[0], details="JAX -3")], "BAL", "JAX")["home_spread"], 3.0)
        self.assertEqual(E.parse_line([dict(DK[0], details="WSH -1.5")], "WAS", "DAL")["home_spread"], -1.5)
        self.assertEqual(E.parse_line(None, "BAL", "JAX"), {})
        newer = [{"provider": {"name": "DraftKings"}, "details": "JAX -8.5", "overUnder": 42.5,
                  "moneyline": {"home": {"close": {"odds": "+320"}}, "away": {"close": {"odds": "-410"}}},
                  "pointSpread": {"home": {"close": {"line": "+8.5", "odds": "-108"}}, "away": {"open": {"odds": "EVEN"}}},
                  "total": {"over": {"close": {"line": "o42.5", "odds": "-110"}}, "under": {"current": {"odds": "-110"}}}}]
        line = E.parse_line(newer, "BAL", "JAX")
        self.assertEqual((line["home_spread"], line["home_ml"], line["away_ml"], line["home_spread_odds"], line["away_spread_odds"], line["under_odds"]),
                         (8.5, 320, -410, -108, 100, -110))

    def test_event(self):
        g = E.parse_event(event("401", 9, "JAX", "BAL", odds=DK))
        self.assertEqual(g["id"], "2026_09_JAX_BAL")
        self.assertEqual((g["date"], g["time"]), ("2026-11-05", "20:15"))   # Thursday night in ET
        self.assertIsNone(g["home_score"])
        self.assertEqual(g["home_spread"], -9.5)
        live = E.parse_event(event("401", 9, "JAX", "BAL", state="in", scores=("7", "10")))
        self.assertEqual((live["home_score"], live["live"]), (None, {"away": 7, "home": 10}))   # live isn't final
        final = E.parse_event(event("401", 9, "LAR", "WSH", state="post", scores=("20", "17")))
        self.assertEqual((final["id"], final["away_score"], final["home_score"]), ("2026_09_LA_WAS", 20, 17))
        pro = event("1", 4, "AFC", "NFC")
        pro["season"]["type"] = 3
        self.assertIsNone(E.parse_event(pro))

    def test_box(self):
        b = E.parse_box(SUMMARY)
        jax = b["teams"]["JAX"]
        self.assertEqual((jax["cmp"], jax["att"], jax["sk"], jax["third"], jax["rz"]), (24, 31, 2, [5, 11], [3, 4]))
        qb = b["players"]["4360310"]
        self.assertEqual((qb["cmp"], qb["att"], qb["pass_yds"], qb["pass_td"], qb["img"]), (24, 31, 320, 2, "tl.png"))
        self.assertEqual(b["players"]["111"]["tgt"], 9)
        self.assertNotIn("9", b["players"])                       # kickers aren't kept
        self.assertEqual(b["line"]["home_spread"], 2.5)            # JAX -2.5 at IND

    def test_injuries(self):
        inj = E.parse_injuries(INJURIES)
        self.assertEqual(list(inj), ["111"])                       # id from the link, Active skipped
        self.assertEqual(inj["111"]["st"], "Questionable")


class MergeTest(unittest.TestCase):
    def test_build_with_espn(self):
        boards = {8: {"events": [event("500", 8, "JAX", "IND", state="post", scores=("27", "20"), date="2026-10-25T17:00Z")]},
                  9: {"events": [event("401", 9, "JAX", "BAL", odds=DK)]}}

        def get(url):
            if "injuries" in url:
                return INJURIES
            if "summary" in url:
                return SUMMARY
            if "seasontype=2" in url:
                return boards.get(int(url.rsplit("week=", 1)[1]), {"events": []})
            return {"events": []}

        def fetch(path, cache=None):
            return ROSTER if path.startswith("weekly_rosters/") else fake_fetch(path, cache)

        with tempfile.TemporaryDirectory() as d:
            out, store = Path(d) / "out", Path(d) / "espn"
            build_nfl.build(out=out, season=2026, fetch=fetch, espn=store, espn_get=get)
            games = {g["id"]: g for g in json.loads((out / "games.json").read_text())}
            g = games["2026_09_JAX_BAL"]
            self.assertEqual((g["src"], g["eid"], g["home_spread"], g["book"], g["roof"]), ("espn", "401", -9.5, "DraftKings", "outdoors"))
            self.assertEqual(g["open"]["home_spread"], -9.5)
            self.assertEqual(g["home_implied"], 26.0)
            done = games["2026_08_JAX_IND"]
            self.assertEqual((done["away_score"], done["home_spread"]), (27, 2.5))   # closing line from the summary
            logs = json.loads((out / "logs.json").read_text())
            cols = logs["cols"]
            qb = next(r for r in logs["logs"]["00-1"] if r[1] == 8)
            self.assertEqual(qb[4 + cols.index("pass_yds")], 320)                  # ESPN replaced nflverse's 210
            wr = logs["logs"]["00-2"][0]
            self.assertEqual(wr[4 + cols.index("tgt_sh")], 0.75)                   # 9 of the team's 12 targets
            players = json.loads((out / "players.json").read_text())
            self.assertEqual(players["00-2"]["st"], "Questionable")
            self.assertNotIn("st", players["00-1"])                                # nflverse report replaced by ESPN's
            ts = json.loads((out / "teamstats.json").read_text())["JAX"][-1]
            self.assertEqual((ts["third"], ts["rz"], ts["pass_yds"]), ([5, 11], [3, 4], 310))
            self.assertTrue((store / "box" / "500.json").exists())
            # The line moves: a second run adds history and keeps the open.
            boards[9]["events"][0]["competitions"][0]["odds"] = [dict(DK[0], details="BAL -10.5")]
            build_nfl.build(out=out, season=2026, fetch=fetch, espn=store, espn_get=get)
            g = {g["id"]: g for g in json.loads((out / "games.json").read_text())}["2026_09_JAX_BAL"]
            self.assertEqual((g["open"]["home_spread"], g["home_spread"], len(g["lh"])), (-9.5, -10.5, 2))


if __name__ == "__main__":
    unittest.main()
