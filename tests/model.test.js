// Tests for the projection model in site/assets/model.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
const M = require('../site/assets/model.js');

const meta = { cols: ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'], season: 2027 };
const teams = { AAA: { conf: 'East', div: 'Atlantic' }, BBB: { conf: 'East', div: 'Central' } };
const game = (id, d, h, a, extra = {}) => ({ id, d, t: `${d}T23:00Z`, s: 2027, st: 2, h, a, state: 'post', hs: 110, as: 100, ...extra });

test('over/under chances are complementary, monotone in the line, and sensible around the mean', () => {
  const m = 20, disp = 2;
  const o19 = M.probOver(19.5, m, disp), o20 = M.probOver(20.5, m, disp), o25 = M.probOver(25.5, m, disp);
  assert.ok(o19 > o20 && o20 > o25);
  assert.ok(Math.abs(M.probOver(20.5, m, disp) + M.probUnder(20.5, m, disp) - 1) < 1e-9);  // no push on a half line
  assert.ok(o19 > 0.45 && o19 < 0.65);
  assert.ok(M.probOver(0.5, 0.3, 1.1) < 0.3);   // rare event: a low-count stat rarely clears 0.5
});

test('calibration buckets and Brier score', () => {
  const preds = [{ p: 0.05, hit: false }, { p: 0.15, hit: true }, { p: 0.62, hit: true }, { p: 0.68, hit: false }, { p: 0.99, hit: true }];
  const c = M.calibration(preds);
  assert.strictEqual(c.length, 10);
  assert.deepStrictEqual([c[0].n, c[1].n, c[6].n, c[9].n], [1, 1, 2, 1]);
  assert.ok(Math.abs(c[6].pred - 0.65) < 1e-9);
  assert.strictEqual(c[6].actual, 0.5);
  assert.strictEqual(c[3].pred, null);
  assert.ok(Math.abs(M.brier([{ p: 0.5, hit: true }, { p: 0.5, hit: false }]) - 0.25) < 1e-9);
});

test('projection tracks a steady player and needs enough games', () => {
  // 30 games: AAA hosts BBB every other day; the player always plays 30 minutes and scores 20.
  const games = Array.from({ length: 31 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, 1 + i * 2)).toISOString().slice(0, 10);
    return game(String(i + 1), d, i % 2 ? 'AAA' : 'BBB', i % 2 ? 'BBB' : 'AAA', i === 30 ? { state: 'pre', hs: undefined, as: undefined } : {});
  });
  const L = C.indexLab(meta, teams, games);
  const row = (gid, team, pts) => [gid, team, 1, 30, pts, 6, 4, 2, 5, 7, 15, 4, 5, 1, 5, 1, 0, 2, 2, 3];
  L.players = { p1: { n: 'Steady Guy', t: 'AAA', p: 'G' }, opp1: { n: 'Other', t: 'BBB', p: 'G' } };
  L.logs = {
    p1: games.slice(0, 30).map(g => row(g.id, 'AAA', 20)),
    opp1: games.slice(0, 30).map(g => row(g.id, 'BBB', 20)),
  };
  L.injuries = [];
  const next = games[30];
  const pr = M.project(L, 'p1', 'pts', next, { absent: [] });
  assert.ok(pr, 'projects with 30 prior games');
  assert.ok(Math.abs(pr.minutes - 30) < 1e-6);
  assert.ok(pr.mean > 17 && pr.mean < 23, `mean ${pr.mean}`);   // ~20, nudged only by capped opponent / pace factors
  assert.ok(pr.over(15.5) > 0.7 && pr.under(25.5) > 0.7);
  // Too few games: no projection.
  const early = M.project(L, 'p1', 'pts', games[3], { absent: [] });
  assert.strictEqual(early, null);
  // Period stats aren't projected.
  assert.strictEqual(M.project(L, 'p1', 'nope', next), null);
});
