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

// A small team for the teammate rules: big man "c" plays 30 min with "w" (another big) and grabs 8 rebounds;
// in games "w" sits, "c" plays 36 and grabs 13.
function bigs(nWith, nWithout) {
  const C = require('../site/assets/common.js');
  const cols = ['min', 'pts', 'reb'];
  const games = [], logs = { c: [], w: [] };
  for (let i = 0; i < nWith + nWithout; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    games.push({ id: `g${i}`, d, t: `${d}T23:00Z`, s: 2027, st: 2, h: 'POR', a: 'MEM', state: 'post', hs: 100, as: 90 });
    const without = i >= nWith;
    logs.c.push([`g${i}`, 'POR', 1, without ? 36 : 30, 10, without ? 13 : 8]);
    if (!without) logs.w.push([`g${i}`, 'POR', 0, 20, 6, 6]);
  }
  const L = C.indexLab({ cols, season: 2027, today: '2026-10-29' }, { POR: {}, MEM: {} }, games);
  L.players = { c: { n: 'Donovan Clingan', t: 'POR', p: 'C' }, w: { n: 'Robert Williams III', t: 'POR', p: 'C' } };
  L.logs = logs;
  return { L, C, rows: C.playerRows(L, 'c') };
}

test('teammate rules: an uncertain rotation teammate blocks the pick; an out one only if the split goes against it', () => {
  const { L, rows } = bigs(10, 6);
  // Day-to-day on the report, but the note says doubtful: role is uncertain, skip.
  L.injuries = [{ id: 'w', t: 'POR', st: 'Day-To-Day', det: "Williams (knee) is doubtful for Thursday's game" }];
  let mates = S.keyMates(L, 'c', 'POR');
  assert.deepStrictEqual(mates.map(m => [m.id, m.st]), [['w', 'Doubtful']]);
  assert.match(S.mateProblem(L, 'c', 'reb', 10.5, 'u', rows, mates), /doubtful/);
  // Out: the under 10.5 hit 0 of 6 without him -> skip; the over is fine.
  L.injuries = [{ id: 'w', t: 'POR', st: 'Out', det: '' }];
  mates = S.keyMates(L, 'c', 'POR');
  assert.match(S.mateProblem(L, 'c', 'reb', 10.5, 'u', rows, mates), /under hit 0 of 6 without Robert Williams III/);
  assert.strictEqual(S.mateProblem(L, 'c', 'reb', 10.5, 'o', rows, mates), null);
  // Too few games without him to judge: no block.
  const few = bigs(12, 3);
  few.L.injuries = [{ id: 'w', t: 'POR', st: 'Out', det: '' }];
  assert.strictEqual(S.mateProblem(few.L, 'c', 'reb', 10.5, 'u', few.rows, S.keyMates(few.L, 'c', 'POR')), null);
});

test('heads-up check: notes a teammate status change after the lock, and clears when nothing changed', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { L } = bigs(10, 0);
  L.games.push({ id: 'tonight', d: '2026-10-29', t: '2026-10-29T23:00Z', s: 2027, st: 2, h: 'POR', a: 'MEM', state: 'pre' });
  L.byId.set('tonight', L.games[L.games.length - 1]);
  L.props = { games: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  const pick = { id: 'x', gid: 'tonight', pid: 'c', name: 'Donovan Clingan', team: 'POR', stat: 'reb', side: 'u', line: 10.5, price: -106, mates: {} };
  fs.writeFileSync(path.join(dir, '2026-10-29.json'), JSON.stringify({ picks: [pick], email: { subject: 'S', html: '<p>post</p>', text: 'post' } }));
  L.injuries = [];
  assert.strictEqual(S.checkPicks(L, dir, Date.now()).state, 'clear');
  assert.ok(!fs.existsSync(path.join(dir, '2026-10-29-check.json')));
  L.injuries = [{ id: 'w', t: 'POR', st: 'Out', det: '' }];
  assert.strictEqual(S.checkPicks(L, dir, Date.now()).state, 'heads-up');
  const check = JSON.parse(fs.readFileSync(path.join(dir, '2026-10-29-check.json'), 'utf8'));
  assert.match(check.notes[0], /Robert Williams III \(POR\) is now out/);
  assert.match(check.email.html, /Heads up before you post/);
test('the season record skips days before the record start (the unposted test night)', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const C = require('../site/assets/common.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  const L = C.indexLab({ cols: ['min', 'pts'], season: 2027 }, { A: {}, B: {} }, [
    { id: 'g1', d: '2026-10-28', t: '2026-10-28T23:00Z', s: 2027, st: 2, h: 'A', a: 'B', state: 'post', hs: 100, as: 90 },
    { id: 'g2', d: '2026-10-29', t: '2026-10-29T23:00Z', s: 2027, st: 2, h: 'A', a: 'B', state: 'post', hs: 100, as: 90 },
  ]);
  L.players = { p: { n: 'P', t: 'A' } };
  L.logs = { p: [['g1', 'A', 1, 30, 30], ['g2', 'A', 1, 30, 30]] };
  const pick = gid => ({ id: gid, gid, pid: 'p', stat: 'pts', side: 'o', line: 20.5, price: -110, units: 1 });
  fs.writeFileSync(path.join(dir, '2026-10-28.json'), JSON.stringify({ picks: [pick('g1')] }));
  fs.writeFileSync(path.join(dir, '2026-10-29.json'), JSON.stringify({ picks: [pick('g2')] }));
  const s = S.seasonRecord(L, dir, '2026-10-29', 2027);
  assert.deepStrictEqual([s.w, s.l], [1, 0]);
  assert.strictEqual(S.RECORD_START, '2026-10-29');
});

test('withdrawn picks (pulled before posting and tip) stay out of the record', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const C = require('../site/assets/common.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-'));
  const L = C.indexLab({ cols: ['min', 'pts', 'reb'], season: 2027 }, { A: {}, B: {} }, [
    { id: '401909895', d: '2026-10-29', t: '2026-10-30T02:00Z', s: 2027, st: 2, h: 'A', a: 'B', state: 'post', hs: 100, as: 90 },
  ]);
  L.players = { 5105565: { n: 'C', t: 'A' }, 4065733: { n: 'J', t: 'B' } };
  L.logs = { 5105565: [['401909895', 'A', 1, 30, 10, 14]], 4065733: [['401909895', 'B', 1, 30, 20, 3]] };
  const picks = [
    { id: '401909895-5105565-reb', gid: '401909895', pid: '5105565', stat: 'reb', side: 'u', line: 10.5, price: -106, units: 1 },
    { id: '401909895-4065733-pts', gid: '401909895', pid: '4065733', stat: 'pts', side: 'u', line: 24.5, price: -115, units: 1 },
  ];
  fs.writeFileSync(path.join(dir, '2026-10-29.json'), JSON.stringify({ picks }));
  const s = S.seasonRecord(L, dir, '2026-10-29', 2027);
  assert.deepStrictEqual([s.w, s.l], [1, 0]);  // the withdrawn rebound under (a loss) isn't counted
  assert.ok(S.WITHDRAWN['401909895-5105565-reb']);
});
