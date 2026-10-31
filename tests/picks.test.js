// Tests for saved-pick grading, payouts, summaries and import in site/assets/picks.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
// picks.js reads common.js helpers as browser globals.
Object.assign(global, C);
const P = require('../site/assets/picks.js');

const meta = { cols: ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'], season: 2027 };
const teams = { AAA: { conf: 'East', div: 'Atlantic' }, BBB: { conf: 'East', div: 'Central' } };
const game = (id, d, h, a, hs, as, extra = {}) => ({ id, d, t: `${d}T23:00Z`, s: 2027, st: 2, h, a, state: 'post', hs, as, ...extra });
const row = (gid, pts, reb) => [gid, 'AAA', 1, 32, pts, reb, 4, 2, 6, 7, 15, 3, 4, 1, 6, 1, 0, 2, 3, 5];

function lab() {
  const games = [
    game('1', '2026-10-20', 'AAA', 'BBB', 110, 100),
    game('2', '2026-10-22', 'BBB', 'AAA', 99, 101),
    game('3', '2026-10-28', 'AAA', 'BBB', null, null, { state: 'pre' }),
    game('4', '2026-10-27', 'AAA', 'BBB', 50, 48, { state: 'in', detail: 'Q3 5:00' }),
  ];
  const L = C.indexLab(meta, teams, games);
  L.logs = { p1: [row('1', 25, 9), row('2', 20, 8)] };
  L.players = { p1: { n: 'Pat One', t: 'AAA' } };
  return L;
}

const pick = (over = {}) => P.makePick({ gid: '1', pid: 'p1', stat: 'pts', side: 'o', line: 22.5, price: -120, book: 'draftkings', ...over });

test('payout at American odds', () => {
  assert.strictEqual(P.payout('win', 150, 1), 1.5);
  assert.strictEqual(P.payout('win', -125, 2), 1.6);
  assert.strictEqual(P.payout('loss', -125, 2), -2);
  assert.strictEqual(P.payout('push', -110, 1), 0);
  assert.strictEqual(P.payout('void', 200, 1), 0);
  // No price saved (typical line): -110 assumed.
  assert.ok(Math.abs(P.payout('win', null, 1) - 100 / 110) < 1e-9);
});

test('grading player props from the box score', () => {
  const L = lab();
  assert.strictEqual(P.gradePick(L, pick()).status, 'win');            // 25 > 22.5
  assert.strictEqual(P.gradePick(L, pick({ side: 'u' })).status, 'loss');
  assert.strictEqual(P.gradePick(L, pick({ gid: '2', line: 20 })).status, 'push');
  const pra = P.gradePick(L, pick({ gid: '2', stat: 'pra', line: 30.5 }));  // 20 + 8 + 4 = 32
  assert.deepStrictEqual([pra.status, pra.actual], ['win', 32]);
  assert.ok(Math.abs(P.gradePick(L, pick()).profit - 100 / 120) < 1e-9);
  assert.strictEqual(P.gradePick(L, pick({ gid: '3' })).status, 'open');
  assert.strictEqual(P.gradePick(L, pick({ gid: '4' })).status, 'live');
  // Final game, but the player has no row: void, stake returned.
  L.logs.p1 = L.logs.p1.slice(0, 1);
  const dnp = P.gradePick(L, pick({ gid: '2' }));
  assert.deepStrictEqual([dnp.status, dnp.profit], ['void', 0]);
  assert.strictEqual(P.gradePick(L, pick({ gid: '999' })).status, 'void');
});

test('grading team picks', () => {
  const L = lab();
  const team = (stat, side, line, t = 'AAA') => P.makePick({ gid: '1', team: t, stat, side, line, price: -110 });
  assert.strictEqual(P.gradePick(L, team('ml', 'h', 0)).status, 'win');
  assert.strictEqual(P.gradePick(L, team('ml', 'a', 0, 'BBB')).status, 'loss');
  assert.strictEqual(P.gradePick(L, team('spread', 'h', -9.5)).status, 'win');   // won by 10
  assert.strictEqual(P.gradePick(L, team('spread', 'h', -10)).status, 'push');
  assert.strictEqual(P.gradePick(L, team('total', 'u', 209.5)).status, 'loss');  // 210 total
});

test('summary: record, units, ROI and CLV', () => {
  const L = lab();
  L.proplines = { p1: { 1: { pts: { open: 22.5, close: 24.5 } } } };
  const graded = [pick(), pick({ side: 'u', price: 110 }), pick({ gid: '2', line: 20 }), pick({ gid: '3' })]
    .map(p => ({ pick: p, grade: P.gradePick(L, p) }));
  const s = P.summarize(graded);
  assert.deepStrictEqual([s.w, s.l, s.p, s.open], [1, 1, 1, 1]);
  assert.ok(Math.abs(s.profit - (Math.round((100 / 120 - 1) * 100) / 100)) < 1e-9);
  assert.strictEqual(s.risked, 2);
  // Closing line 24.5: over 22.5 gains 2 points, under 22.5 loses 2.
  assert.deepStrictEqual([graded[0].grade.clv, graded[1].grade.clv], [2, -2]);
  assert.strictEqual(s.clv, 0);
});

test('closing line lookups tolerate the older single-line format', () => {
  const L = lab();
  L.proplines = { p1: { 1: { pts: 22.5 } } };   // one pull a day: no close
  assert.strictEqual(P.closeLine(L, pick()), null);
  L.proplines = { p1: { 1: { pts: { cl: { l: 21.5 } } } } };
  assert.strictEqual(P.closeLine(L, pick()), 21.5);
  assert.strictEqual(P.clvPoints(pick(), 21.5), -1);
});

test('import validation and merging', () => {
  const a = pick(), b = pick({ gid: '2' });
  const { picks, skipped } = P.parseImport(P.exportPicks([a, b, { id: 'x', gid: '1' }]));
  assert.deepStrictEqual([picks.length, skipped], [2, 1]);
  // Base64 code round trip.
  const code = Buffer.from(P.exportPicks([a])).toString('base64');
  assert.strictEqual(P.parseImport(code).picks[0].id, a.id);
  assert.throws(() => P.parseImport('not a code!'), /valid/);
  assert.throws(() => P.parseImport('{"app":"other"}'), /export/);
  assert.strictEqual(P.validPick({ ...a, price: 5 }), false);        // not American odds
  assert.strictEqual(P.validPick({ ...a, stat: 'nope' }), false);
  const current = [a];
  assert.strictEqual(P.mergePicks(current, [a, b, P.makePick({ ...b })]), 1);  // same pick twice counts once
  assert.strictEqual(current.length, 2);
  assert.strictEqual(P.pickText(a), 'Over 22.5 Points');
});

test('parlay price from legs, and a profit boost on top', () => {
  assert.strictEqual(P.parlayPrice([{ price: -131 }, { price: -131 }]), 211);
  assert.strictEqual(P.parlayPrice([{ price: 100 }, { price: null }]), 282);   // a leg without a price counts as -110
  assert.strictEqual(P.boostedPrice(210, 50), 315);
  assert.strictEqual(P.boostedPrice(-200, 50), -133);                          // 0.5 profit -> 0.75 profit
  assert.strictEqual(P.boostedPrice(-131, 0), -131);
});

test('parlays: built from legs, validated, and graded like a sportsbook', () => {
  const L = lab();
  const leg = (over = {}) => ({ gid: '1', pid: 'p1', stat: 'pts', side: 'o', line: 22.5, price: -120, ...over });
  const par = (legs, extra = {}) => P.makeParlay({ legs, units: 1, ...extra });

  // Both legs hit (25 pts > 22.5, 20 pts < 22.5 under): win at the entered price, boosted.
  const both = par([leg(), leg({ gid: '2', side: 'u' })], { price: 210, boost: 50 });
  assert.ok(P.validPick(both));
  let g = P.gradePick(L, both);
  assert.strictEqual(g.status, 'win');
  assert.strictEqual(g.price, 315);
  assert.strictEqual(g.profit, 3.15);
  // No price given: worked out from the legs.
  assert.strictEqual(par([leg(), leg({ gid: '2', side: 'u' })]).price, P.parlayPrice([{ price: -120 }, { price: -120 }]));

  // One leg loses: the whole parlay loses, even with another leg still to play.
  g = P.gradePick(L, par([leg({ side: 'u' }), leg({ gid: '3' })]));
  assert.strictEqual(g.status, 'loss');
  assert.strictEqual(g.profit, -1);
  // Nothing lost yet but a leg to play: open (or live).
  assert.strictEqual(P.gradePick(L, par([leg(), leg({ gid: '3' })])).status, 'open');
  assert.strictEqual(P.gradePick(L, par([leg(), leg({ gid: '4' })])).status, 'live');

  // A leg voids (player didn't play): it drops out and the price is rebuilt from the rest.
  g = P.gradePick(L, par([leg({ price: 150 }), leg({ pid: 'nobody', name: 'X' })], { price: 400 }));
  assert.strictEqual(g.status, 'win');
  assert.strictEqual(g.price, 150);
  assert.ok(g.reduced);
  // Every leg pushes: push.
  assert.strictEqual(P.gradePick(L, par([leg({ line: 25 }), leg({ gid: '2', line: 20 })])).status, 'push');

  // Counted once in the record.
  const s = P.summarize([{ pick: both, grade: P.gradePick(L, both) }]);
  assert.deepStrictEqual([s.w, s.l], [1, 0]);
  // Invalid: one leg, or a bad leg.
  assert.ok(!P.validPick({ ...both, legs: [leg()] }));
  assert.ok(!P.validPick({ ...both, legs: [leg(), { ...leg(), stat: 'nope' }] }));
  // Round-trips through export / import.
  const back = P.parseImport(P.exportPicks([both]));
  assert.strictEqual(back.picks.length, 1);
});
