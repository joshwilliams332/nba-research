"""Tests for scripts/build_nfl.py (NFL Lab data copied from Mingus Football). Run: python3 -m unittest discover -s tests"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_nfl  # noqa: E402


def write(d, name, value):
    (Path(d) / f"{name}.json").write_text(json.dumps(value))


class BuildNflTest(unittest.TestCase):
    def setUp(self):
        self.src = tempfile.mkdtemp()
        self.out = Path(tempfile.mkdtemp()) / "nfl"
        write(self.src, "meta", {"season": 2026, "next_week": 9})
        write(self.src, "games", [{"id": "2026_09_JAX_BAL", "week": 9, "date": "2026-11-05", "time": "20:15", "away": "JAX",
                                   "home": "BAL", "home_spread": 9.5, "total": 42.5, "coords": [1, 2], "surface": "grass"}])
        write(self.src, "teams", {"JAX": {"nickname": "Jaguars"}, "BAL": {"nickname": "Ravens"}})
        write(self.src, "teamstats", {"JAX": [], "BAL": []})

    def test_copies_and_slims(self):
        msg = build_nfl.build(self.src, self.out)
        self.assertIn("1 games (0 final)", msg)
        games = json.loads((self.out / "games.json").read_text())
        self.assertEqual(games[0]["total"], 42.5)
        self.assertNotIn("coords", games[0])          # fields NFL Lab doesn't use are dropped
        self.assertIn("home_ml", games[0])            # missing fields come through as null
        self.assertTrue((self.out / "teamstats.json").exists())

    def test_rejects_a_changed_shape(self):
        write(self.src, "games", [{"id": "x"}])
        with self.assertRaises(ValueError):
            build_nfl.build(self.src, self.out)


if __name__ == "__main__":
    unittest.main()
