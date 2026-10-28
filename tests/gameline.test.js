// Tests for the game-line breakdown in site/assets/gameline.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
const G = require('../site/assets/gameline.js');

const meta = { cols: ['min', 'pts'], season: 2027 };
const teams = { AAA: { conf: 'East', div: 'Atlantic' }, BBB: { conf: 'East', div: 'Central' }, CCC: { conf: 'West', div: 'Pacific' } };
const day = i => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
const game = (id, d, h, a, hs, as, extra = {}) => ({ id, d, t: `${d}T23:00Z`, s: 2027, st: 2, h, a, state: 'post', hs, as, ...extra });

test('normal CDF', () => {
  assert.ok(Math.abs(G.normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(G.normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(G.normCdf(-1) - 0.1587) < 1e-3);
});

test('estimate: a team that scores more and allows less is favored, home edge applies', () => {
  // AAA beats CCC 120-100 ten times; BBB beats CCC 110-105 ten times. Then AAA hosts BBB.
  const games = [];
  for (let i = 0; i < 10; i++) {
    games.push(game(`a${i}`, day(i), 'AAA', 'CCC', 120, 100));
    games.push(game(`b${i}`, day(i), 'BBB', 'CCC', 110, 105));
  }
  const next = game('n', day(20), 'AAA', 'BBB', null, null, { state: 'pre', hs: undefined, as: undefined, line: { sp: -5.5, tot: 220.5, mlh: -220, mla: 180 } });
  games.push(next);
  const L = C.indexLab(meta, teams, games);
  const e = G.gameEstimate(L, next);
  // AAA: (120 + 105) / 2 + 0.8 = 113.3; BBB: (110 + 100) / 2 - 0.8 = 104.2
  assert.ok(Math.abs(e.home - 113.3) < 1e-9 && Math.abs(e.away - 104.2) < 1e-9);
  assert.ok(e.winH > 0.7 && e.winH < 0.8);
  const ml = G.sideChance(e, next.line, 'ml', 'a');
  assert.ok(Math.abs(ml + e.winH - 1) < 1e-12);
  assert.ok(G.sideChance(e, next.line, 'spread', 'h') > 0.5);           // margin 9.1 vs -5.5
  assert.strictEqual(G.sideChance(e, {}, 'spread', 'h'), null);
  // Too few games: no estimate.
  assert.strictEqual(G.gameEstimate(C.indexLab(meta, teams, [next]), next), null);
});

test('side numbers, results and windows are judged against tonight\'s line', () => {
  const games = [
    game('1', day(1), 'AAA', 'BBB', 110, 100, { line: { sp: -3, tot: 205 } }),
    game('2', day(3), 'CCC', 'AAA', 104, 101),
    game('3', day(5), 'AAA', 'CCC', 99, 98),
  ];
  const next = game('n', day(8), 'BBB', 'AAA', null, null, { state: 'pre', hs: undefined, as: undefined, line: { sp: 2.5, tot: 210.5 } });
  const L = C.indexLab(meta, teams, [...games, next]);
  assert.strictEqual(G.sideNumber(next, 'spread', 'a'), -2.5);        // AAA (away) is -2.5
  assert.strictEqual(G.sideNumber(next, 'spread', 'h'), 2.5);
  assert.strictEqual(G.sideNumber(next, 'total', 'o'), 210.5);
  assert.strictEqual(G.sideTeam(next, 'spread', 'a'), 'AAA');
  const w = G.sideWindows(L, next, 'AAA');
  assert.deepStrictEqual(w.l5.map(s => s.g.id), ['1', '2', '3']);
  assert.deepStrictEqual(w.h2h.map(s => s.g.id), ['1']);
  assert.deepStrictEqual(G.sideResults(w.l5, 'ml', 'a'), ['hit', 'miss', 'hit']);
  assert.deepStrictEqual(G.sideResults(w.l5, 'spread', 'a', -2.5), ['hit', 'miss', 'miss']);  // won by 10, lost by 3, won by 1
  assert.deepStrictEqual(G.sideResults(w.l5, 'total', 'u', 210.5), ['hit', 'hit', 'hit']);
  assert.deepStrictEqual(G.sideWindows(L, next, 'AAA', { loc: 'away' }).l5.map(s => s.g.id), ['2']);
});

test('line moves come from the stored history, or open vs current', () => {
  assert.deepStrictEqual(G.lineMoves({ lh: [['2026-10-28T15:37Z', -4.5, 236.5, -190, 160], ['2026-10-28T21:37Z', -5.5, 236.5, -210, 175]] }).map(p => p.sp), [-4.5, -5.5]);
  assert.deepStrictEqual(G.lineMoves({ open: { sp: -3 }, line: { sp: -4 } }).map(p => p.sp), [-3, -4]);
  assert.deepStrictEqual(G.lineMoves({ open: { sp: -3 }, line: { sp: -3 } }).map(p => p.sp), [-3]);  // no change
  assert.deepStrictEqual(G.lineMoves({}), []);
});
