// Tests for live scores (site/assets/live.js). Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
Object.assign(globalThis, require('../site/assets/picks.js'));
const X = require('../site/assets/live.js');

const team = abbr => ({ abbreviation: abbr });
const event = (id, state, detail, home, away) => ({
  id, competitions: [{ status: { type: { state, shortDetail: detail } }, competitors: [
    { homeAway: 'home', team: team(home[0]), score: home[1], linescores: (home[2] || []).map(value => ({ value })) },
    { homeAway: 'away', team: team(away[0]), score: away[1], linescores: (away[2] || []).map(value => ({ value })) },
  ] }],
});

test('scoreboard: scores, clock and quarters for started games; nothing for ones that haven\'t', () => {
  const list = X.parseLiveScoreboard({ events: [
    event('1', 'in', '3:54 - 4th', ['MIN', '99', [25, 24, 26, 24]], ['GS', '109', [30, 28, 27, 24]]),
    event('2', 'pre', '10:30 PM ET', ['LAL', '0'], ['LAC', '0']),
  ] });
  assert.deepStrictEqual(list[0], { id: '1', state: 'in', detail: '3:54 - 4th', hs: 99, as: 109, hq: [25, 24, 26, 24], aq: [30, 28, 27, 24] });
  assert.deepStrictEqual(list[1], { id: '2', state: 'pre', detail: '10:30 PM ET' });
});

test('live scores update games but never move a final back to live', () => {
  const L = C.indexLab({ cols: [], season: 2027 }, {}, [
    { id: '1', d: '2026-10-28', t: '2026-10-28T23:00Z', h: 'MIN', a: 'GSW', state: 'in', hs: 80, as: 85, detail: '9:00 - 3rd' },
    { id: '2', d: '2026-10-28', t: '2026-10-28T23:00Z', h: 'DEN', a: 'NOP', state: 'post', hs: 104, as: 91, detail: 'Final' },
  ]);
  const n = X.applyLiveScores(L, [
    { id: '1', state: 'in', detail: '3:54 - 4th', hs: 99, as: 109, hq: [], aq: [] },
    { id: '2', state: 'in', detail: '0:30 - 4th', hs: 100, as: 91, hq: [], aq: [] },  // stale feed: ignored
    { id: '9', state: 'in', detail: 'x', hs: 1, as: 1 },                                 // not a game we know
  ]);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual([L.byId.get('1').hs, L.byId.get('1').as, L.byId.get('1').detail], [99, 109, '3:54 - 4th']);
  assert.deepStrictEqual([L.byId.get('2').state, L.byId.get('2').hs], ['post', 104]);
});

const summary = {
  boxscore: { players: [{ team: team('GS'), statistics: [{
    labels: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'],
    athletes: [
      { athlete: { id: '3975' }, starter: true, stats: ['31', '27', '9-18', '5-11', '4-4', '4', '6', '2', '1', '0', '0', '4', '2', '+8'] },
      { athlete: { id: '77' }, didNotPlay: true, stats: [] },
      { athlete: { id: '78' }, stats: ['0', '0', '0-0', '0-0', '0-0', '0', '0', '0', '0', '0', '0', '0', '0', '0'] },
    ] }] }],
  },
};

test('live box score: game-log columns per player, did-not-plays left out', () => {
  const box = X.parseLiveBox(summary);
  assert.deepStrictEqual(Object.keys(box), ['3975']);
  const r = box['3975'];
  assert.deepStrictEqual([r.team, r.starter, r.min, r.pts, r.fgm, r.fga, r.fg3m, r.reb, r.ast, r.pm], ['GSW', true, 31, 27, 9, 18, 5, 4, 6, 8]);
  const L = { liveBox: { g1: box } };
  assert.strictEqual(X.liveValue(L, 'g1', '3975', 'pra'), 37);
  assert.strictEqual(X.liveValue(L, 'g1', 'nobody', 'pts'), null);
});

test('live tag: green once an over is cleared, red once an under is lost', () => {
  assert.match(X.liveTag(27, 24.5, 'o'), /livenow hit/);
  assert.match(X.liveTag(19, 24.5, 'o'), /class="livenow "/);
  assert.match(X.liveTag(27, 24.5, 'u'), /livenow miss/);
  assert.strictEqual(X.liveTag(null, 24.5), '');
});

test('when to check: now while a game is on or about to tip, later before that, never after', () => {
  const now = Date.parse('2026-10-28T22:00:00Z');
  const g = (state, t) => ({ state, t });
  assert.strictEqual(X.liveWait([g('in', '2026-10-28T21:00Z')], now), 0);
  assert.strictEqual(X.liveWait([g('pre', '2026-10-28T22:05:00Z')], now), 0);              // tips in 5 minutes
  assert.strictEqual(X.liveWait([g('pre', '2026-10-28T23:00:00Z')], now), 50 * 60000);     // check 10 min before tip
  assert.strictEqual(X.liveWait([g('pre', '2026-10-28T21:30:00Z')], now), 0);              // past tip, snapshot behind
  assert.strictEqual(X.liveWait([g('post', '2026-10-28T19:00Z')], now), null);
  assert.strictEqual(X.liveWait([g('pre', '2026-10-27T12:00:00Z')], now), null);           // long gone (postponed)
});

test('a saved pick shows its live stat, and settles from the live final before the data job catches up', () => {
  const box = X.parseLiveBox(summary);
  const pick = { gid: 'g1', pid: '3975', stat: 'pts', side: 'o', line: 24.5, price: -110, units: 1 };
  const L = { liveBox: { g1: box } };
  const live = X.liveGradePick(L, pick, { status: 'live', g: { id: 'g1', state: 'in' }, profit: 0 });
  assert.strictEqual(live.now, 27);
  L.liveBox.g1.final = true;
  const done = X.liveGradePick(L, pick, { status: 'void', why: "didn't play", g: { id: 'g1', state: 'post' }, profit: 0 });
  assert.deepStrictEqual([done.status, done.actual, Math.round(done.profit * 100) / 100], ['win', 27, 0.91]);
});
