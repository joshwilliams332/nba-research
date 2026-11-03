// Tests for NFL Lab's logic in site/assets/nfl.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
Object.assign(global, require('../site/assets/common.js'));
const F = require('../site/assets/nfl.js');

const teams = { AAA: { nickname: 'Aces' }, BBB: { nickname: 'Bees' }, CCC: { nickname: 'Cees' } };
const game = (id, week, away, home, as, hs, extra = {}) => ({ id, week, type: 'REG', date: `2026-09-${String(week * 7).padStart(2, '0')}`,
  time: '13:00', away, home, away_score: as, home_score: hs, home_spread: -3, total: 44.5, away_ml: 130, home_ml: -150, ...extra });
const games = [
  game('g1', 1, 'BBB', 'AAA', 17, 24),            // AAA wins by 7 at home (covers -3), total 41 (under 44.5)
  game('g2', 2, 'AAA', 'CCC', 20, 21),            // AAA loses by 1 on the road
  game('g3', 3, 'CCC', 'AAA', 10, 30),            // AAA wins by 20, total 40
  game('g4', 4, 'BBB', 'AAA', null, null, { home_spread: -6.5, total: 40.5 }),   // upcoming
];
const box = (week, opp, extra = {}) => ({ week, opp, att: 30, sk: 2, car: 25, pass_yds: 220, rush_yds: 110, fd: 20, int: 1, fl: 0, ...extra });
const teamstats = {
  AAA: [box(1, 'BBB', { pass_yds: 300 }), box(2, 'CCC'), box(3, 'CCC', { int: 0 })],
  BBB: [box(1, 'AAA', { sk: 4 })],
  CCC: [box(2, 'AAA'), box(3, 'AAA', { rush_yds: 50 })],
};
const N = F.nflLab({ season: 2026 }, games, teams, teamstats);

test('sides, records and the current week', () => {
  assert.strictEqual(F.nflRecord(N, 'AAA'), '2-1');
  assert.strictEqual(F.nflRecord(N, 'AAA', N.byId.get('g2').t), '1-0');   // only games before kickoff
  assert.strictEqual(F.nflCurrentWeek(N), 4);
  const s = F.nflSide(N.byId.get('g1'), 'BBB');
  assert.deepStrictEqual([s.pts, s.oppPts, s.margin, s.total, s.win, s.spread], [17, 24, -7, 41, false, 3]);
});

test("windows judge past games against THIS game's number", () => {
  const g = N.byId.get('g4');
  // AAA at -6.5: margins +7, -1, +20 -> covers 2 of 3.
  const sp = F.nflWindows(N, g, 'AAA', 'spread');
  assert.strictEqual(sp.num, -6.5);
  assert.deepStrictEqual([sp.l10.hits, sp.l10.n], [2, 3]);
  // H2H vs BBB: just week 1 (won by 7, covers -6.5).
  assert.deepStrictEqual([sp.h2h.hits, sp.h2h.n], [1, 1]);
  // Totals vs 40.5: 41 over, 41 over, 40 under.
  const ov = F.nflWindows(N, g, 'AAA', 'over');
  assert.deepStrictEqual([ov.l10.hits, ov.l10.n], [2, 3]);
  const ml = F.nflWindows(N, g, 'BBB', 'ml');
  assert.deepStrictEqual([ml.l10.hits, ml.l10.n], [0, 1]);
});

test('team rankings: offense and defense per game, turnovers and sacks flipped', () => {
  const R = F.nflRanks(N);
  assert.strictEqual(R.of, 3);
  assert.ok(Math.abs(R.totals.AAA.off.pts - 74 / 3) < 1e-9);
  assert.ok(Math.abs(R.totals.AAA.def.pts - 48 / 3) < 1e-9);
  assert.strictEqual(R.totals.AAA.off.yds, (410 + 330 + 330) / 3);
  // Defense rushing allowed: AAA allowed 110, 110, 50 -> best (fewest) of the three teams.
  assert.strictEqual(R.ranks.AAA.def.rush, 1);
  // Offensive turnovers: AAA 2 in 3 games; BBB and CCC 1 a game -> AAA (fewest) ranks 1st.
  assert.strictEqual(R.ranks.AAA.off.to, 1);
  // Defensive sacks: BBB's opponent (AAA, week 1) took 2; AAA's opponents took 4, 2, 2 -> AAA's defense ranks 1st.
  assert.strictEqual(R.ranks.AAA.def.sk, 1);
});

test('common opponents leave out the two teams themselves', () => {
  const c = F.nflCommonOpponents(N, 'AAA', 'BBB');
  assert.deepStrictEqual(c.map(x => x.opp), []);
  const c2 = F.nflCommonOpponents(N, 'BBB', 'CCC');
  assert.deepStrictEqual(c2.map(x => [x.opp, x.a.length, x.b.length]), [['AAA', 1, 2]]);
});

test('kickoff label', () => {
  assert.match(F.nflKick({ date: '2026-11-05', time: '20:15' }), /Nov 5 · 8:15 PM$/);
  assert.match(F.nflKick({ date: '2026-11-08', time: '09:30' }), /9:30 AM$/);
});
