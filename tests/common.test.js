// Tests for the hit-rate and team-trend math in site/assets/common.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');

const meta = { cols: ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'], season: 2027 };
const teams = { AAA: { conf: 'East', div: 'Atlantic' }, BBB: { conf: 'East', div: 'Central' }, CCC: { conf: 'West', div: 'Pacific' } };
const game = (id, d, h, a, hs, as, extra = {}) => ({ id, d, t: `${d}T23:00Z`, s: 2027, st: 2, h, a, state: 'post', hs, as, ...extra });

test('outcome and tally', () => {
  assert.strictEqual(C.outcome(25, 24.5), 'hit');
  assert.strictEqual(C.outcome(24, 24.5), 'miss');
  assert.strictEqual(C.outcome(24, 24.5, 'u'), 'hit');
  assert.strictEqual(C.outcome(24, 24), 'push');
  const t = C.tally(['hit', 'hit', 'miss', 'push']);
  assert.deepStrictEqual([t.hits, t.misses, t.pushes, t.n, t.rate], [2, 1, 1, 4, 0.5]);
});

test('typical line sits on the half point above the last-10 average floor', () => {
  const rows = [20, 22, 25, 30, 18, 24, 26, 21, 23, 24].map(pts => ({ pts }));
  assert.strictEqual(C.typicalLine(rows, 'pts'), 23.5);
});

test('team lines are judged against the current number', () => {
  const games = [
    game('1', '2026-10-20', 'AAA', 'BBB', 110, 100, { line: { sp: -4.5, tot: 220 } }),
    game('2', '2026-10-22', 'CCC', 'AAA', 120, 118, { line: { sp: -1.5, tot: 230 } }),
    game('3', '2026-10-24', 'AAA', 'CCC', 105, 101),
  ];
  const L = C.indexLab(meta, teams, games);
  const sides = C.teamFinals(L, 'AAA');
  assert.deepStrictEqual(C.lineResults(sides, 'ml'), ['hit', 'miss', 'hit']);
  // AAA -3.5 today: won by 10 (hit), lost by 2 (miss), won by 4 (hit)
  assert.deepStrictEqual(C.lineResults(sides, 'spread', -3.5), ['hit', 'miss', 'hit']);
  assert.deepStrictEqual(C.lineResults(sides, 'over', 215), ['miss', 'hit', 'miss']);
  // Rest days: game 2 is two days after game 1 for AAA -> 1 day of rest
  assert.strictEqual(L.rest['2|AAA'], 1);
  const split = Object.fromEntries(C.teamSplits(L, 'AAA', 2027).rows);
  assert.strictEqual(split.Overall, '2-1');
  assert.strictEqual(split.Home, '2-0');
  assert.strictEqual(split.Conference, '1-0');
  // ATS uses each game's own line: -4.5 won by 10 (cover), +1.5 lost by 2 (miss)
  assert.strictEqual(split['Against the spread'], '1-1-0');
});

test('player rows, filters and windows', () => {
  const games = [
    game('1', '2026-10-20', 'AAA', 'BBB', 110, 100),
    game('2', '2026-10-21', 'BBB', 'AAA', 99, 101),
    game('3', '2026-10-24', 'AAA', 'BBB', 90, 100),
  ];
  const L = C.indexLab(meta, teams, games);
  const row = (gid, min, pts) => [gid, 'AAA', 1, min, pts, 5, 3, 1, 4, 6, 12, 2, 2, 1, 4, 1, 0, 2, 3, 5];
  L.logs = { p1: [row('1', 30, 20), row('2', 34, 28), row('3', 12, 6)], p2: [row('1', 25, 10), row('3', 20, 8)] };
  const rows = C.playerRows(L, 'p1');
  assert.deepStrictEqual(rows.map(r => [r.home, r.opp, r.win, r.rest]), [[true, 'BBB', true, 9], [false, 'BBB', true, 0], [true, 'BBB', false, 2]]);
  assert.strictEqual(C.applyFilters(L, rows, { loc: 'away' }).length, 1);
  assert.strictEqual(C.applyFilters(L, rows, { rest: '0' }).length, 1);
  assert.strictEqual(C.applyFilters(L, rows, { minMin: 20 }).length, 2);
  assert.deepStrictEqual(C.applyFilters(L, rows, { without: ['p2'] }).map(r => r.gid), ['2']);
  assert.deepStrictEqual(C.applyFilters(L, rows, { with: ['p2'], result: 'win' }).map(r => r.gid), ['1']);
  const w = C.windowRates(rows, 'pts', 19.5, 'o', { opp: 'BBB', season: 2027 });
  assert.deepStrictEqual([w.l5.hits, w.l5.n, w.h2h.n, w.last.n], [2, 3, 3, 0]);
});

test('standings: games behind, streaks and conference order', () => {
  const games = [
    game('1', '2026-10-20', 'AAA', 'BBB', 110, 100),
    game('2', '2026-10-21', 'BBB', 'AAA', 99, 101),
    game('3', '2026-10-23', 'BBB', 'CCC', 90, 100),
    game('4', '2026-10-25', 'AAA', 'BBB', 95, 100),
  ];
  const L = C.indexLab(meta, teams, games);
  assert.strictEqual(C.streakOf(C.teamFinals(L, 'AAA')), 'L1');
  assert.strictEqual(C.streakOf(C.teamFinals(L, 'BBB')), 'W1');
  assert.strictEqual(C.streakOf([]), '-');
  assert.strictEqual(C.gamesBehind({ w: 10, l: 2 }, { w: 7, l: 4 }), 2.5);
  const S = C.standings(L, 2027);
  assert.deepStrictEqual(S.East.map(r => [r.team, r.rank, r.w, r.l, r.gb]), [['AAA', 1, 2, 1, 0], ['BBB', 2, 1, 3, 1.5]]);
  assert.deepStrictEqual(S.West.map(r => [r.team, r.home, r.away]), [['CCC', '0-0', '1-0']]);
});

test('position buckets', () => {
  assert.deepStrictEqual(['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'F-C', 'G-F', '', null].map(C.posBucket),
    ['G', 'G', 'G', 'F', 'F', 'F', 'C', 'C', 'G', null, null]);
});

test('defense vs position sums opponents by position and ranks most allowed first', () => {
  const games = [
    game('1', '2026-10-20', 'AAA', 'BBB', 110, 100),
    game('2', '2026-10-22', 'CCC', 'AAA', 120, 118),
    game('3', '2026-10-24', 'BBB', 'CCC', 101, 99),
  ];
  const L = C.indexLab(meta, teams, games);
  L.players = { g1: { p: 'PG' }, c1: { p: 'C' }, g2: { p: 'G' } };
  const row = (gid, team, pts, reb) => [gid, team, 1, 30, pts, reb, 2, 1, 3, 5, 10, 1, 2, 1, 2, 1, 0, 2, 3, 0];
  // AAA's guard g1 scores 30 on BBB and 20 on CCC; BBB's center c1 has 15 vs AAA, 9 vs CCC; CCC's guard g2 has 25 vs AAA, 10 vs BBB.
  L.logs = { g1: [row('1', 'AAA', 30, 4), row('2', 'AAA', 20, 3)], c1: [row('1', 'BBB', 15, 12), row('3', 'BBB', 9, 8)], g2: [row('2', 'CCC', 25, 5), row('3', 'CCC', 10, 2)] };
  const d = C.defenseVsPosition(L, 2027);
  assert.strictEqual(d.BBB.G.games, 2);
  assert.strictEqual(d.BBB.G.per.pts, 20);   // (30 + 10) / 2
  assert.strictEqual(d.AAA.G.per.pts, 12.5); // 25 / 2
  assert.strictEqual(d.CCC.G.per.pts, 10);   // 20 / 2
  assert.deepStrictEqual([d.BBB.G.rank.pts, d.AAA.G.rank.pts, d.CCC.G.rank.pts], [1, 2, 3]);
  assert.strictEqual(d.AAA.C.per.reb, 6);    // 12 / 2
  assert.strictEqual(d.AAA.ALL.per.pts, 20); // (15 + 25) / 2
  assert.strictEqual(d.AAA.G.per.pra, 12.5 + 2.5 + 1);
  const last1 = C.defenseVsPosition(L, 2027, { last: 1 });
  assert.strictEqual(last1.BBB.G.per.pts, 10);  // only BBB's latest game (3)
  assert.strictEqual(C.defenseVsPosition(L, 2027), d); // memoized
  assert.strictEqual(C.rankClass(3), 'soft');
  assert.strictEqual(C.rankClass(25), 'tough');
  assert.strictEqual(C.rankClass(15), 'mid');
});

test('confidence-adjusted rates pull small samples toward the longer-run rate', () => {
  // No history: prior is 50%. 5 for 5 with K = 10 -> (5 + 5) / 15.
  assert.strictEqual(C.priorRate({ hits: 0, n: 0 }), 0.5);
  assert.ok(Math.abs(C.adjustedRate({ hits: 5, n: 5 }, 0.5) - 10 / 15) < 1e-9);
  // A big sample barely moves: 40 of 50 against a 50% prior -> 45 / 60 = 75%.
  assert.strictEqual(C.adjustedRate({ hits: 40, n: 50 }, 0.5), 0.75);
  assert.strictEqual(C.adjustedRate({ hits: 0, n: 0 }), null);
  // Longer-run 30 of 50 shrinks to (30 + 5) / 60.
  assert.ok(Math.abs(C.priorRate({ hits: 30, n: 50 }) - 35 / 60) < 1e-9);
});

test('windowRates attaches adjusted rates and small-sample flags', () => {
  const games = Array.from({ length: 12 }, (_, i) => game(String(i + 1), `2026-10-${String(10 + i).padStart(2, '0')}`, 'AAA', 'BBB', 110, 100));
  const L = C.indexLab(meta, teams, games);
  // 20 points in the first 7 games, 30 in the last 5: over 24.5 hits only lately.
  L.logs = { p1: games.map((g, i) => [g.id, 'AAA', 1, 30, i < 7 ? 20 : 30, 5, 3, 1, 4, 6, 12, 2, 2, 1, 4, 1, 0, 2, 3, 5]) };
  const rows = C.playerRows(L, 'p1');
  const w = C.windowRates(rows, 'pts', 24.5, 'o', { season: 2027 });
  assert.strictEqual(w.l5.rate, 1);
  assert.strictEqual(w.l5.small, true);
  assert.strictEqual(w.l10.small, false);
  const prior = (5 + 5) / (12 + 10);           // 5 of 12 overall, shrunk toward 50%
  assert.ok(Math.abs(w.l5.prior - prior) < 1e-9);
  assert.ok(Math.abs(w.l5.adj - (5 + 10 * prior) / 15) < 1e-9);
  assert.ok(w.l5.adj < 0.7 && w.l5.adj > 0.5);
  assert.strictEqual(w.last.adj, null);        // no games last season
});

test('teammate boost compares games with and without a teammate on the same team', () => {
  const games = Array.from({ length: 8 }, (_, i) => game(String(i + 1), `2026-10-${String(10 + i * 2).padStart(2, '0')}`, 'AAA', 'BBB', 110, 100));
  const L = C.indexLab(meta, teams, games);
  const row = (gid, team, min, pts, fga) => [gid, team, 1, min, pts, 5, 3, 1, 4, 6, fga, 2, 2, 1, 4, 1, 0, 2, 3, 5];
  // star plays games 1-5, then is hurt; p1 scores 18 with him and 26 without.
  L.players = { p1: { n: 'Role Player', t: 'AAA' }, star: { n: 'Joel Star Jr.', t: 'AAA' }, bench: { n: 'Deep Bench', t: 'AAA' } };
  L.logs = {
    p1: games.map((g, i) => row(g.id, 'AAA', i < 5 ? 30 : 36, i < 5 ? 18 : 26, i < 5 ? 14 : 20)),
    star: games.slice(0, 5).map(g => row(g.id, 'AAA', 34, 28, 20)),
    bench: games.slice(0, 2).map(g => row(g.id, 'AAA', 8, 2, 2)),
  };
  L.injuries = [{ id: 'star', t: 'AAA', st: 'Out' }, { id: 'bench', t: 'AAA', st: 'Out' }, { id: 'p1', t: 'AAA', st: 'Questionable' }];
  const b = C.teammateBoost(L, 'p1', 'star', 'pts');
  assert.deepStrictEqual([b.with.n, b.without.n], [5, 3]);
  assert.deepStrictEqual([b.with.stat, b.without.stat, b.delta.stat], [18, 26, 8]);
  assert.strictEqual(b.delta.min, 6);
  assert.strictEqual(b.delta.fga, 6);
  assert.strictEqual(b.meaningful, true);
  // Only key absences (20+ minutes, 3+ games together) count; the bench player doesn't.
  assert.deepStrictEqual(C.outMates(L, 'p1').map(m => m.id), ['star']);
  assert.strictEqual(C.lastName('Joel Star Jr.'), 'Star');
});

test('injury status: a day-to-day entry takes the status its note gives', () => {
  const st = (s, det) => C.injuryStatus({ st: s, det });
  assert.strictEqual(st('Day-To-Day', "Williams (knee) is doubtful for Thursday's game against Memphis"), 'Doubtful');
  assert.strictEqual(st('Day-To-Day', 'He is questionable for Friday'), 'Questionable');
  assert.strictEqual(st('Day-To-Day', 'He has been ruled out for Saturday'), 'Out');
  assert.strictEqual(st('Day-To-Day', 'Listed day-to-day with soreness'), 'Day-To-Day');
  assert.strictEqual(st('Out', 'Probable to return next week'), 'Out');  // only day-to-day entries are reread
});
