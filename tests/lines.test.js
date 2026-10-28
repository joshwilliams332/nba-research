// Tests for line movement and closing line value in site/assets/lines.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
// lines.js uses these page globals for its labels.
Object.assign(global, { odds: C.odds, signed: C.signed, esc: s => String(s) });
const M = require('../site/assets/lines.js');

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('no-vig over probability removes the margin', () => {
  assert.ok(near(M.noVigOver(-110, -110), 0.5));
  assert.ok(near(M.oddsProb(-150), 0.6));
  assert.ok(near(M.noVigOver(-150, 130), 0.6 / (0.6 + 100 / 230)));
  assert.strictEqual(M.noVigOver(null, -110), null);
});

test('prop movement from the morning to the pre-tip pull', () => {
  const p = { open: [24.5, -110, -110, 'draftkings'], close: [25.5, -115, -105, 'draftkings'] };
  const m = M.propMove(p);
  assert.strictEqual(m.dl, 1);
  assert.ok(m.dp > 0 && m.sameBook);
  assert.match(M.moveTag(p), /24\.5 → 25\.5 ↑/);
  // Price-only move toward the under
  const q = { open: [7.5, -110, -110, 'fanduel'], close: [7.5, 120, -145, 'fanduel'] };
  assert.match(M.moveTag(q), /O -110 → \+120 ↓/);
  // Nothing to compare, or no real move
  assert.strictEqual(M.propMove({ open: [1, -110, -110] }), null);
  assert.strictEqual(M.moveTag({ open: [3.5, -110, -110], close: [3.5, -112, -108] }), '');
});

test('game line movement lists only what changed', () => {
  const g = { h: 'IND', a: 'PHI', open: { sp: 3.5, tot: 235.5 }, line: { sp: 4.5, tot: 235.5 } };
  assert.match(M.gameMove(g), /Spread opened PHI -3\.5, now PHI -4\.5/);
  assert.doesNotMatch(M.gameMove(g), /Total/);
  assert.strictEqual(M.gameMove({ h: 'A', a: 'B', line: { sp: 1 } }), '');
});

test('closing line value in points and no-vig probability', () => {
  // Over 24.5 when it closed 25.5: one point better.
  assert.deepStrictEqual(M.clv({ line: 24.5, price: -110, side: 'o' }, [25.5, -110, -110]), { points: 1, prob: null });
  // Under at the same line: closed with the under at a fair 60%, we paid -110 (52.4%) -> +7.6 points of probability.
  const c = M.clv({ line: 7.5, price: -110, side: 'u' }, [7.5, 150, -150]);
  assert.strictEqual(c.points, 0);
  assert.ok(near(c.prob, (1 - M.noVigOver(150, -150)) - 110 / 210));
  assert.strictEqual(M.clv({ line: 1, price: 100, side: 'o' }, null), null);
});
