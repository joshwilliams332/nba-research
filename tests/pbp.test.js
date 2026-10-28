// Tests for the play-by-play helpers in site/assets/pbp.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
// pbp.js extends the page's STATS / STAT_ORDER globals, as it does in the browser.
global.STATS = C.STATS;
global.STAT_ORDER = [];
const P = require('../site/assets/pbp.js');

test('period stats read from attached play-by-play and skip rows without it', () => {
  const L = { periods: { games: { p1: { g1: [7, 2, 1, 1, 15, 4, 3, 2] } } } };
  const rows = P.attachPeriods(L, 'p1', [{ gid: 'g1' }, { gid: 'g2' }]);
  assert.strictEqual(C.STATS.q1pts.f(rows[0]), 7);
  assert.strictEqual(C.STATS.h1fg3m.f(rows[0]), 2);
  assert.strictEqual(rows[1].per, undefined);
  assert.ok(global.STAT_ORDER.includes('h1pts'));
});

test('zone rows: per-game numbers, league comparison and defense ranks', () => {
  // six zones of [attempts, makes], then games, then (defense only) six ranks
  const player = [20, 14, 10, 2, 10, 4, 4, 2, 2, 0, 30, 12, 10];
  const league = [100, 65, 100, 42, 100, 41, 100, 39, 100, 39, 100, 36];
  const z = P.zoneRows(player, league);
  assert.strictEqual(z[0].zone, 'ra');
  assert.strictEqual(z[0].perGame, 2);
  assert.strictEqual(z[0].pct, 0.7);
  assert.strictEqual(z[5].ptsPerGame, 3.6);  // 12 threes in 10 games
  assert.strictEqual(z[0].rank, null);
  const def = P.zoneRows([...player, 3, 8, 15, 30, 1, 22], league);
  assert.deepStrictEqual(def.map(x => x.rank), [3, 8, 15, 30, 1, 22]);
  assert.match(P.zoneColor(z[0]), /42,211,139/);  // 70% vs 65% league: better
  assert.match(P.zoneColor(z[1]), /255,92,108/);  // 20% vs 42%: worse
  assert.match(P.zoneColor(z[2]), /242,193,78/);  // 40% vs 41%: about average
});
