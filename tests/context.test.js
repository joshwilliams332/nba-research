// Tests for pace, implied totals and fair prices in site/assets/context.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
const X = require('../site/assets/context.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('implied team totals split the total by the spread', () => {
  // Home favored by 4.5 with a 237.5 total: home 121, away 116.5
  assert.deepStrictEqual(X.impliedTotals({ tot: 237.5, sp: -4.5 }), { h: 121, a: 116.5 });
  assert.deepStrictEqual(X.impliedTotals({ tot: 220, sp: 3 }), { h: 108.5, a: 111.5 });
  assert.strictEqual(X.impliedTotals({ sp: -2 }), null);
});

test('slate ranks implied totals across the day', () => {
  const L = C.indexLab({ cols: [], season: 2027 }, { A: {}, B: {}, C: {}, D: {} }, [
    { id: '1', d: '2026-10-28', t: '2026-10-28T23:00Z', s: 2027, h: 'A', a: 'B', state: 'pre', line: { tot: 230, sp: -6 } },
    { id: '2', d: '2026-10-28', t: '2026-10-28T23:30Z', s: 2027, h: 'C', a: 'D', state: 'pre', line: { tot: 240, sp: 2 } },
  ]);
  const s = X.slateImplied(L, '2026-10-28');
  assert.deepStrictEqual(Object.keys(s).sort((x, y) => s[x].rank - s[y].rank), ['D', 'C', 'A', 'B']);
  assert.deepStrictEqual([s.D.pts, s.D.rank, s.D.of], [121, 1, 4]);
});

test('odds conversions', () => {
  near(X.impliedProb(-110), 110 / 210);
  near(X.impliedProb(150), 0.4);
  near(X.decimalOdds(-200), 1.5);
  near(X.decimalOdds(120), 2.2);
  assert.strictEqual(X.americanFrom(0.5), -100);
  assert.strictEqual(X.americanFrom(0.6), -150);
  assert.strictEqual(X.americanFrom(0.4), 150);
});

test('fair price removes the vig and finds the best price', () => {
  // -110 / -110 at two books is a fair 50/50; a third book at +115 / -140 pulls the consensus under 50%,
  // and its +115 over still pays about 3.5% more than fair.
  const f = X.fairPrice({ l: 24.5, books: { draftkings: [24.5, -110, -110], fanduel: [24.5, -110, -110], betmgm: [24.5, 115, -140], caesars: [25.5, 120, -150] } });
  assert.strictEqual(f.books, 3); // the 25.5 book is a different line
  const mgm = (100 / 215) / (100 / 215 + 140 / 240);
  near(f.fairO, (0.5 + 0.5 + mgm) / 3);
  assert.strictEqual(f.bestO.book, 'betmgm');
  assert.strictEqual(f.bestO.price, 115);
  near(f.bestO.ev, f.fairO * 2.15 - 1);
  assert.strictEqual(f.ev, 'o');
  assert.strictEqual(X.fairPrice({ l: 10.5, books: { draftkings: [9.5, -110, -110] } }), null);
});

test('no EV flag when every book is the same', () => {
  const f = X.fairPrice({ l: 5.5, books: { draftkings: [5.5, -115, -105], fanduel: [5.5, -115, -105] } });
  assert.strictEqual(f.ev, null);
  near(f.fairO + f.fairU, 1);
});

test('pace comes from box totals', () => {
  assert.strictEqual(X.possessions({ fga: 88, oreb: 10, tov: 14, fta: 25 }), 88 - 10 + 14 + 11);
  const meta = { cols: ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'], season: 2027 };
  const L = C.indexLab(meta, { A: {}, B: {} }, [
    { id: '1', d: '2026-10-20', t: '2026-10-20T23:00Z', s: 2027, st: 2, h: 'A', a: 'B', state: 'post', hs: 110, as: 100 },
  ]);
  // One row per team carrying the team's totals: A 100 poss (90-10+14+0.44*... ), B 96
  const row = (team, fga, oreb, tov, fta) => ['1', team, 1, 240, 0, 0, 0, 0, 0, 0, fga, 0, fta, oreb, 0, 0, 0, tov, 0, 0];
  L.logs = { a: [row('A', 90, 10, 15, 25)], b: [row('B', 85, 9, 12, 20)] };
  const t = X.teamBoxTotals(L).get('1');
  const poss = ((90 - 10 + 15 + 11) + (85 - 9 + 12 + 8.8)) / 2;
  near(t.A.poss, poss);
  near(t.A.pace, poss); // 240 team minutes = 48-minute game
  const p = X.teamPace(L, { season: 2027 });
  near(p.A.pace, poss);
  assert.strictEqual(p.A.games, 1);
});
