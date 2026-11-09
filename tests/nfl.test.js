// Tests for NFL Lab's logic in site/assets/nfl.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
Object.assign(global, require('../site/assets/common.js'));
const F = require('../site/assets/nfl.js');

const teams = { AAA: { nickname: 'Aces' }, BBB: { nickname: 'Bees' }, CCC: { nickname: 'Cees' } };
const game = (id, week, away, home, as, hs, extra = {}) => ({ id, week, type: 'REG', date: `2026-09-${String(week * 7).padStart(2, '0')}`,
  time: '13:00', away, home, away_score: as, home_score: hs, home_spread: -3, total: 44.5, away_ml: 130, home_ml: -150, ...extra });
const games = [
  game('g1', 1, 'BBB', 'AAA', 17, 24),            // AAA wins by 7 at home (covers -3), total 41 (under 44.5)
  game('g2', 2, 'AAA', 'CCC', 20, 21),            // AAA loses by 1 on the road
  game('g3', 3, 'CCC', 'AAA', 10, 30),            // AAA wins by 20, total 40
  game('g4', 4, 'BBB', 'AAA', null, null, { home_spread: -6.5, total: 40.5 }),   // upcoming
];
const box = (week, opp, extra = {}) => ({ week, opp, att: 30, sk: 2, car: 25, pass_yds: 220, rush_yds: 110, fd: 20, int: 1, fl: 0, ...extra });
const teamstats = {
  AAA: [box(1, 'BBB', { pass_yds: 300 }), box(2, 'CCC'), box(3, 'CCC', { int: 0 })],
  BBB: [box(1, 'AAA', { sk: 4 })],
  CCC: [box(2, 'AAA'), box(3, 'AAA', { rush_yds: 50 })],
};
const N = F.nflLab({ season: 2026 }, games, teams, teamstats);

test('sides, records and the current week', () => {
  assert.strictEqual(F.nflRecord(N, 'AAA'), '2-1');
  assert.strictEqual(F.nflRecord(N, 'AAA', N.byId.get('g2').t), '1-0');   // only games before kickoff
  assert.strictEqual(F.nflCurrentWeek(N), 4);
  const s = F.nflSide(N.byId.get('g1'), 'BBB');
  assert.deepStrictEqual([s.pts, s.oppPts, s.margin, s.total, s.win, s.spread], [17, 24, -7, 41, false, 3]);
});

test("windows judge past games against THIS game's number", () => {
  const g = N.byId.get('g4');
  // AAA at -6.5: margins +7, -1, +20 -> covers 2 of 3.
  const sp = F.nflWindows(N, g, 'AAA', 'spread');
  assert.strictEqual(sp.num, -6.5);
  assert.deepStrictEqual([sp.l10.hits, sp.l10.n], [2, 3]);
  // H2H vs BBB: just week 1 (won by 7, covers -6.5).
  assert.deepStrictEqual([sp.h2h.hits, sp.h2h.n], [1, 1]);
  // Totals vs 40.5: 41 over, 41 over, 40 under.
  const ov = F.nflWindows(N, g, 'AAA', 'over');
  assert.deepStrictEqual([ov.l10.hits, ov.l10.n], [2, 3]);
  const ml = F.nflWindows(N, g, 'BBB', 'ml');
  assert.deepStrictEqual([ml.l10.hits, ml.l10.n], [0, 1]);
});

test('team rankings: offense and defense per game, turnovers and sacks flipped', () => {
  const R = F.nflRanks(N);
  assert.strictEqual(R.of, 3);
  assert.ok(Math.abs(R.totals.AAA.off.pts - 74 / 3) < 1e-9);
  assert.ok(Math.abs(R.totals.AAA.def.pts - 48 / 3) < 1e-9);
  assert.strictEqual(R.totals.AAA.off.yds, (410 + 330 + 330) / 3);
  // Defense rushing allowed: AAA allowed 110, 110, 50 -> best (fewest) of the three teams.
  assert.strictEqual(R.ranks.AAA.def.rush, 1);
  // Offensive turnovers: AAA 2 in 3 games; BBB and CCC 1 a game -> AAA (fewest) ranks 1st.
  assert.strictEqual(R.ranks.AAA.off.to, 1);
  // Defensive sacks: BBB's opponent (AAA, week 1) took 2; AAA's opponents took 4, 2, 2 -> AAA's defense ranks 1st.
  assert.strictEqual(R.ranks.AAA.def.sk, 1);
});

test('common opponents leave out the two teams themselves', () => {
  const c = F.nflCommonOpponents(N, 'AAA', 'BBB');
  assert.deepStrictEqual(c.map(x => x.opp), []);
  const c2 = F.nflCommonOpponents(N, 'BBB', 'CCC');
  assert.deepStrictEqual(c2.map(x => [x.opp, x.a.length, x.b.length]), [['AAA', 1, 2]]);
});

test('kickoff label', () => {
  assert.match(F.nflKick({ date: '2026-11-05', time: '20:15' }), /Nov 5 · 8:15 PM$/);
  assert.match(F.nflKick({ date: '2026-11-08', time: '09:30' }), /9:30 AM$/);
});

test('players: logs join their games, windows by line, defense vs position and ladders', () => {
  const players = { qa: { n: 'QB A', pos: 'QB', t: 'AAA' }, qb: { n: 'QB B', pos: 'QB', t: 'BBB' } };
  const logs = { cols: ['pass_yds', 'att'], logs: {
    qa: [[2026, 1, 'AAA', 'BBB', 250, 30], [2026, 2, 'AAA', 'CCC', 180, 25], [2026, 3, 'AAA', 'CCC', 300, 40]],
    qb: [[2026, 1, 'BBB', 'AAA', 200, 28]],
  } };
  const P = F.nflAddPlayers(F.nflLab({ season: 2026 }, games, teams, teamstats), players, logs, { games: { g4: [{ pid: 'qa', stat: 'pass_yds', line: 240.5, over: -110 }] } }, {});
  const rows = F.nflPlayerRows(P, 'qa', P.byId.get('g4').t);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].g.id, 'g1');
  assert.strictEqual(rows[0].home, true);
  const w = F.nflPlayerWindows(rows, 'pass_yds', 240.5, 'o', 'BBB', 2026);
  assert.deepStrictEqual([w.l10.hits, w.l10.n, w.h2h.hits, w.h2h.n], [2, 3, 1, 1]);
  assert.strictEqual(F.nflTypical(rows, 'pass_yds'), 243.5);
  // QBs vs CCC: 180 and 300 -> 240 a game; vs AAA: 200; vs BBB: 250 -> BBB allows the most (rank 1).
  const d = F.nflDefVsPos(P, 'QB', 'pass_yds');
  assert.deepStrictEqual([d.teams.BBB.rank, d.teams.CCC.rank, d.teams.AAA.rank], [1, 2, 3]);
  assert.strictEqual(F.nflVsOpponent(P, 'CCC', 'QB', 'pass_yds')[0].v, 300);
  assert.strictEqual(F.nflGameProps(P, 'g4').qa.pass_yds.line, 240.5);
  // Yardage every 5 yards on the .5, with his real line (48.5) included; counting stats every 1.
  assert.deepStrictEqual(F.nflLadder(48.5, 'rec_yds'), [29.5, 34.5, 39.5, 44.5, 48.5, 49.5, 54.5, 59.5, 64.5]);
  assert.deepStrictEqual(F.nflLadder(49.5, 'rec_yds'), [29.5, 34.5, 39.5, 44.5, 49.5, 54.5, 59.5, 64.5, 69.5]);
  assert.strictEqual(F.nflLadder(240.5, 'pass_yds').length, 13);
  assert.deepStrictEqual(F.nflLadder(13.5, 'car'), [10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5]);
  assert.deepStrictEqual(F.nflLadder(1.5, 'rec'), [0.5, 1.5, 2.5, 3.5, 4.5]);
  assert.deepStrictEqual(F.nflLadder(0.5, 'pass_td'), [0.5, 1.5, 2.5]);
});

test('saved NFL picks: grading from box scores, open until stats are in, and the stat list matches picks.js', () => {
  Object.assign(global, require('../site/assets/picks.js'), F);   // the browser shares one global scope
  const P = require('../site/assets/picks.js');
  const games2 = [...games, game('g5', 5, 'AAA', 'BBB', 24, 20)];    // final, but week 5 stats aren't in yet
  const players = { qa: { n: 'QB A', pos: 'QB', t: 'AAA' }, qc: { n: 'QB C', pos: 'QB', t: 'CCC' } };
  // QB A sat week 2 (QB C's row shows week 2's stats are in).
  const logs = { cols: ['pass_yds'], logs: { qa: [[2026, 1, 'AAA', 'BBB', 250], [2026, 3, 'AAA', 'CCC', 300]], qc: [[2026, 2, 'CCC', 'AAA', 210]] } };
  const G = F.nflAddPlayers(F.nflLab({ season: 2026 }, games2, teams, teamstats), players, logs);
  const pick = over => P.makePick({ sport: 'nfl', gid: 'g1', pid: 'qa', stat: 'pass_yds', side: 'o', line: 240.5, price: -110, ...over });
  assert.ok(P.validPick(pick()));
  assert.ok(!P.validPick(pick({ stat: 'pts' })));
  let gr = F.gradeNflPick(G, pick());
  assert.deepStrictEqual([gr.status, gr.actual], ['win', 250]);
  assert.strictEqual(gr.g.state, 'post');
  assert.strictEqual(F.gradeNflPick(G, pick({ gid: 'g2' })).status, 'void');        // week 2 stats exist, no row: DNP
  assert.strictEqual(F.gradeNflPick(G, pick({ gid: 'g5' })).status, 'open');        // final, stats pending
  assert.strictEqual(F.gradeNflPick(G, pick({ gid: 'g4' })).status, 'open');        // not played yet
  assert.match(P.pickText(pick()), /Over 240.5 Passing yards/);
  assert.notStrictEqual(P.pickKey(pick()), P.pickKey({ ...pick(), sport: undefined }));
  assert.deepStrictEqual(P.NFL_PICK_STATS, Object.keys(F.NFL_STATS));
  // Mixed-sport parlay legs keep their sport.
  const par = P.makeParlay({ legs: [pick(), { gid: '1', pid: 'p1', stat: 'pts', side: 'o', line: 20.5, price: -110 }] });
  assert.strictEqual(par.legs[0].sport, 'nfl');
  assert.ok(P.validPick(par));
});

test('kickoff times carry the Eastern offset', () => {
  assert.strictEqual(F.nflIso({ date: '2026-10-25', time: '13:00' }), '2026-10-25T13:00:00-04:00');
  assert.strictEqual(F.nflIso({ date: '2026-11-08', time: '13:00' }), '2026-11-08T13:00:00-05:00');
  assert.strictEqual(F.nflIso({ date: '2026-11-01', time: '13:00' }), '2026-11-01T13:00:00-05:00');   // first Sunday of November
});

// ---------------------------------------------------------------- live scores
test('live scores land on games by ESPN id and never go backwards', () => {
  const N = F.nflLab({ season: 2026 }, [game('g9', 9, 'BBB', 'AAA', null, null, { eid: '401', state: 'pre' })], teams, {});
  const g = N.byId.get('g9');
  assert.strictEqual(F.nflApplyLive(N, [{ id: '401', state: 'in', as: 7, hs: 10, detail: 'Q2 3:11' }]), 1);
  assert.deepStrictEqual(F.nflLiveScore(g), { away: 7, home: 10, detail: 'Q2 3:11' });
  assert.strictEqual(g.final, false);
  F.nflApplyLive(N, [{ id: '401', state: 'post', as: 17, hs: 24, detail: 'Final' }]);
  assert.deepStrictEqual([g.final, g.away_score, g.home_score, F.nflLiveScore(g)], [true, 17, 24, null]);
  assert.strictEqual(F.nflApplyLive(N, [{ id: '401', state: 'in', as: 0, hs: 0 }]), 0);
});

test('live box score rows and the live value for a prop', () => {
  const summary = { boxscore: { players: [{ statistics: [
    { name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ athlete: { id: '11' }, stats: ['18/25', '1,204', '2', '0'] }] },
    { name: 'rushing', labels: ['CAR', 'YDS', 'TD'], athletes: [{ athlete: { id: '11' }, stats: ['4', '22', '0'] }] },
    { name: 'kicking', labels: ['FG'], athletes: [{ athlete: { id: '99' }, stats: ['1/1'] }] }] }] } };
  const box = F.nflParseLiveBox(summary);
  assert.deepStrictEqual([box['11'].cmp, box['11'].att, box['11'].pass_yds, box['11'].rush_yds, box['99']], [18, 25, 1204, 22, undefined]);
  const N = { liveBox: { g9: box }, players: { p1: { eid: '11' }, p2: {} } };
  assert.strictEqual(F.nflLiveValue(N, 'g9', 'p1', 'pass_rush_yds'), 1226);
  assert.strictEqual(F.nflLiveValue(N, 'g9', 'p2', 'pass_yds'), null);
});

test('live polling waits until 10 minutes before kickoff', () => {
  const g = { state: 'pre', eid: '1', date: '2026-11-08', time: '13:00' };          // 1 PM EST = 18:00 UTC
  const kick = Date.parse('2026-11-08T18:00:00Z');
  assert.strictEqual(F.nflLiveWait([g], kick - 3600e3), 50 * 60000);
  assert.strictEqual(F.nflLiveWait([g], kick - 5 * 60000), 0);
  assert.strictEqual(F.nflLiveWait([g], kick + 6 * 3600e3), null);
  assert.strictEqual(F.nflLiveWait([{ ...g, state: 'in' }], 0), 0);
  assert.strictEqual(F.nflLiveWait([{ ...g, eid: null }], kick), null);
});

// ---------------------------------------------------------------- insights
test('insights keep sides that hit 75%+ over 5+ games', () => {
  assert.strictEqual(F.nflStrongSide(['hit', 'hit', 'hit', 'miss']), null);                       // under 5 games
  assert.strictEqual(F.nflStrongSide(['hit', 'hit', 'hit', 'hit', 'miss']).side, 'o');
  assert.strictEqual(F.nflStrongSide(['miss', 'miss', 'miss', 'miss', 'hit']).side, 'u');
  assert.strictEqual(F.nflStrongSide(['miss', 'miss', 'miss', 'miss', 'hit'], false), null);      // money line / spread: yes side only
  assert.ok(F.nflWilson(18, 20) > F.nflWilson(5, 5));
});

test('game insights: team trends against this game\'s numbers', () => {
  const list = [];
  for (let w = 1; w <= 6; w++) list.push(game(`t${w}`, w, 'BBB', 'AAA', 10, 30));               // AAA wins big, totals 40
  list.push(game('t7', 7, 'BBB', 'AAA', null, null, { home_spread: -3, total: 50.5 }));
  const N = F.nflAddPlayers(F.nflLab({ season: 2026 }, list.map(x => ({ ...x, season: 2026 })), teams, {}), {}, { cols: [], logs: {} }, { games: {} }, {});
  const ins = F.nflGameInsights(N, N.byId.get('t7'));
  const aaa = ins.filter(x => x.team === 'AAA');
  assert.ok(aaa.some(x => x.market === 'spread' && /covered -3 in 6 of their last 6 games/.test(x.text)));
  assert.ok(aaa.some(x => x.market === 'under'));
  assert.ok(ins.every(x => x.rate >= 0.75 && x.n >= 5));
  assert.ok(ins.filter(x => x.group === 'AAA|spread').length <= 2);
});

test('box score: saved game rows by team, else the live ESPN box score', () => {
  const N = F.nflAddPlayers(F.nflLab({ season: 2026 }, games, teams, {}),
    { p1: { n: 'Ace QB', pos: 'QB', t: 'AAA', eid: '11' }, p2: { n: 'Bee WR', pos: 'WR', t: 'BBB' } },
    { cols: ['cmp', 'att', 'pass_yds', 'rec', 'rec_yds'], logs: { p1: [[2026, 1, 'AAA', 'BBB', 20, 30, 250, 0, 0]], p2: [[2026, 1, 'BBB', 'AAA', 0, 0, 0, 6, 88]] } }, {}, {});
  const B = F.nflBoxScore(N, N.byId.get('g1'));
  assert.strictEqual(B.live, false);
  assert.deepStrictEqual([B.teams.AAA.map(x => [x.n, x.r.pass_yds]), B.teams.BBB.map(x => [x.n, x.r.rec_yds])], [[['Ace QB', 250]], [['Bee WR', 88]]]);
  // A game the data job hasn't saved yet: the live box (ESPN ids, ESPN abbreviations mapped) fills in.
  const summary = { boxscore: { players: [{ team: { abbreviation: 'AAA' }, statistics: [
    { name: 'passing', labels: ['C/ATT', 'YDS', 'TD', 'INT'], athletes: [{ athlete: { id: '11', displayName: 'Ace QB' }, stats: ['9/12', '101', '1', '0'] }] }] },
    { team: { abbreviation: 'BBB' }, statistics: [
    { name: 'rushing', labels: ['CAR', 'YDS', 'TD'], athletes: [{ athlete: { id: '77', displayName: 'New Guy' }, stats: ['5', '31', '0'] }] }] }] } };
  N.liveBox = { g2: F.nflParseLiveBox(summary) };
  const L = F.nflBoxScore(N, N.byId.get('g2'));
  assert.strictEqual(L.live, true);
  assert.deepStrictEqual(L.teams.AAA.map(x => [x.pid, x.n, x.r.pass_yds]), [['p1', 'Ace QB', 101]]);
  assert.strictEqual(F.nflBoxScore(N, N.byId.get('g3')).teams.AAA.length, 0);
});

test('was text when DraftKings moved off the priced line', () => {
  const r = { line: 48.5, over: null, was: { line: 53.5, over: -111, under: -115, book_o: 'DraftKings', book_u: 'FanDuel' } };
  assert.strictEqual(F.nflWasText(r), 'was 53.5 (-111 DraftKings)');
  assert.strictEqual(F.nflWasText(r, 'u'), 'was 53.5 (-115 FanDuel)');
  assert.strictEqual(F.nflWasText({ line: 4.5, over: -143 }), '');
});
