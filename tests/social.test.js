// Tests for the social posts script (scripts/social.js). Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../scripts/social.js');

// A candidate side as candidates() builds it (only the fields choosePicks reads).
const cand = (pid, gid, prob, edge, side = 'o') => ({ pr: { id: pid }, g: { id: gid }, prob, edge, side });

test('picks: biggest edge first, one side per player, at most two per game, thresholds respected', () => {
  const list = [
    cand('a', 'g1', 0.60, 0.10),
    cand('a', 'g1', 0.58, 0.09, 'u'),   // same player, other side: skipped
    cand('b', 'g1', 0.57, 0.08),
    cand('c', 'g1', 0.59, 0.07),        // third from g1: skipped
    cand('d', 'g2', 0.53, 0.20),        // chance below the bar: skipped
    cand('e', 'g2', 0.70, 0.02),        // edge below the bar: skipped
    cand('f', 'g2', 0.56, 0.05),
  ];
  assert.deepStrictEqual(S.choosePicks(list).map(c => c.pr.id), ['a', 'b', 'f']);
});

test('picks: never more than the nightly max', () => {
  const list = Array.from({ length: 12 }, (_, i) => cand(`p${i}`, `g${i}`, 0.6, 0.05 + i / 100));
  assert.strictEqual(S.choosePicks(list).length, S.PICK.max);
});

test('matchup is judged from the bet side', () => {
  assert.strictEqual(S.matchup({ side: 'o', oppRank: { rank: 3, of: 30 } }), 'favorable');
  assert.strictEqual(S.matchup({ side: 'u', oppRank: { rank: 3, of: 30 } }), 'unfavorable');
  assert.strictEqual(S.matchup({ side: 'u', oppRank: { rank: 28, of: 30 } }), 'favorable');
  assert.strictEqual(S.matchup({ side: 'o', oppRank: { rank: 15, of: 30 } }), 'neutral');
  assert.strictEqual(S.matchup({ side: 'o', oppRank: null }), 'neutral');
});

const pick = (name, side, line, stat = 'pts', price = -110) => ({ name, side, line, stat, price, why: 'Projected 12.1 vs the line.' });

test('slate post fits in 280 characters even with long names, dropping prices first', () => {
  const picks = ['Shai Gilgeous-Alexander', 'Giannis Antetokounmpo', 'Karl-Anthony Towns', 'Nickeil Alexander-Walker', 'Kentavious Caldwell-Pope']
    .map((n, i) => pick(n, i % 2 ? 'u' : 'o', 22.5, 'pts', -115));
  const post = S.slatePost('2026-10-28', 12, picks, { w: 41, l: 33, p: 1, profit: 4.3 });
  assert.ok(S.postLength(post.main) <= 280, `${S.postLength(post.main)}`);
  assert.match(post.main, /Season: 41-33-1 \(\+4\.3u\)/);
  assert.strictEqual(post.replies.length, 5);
  assert.ok(post.replies.every(r => S.postLength(r) <= 280));
});

test('a night with no picks still says so honestly', () => {
  const post = S.slatePost('2026-10-28', 4, [], null);
  assert.match(post.main, /No plays/);
  assert.deepStrictEqual(post.replies, []);
});

test('recap tone follows the result and marks voids', () => {
  const rows = [
    { pick: pick('A One', 'o', 10.5), grade: { status: 'win', actual: 14 } },
    { pick: pick('B Two', 'u', 5.5, 'reb'), grade: { status: 'loss', actual: 8 } },
    { pick: pick('C Three', 'o', 2.5, 'ast'), grade: { status: 'void' } },
  ];
  const good = S.recapPost('2026-10-27', [rows[0]], { w: 1, l: 0, p: 0, profit: 0.91 }, { w: 9, l: 4, p: 0, profit: 4.2 });
  assert.match(good.main, /^✅ 1-0 last night \(\+0\.9u\)/);
  const bad = S.recapPost('2026-10-27', rows, { w: 1, l: 4, p: 0, profit: -3.1 }, { w: 9, l: 8, p: 0, profit: 0.2 });
  assert.match(bad.main, /Rough one\. We'll bounce back\./);
  assert.match(bad.main, /➖ C Three O 2\.5 AST \(DNP, void\)/);
  assert.match(bad.main, /❌ B Two U 5\.5 REB \(8\)/);
  assert.ok(S.postLength(bad.main) <= 280);
});

test('post length counts emoji as two characters', () => {
  assert.strictEqual(S.postLength('ab'), 2);
  assert.strictEqual(S.postLength('a🏀'), 3);
});
