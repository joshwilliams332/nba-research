// Tests for the projection model (site/assets/model.js) and backtest helpers. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
const M = require('../site/assets/model.js');
const B = require('../scripts/backtest.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const COLS = ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'];

/* A small league: teams A, B, C. Player p1 (a guard on A) scores 1 point per minute in 30 minutes every game.
   A plays B and C alternately, one game a day from Nov 1. */
function league(nGames, extra = {}) {
  const games = [], logs = { p1: [], p2: [], p3: [] };
  const row = (gid, team, min, pts) => [gid, team, 1, min, pts, 5, 5, 2, 6, 10, 20, 4, 5, 1, 4, 1, 1, 2, 2, 0];
  for (let i = 0; i < nGames; i++) {
    const d = new Date(Date.UTC(2025, 10, 1 + i)).toISOString().slice(0, 10);
    const opp = i % 2 ? 'C' : 'B';
    const g = { id: `g${i}`, d, t: `${d}T23:00Z`, s: 2026, st: 2, h: 'A', a: opp, state: 'post', hs: 110, as: 100 };
    games.push(g);
    logs.p1.push(row(g.id, 'A', 30, 30));
    logs.p2.push(row(g.id, 'A', 30, extra.p2pts || 20));
    logs.p3.push(row(g.id, opp, 30, 20));
  }
  const L = C.indexLab({ cols: COLS, season: 2026 }, { A: {}, B: {}, C: {} }, games);
  L.players = { p1: { n: 'One', p: 'PG', t: 'A' }, p2: { n: 'Two', p: 'C', t: 'A' }, p3: { n: 'Three', p: 'SG', t: 'B' } };
  L.logs = logs;
  return L;
}

test('decay weights halve every half-life back from the newest', () => {
  const w = M.decayWeights(3, 1);
  assert.deepStrictEqual(w, [0.25, 0.5, 1]);
});

test('minutes lean on recent games', () => {
  const rows = [...Array(10).fill({ min: 20 }), { min: 36 }, { min: 36 }];
  const m = M.projectMinutes(rows);
  assert.ok(m > 20 && m < 36, `${m}`);
  assert.ok(m > (20 * 10 + 36 * 2) / 12, 'recent games count more than a plain average');
  assert.strictEqual(M.projectMinutes([]), null);
});

test('per-minute rate is pulled toward the prior on thin samples', () => {
  const rows = [{ min: 10, pts: 10, reb: 0, ast: 0 }];  // 1 point per minute in 10 minutes
  const r = M.perMinuteRate(rows, 'pts', 0.5);
  near(r, (10 + 100 * 0.5) / (10 + 100));
  near(M.perMinuteRate(rows, 'pts', null), 1);
});

test('line probabilities: Poisson and negative binomial add up, half-point lines never push', () => {
  const p = M.lineProbs(2, 1.5, 1);  // Poisson(2): P(X <= 1) = 3 e^-2
  near(p.under, 3 * Math.exp(-2));
  near(p.over + p.under + p.push, 1);
  assert.strictEqual(p.push, 0);
  const q = M.lineProbs(25, 25, 3);  // whole-number line: the push is P(X = 25)
  near(q.over + q.under + q.push, 1, 1e-9);
  assert.ok(q.push > 0 && q.push < 0.1);
  // More spread (phi) means less certainty: the over at a line well below the mean gets less likely.
  assert.ok(M.lineProbs(25, 19.5, 3).over < M.lineProbs(25, 19.5, 1).over);
  // A mean of 0 can't go over.
  assert.strictEqual(M.lineProbs(0, 0.5, 2).over, 0);
});

test('projection needs enough games and only uses games before tip-off', () => {
  const L = league(12);
  const rows = C.playerRows(L, 'p1');
  assert.strictEqual(M.project(L, 'p1', L.games[3], 'pts', rows), null);  // 3 earlier games
  const pj = M.project(L, 'p1', L.games[11], 'pts', rows);
  assert.strictEqual(pj.games, 11);
  near(pj.min, 30);
  // Same team pace both sides and the defense allows the league average: about 1 point per minute x 30.
  assert.ok(Math.abs(pj.mean - 30) < 1.5, `${pj.mean}`);
});

test('a later game never changes an earlier projection (no peeking)', () => {
  const L1 = league(12), L2 = league(12);
  // Change what happened in the last game: projections for game 10 must not move.
  L2.logs.p1[11][4] = 60;
  L2.logs.p3[11][4] = 80;
  const a = M.project(L1, 'p1', L1.games[10], 'pts');
  const b = M.project(L2, 'p1', L2.games[10], 'pts');
  near(a.mean, b.mean);
});

test('a defense that allows more to a position raises the projection, shrunk toward average', () => {
  // p1 is a guard on A, p2 a center. Against C, p1 scores 45 instead of 30.
  const L = league(40);
  L.logs.p1.forEach((r, i) => { if (i % 2) r[4] = 45; });  // vs C, guards score 45 instead of 30
  const f = M.defenseFactor(L, 'C', 'G', 'pts', L.games[39].t);
  assert.ok(f.f > 1, `${f.f}`);
  assert.ok(f.f < f.raw, 'shrunk toward 1');
  // A's defense only faces p3 (20 a game), so the league average sits below B's 30: compare B with C instead.
  const fb = M.defenseFactor(L, 'B', 'G', 'pts', L.games[39].t);
  assert.ok(fb.f < f.f);
  // Centers: A's center scores 20 against both, so B and C rate the same against centers.
  near(M.defenseFactor(L, 'C', 'C', 'pts', L.games[39].t).raw, M.defenseFactor(L, 'B', 'C', 'pts', L.games[39].t).raw);
});

test('projectLine leans to the likelier side', () => {
  const L = league(12);
  const pj = M.projectLine(L, 'p1', L.games[11], 'pts', 24.5);
  assert.strictEqual(pj.side, 'o');
  assert.ok(pj.over > 0.5 && pj.gap > 0);
  near(pj.over + pj.under + pj.push, 1);
  const pu = M.projectLine(L, 'p1', L.games[11], 'pts', 35.5);
  assert.strictEqual(pu.side, 'u');
});

test('backtest helpers: dispersion fit and calibration bins', () => {
  // Errors of +-2 around a mean of 4: variance 4 / mean 4 = 1 (Poisson-like).
  near(B.fitPhi([{ y: 6, mu: 4 }, { y: 2, mu: 4 }]), 1);
  // Never below 1 (the negative binomial can't be tighter than Poisson).
  near(B.fitPhi([{ y: 4, mu: 4 }]), 1);
  const cal = B.calibration([{ pOver: 0.05, over: 0 }, { pOver: 0.62, over: 1 }, { pOver: 0.68, over: 0 }]);
  assert.deepStrictEqual(cal.map(b => [b.lo, b.n, b.actual]), [[0, 1, 0], [0.6, 2, 0.5]]);
  const l = B.leans([{ pOver: 0.7, over: 1 }, { pOver: 0.3, over: 1 }, { pOver: 0.52, over: 0 }]);
  assert.deepStrictEqual([l[0].n, l[0].hits, l[0].under], [2, 1, 0]);
});
