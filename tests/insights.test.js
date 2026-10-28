// Tests for the trend finder in site/assets/insights.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../site/assets/common.js');
const I = require('../site/assets/insights.js');

const meta = { cols: ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm'], season: 2027 };
const teams = {
  AAA: { city: 'Alpha', name: 'Aces', conf: 'East', div: 'Atlantic' },
  BBB: { city: 'Beta', name: 'Bees', conf: 'East', div: 'Central' },
};
const day = i => new Date(Date.UTC(2026, 9, 1 + i * 2)).toISOString().slice(0, 10);

/* n finals between AAA and BBB, alternating home, then today's game. AAA scores aPts(i), BBB 100. */
function league(n, aPts, line = { sp: 3.5, tot: 210 }, pastLine = () => ({ sp: 2.5, tot: 205 })) {
  const games = [];
  for (let i = 0; i < n; i++) {
    const home = i % 2 === 0;
    const a = aPts(i);
    games.push({ id: `g${i}`, d: day(i), t: `${day(i)}T23:00Z`, s: 2027, st: 2, state: 'post', h: home ? 'AAA' : 'BBB', a: home ? 'BBB' : 'AAA',
      hs: home ? a : 100, as: home ? 100 : a, hq: [30, 25, 25, 20], aq: [20, 25, 25, 30], line: pastLine(i) });
  }
  const today = { id: 'today', d: day(n), t: `${day(n)}T23:00Z`, s: 2027, st: 2, state: 'pre', h: 'AAA', a: 'BBB', line };
  games.push(today);
  const L = C.indexLab(meta, teams, games);
  return { L, today };
}

test('wilson prefers the larger sample at a similar rate', () => {
  assert.ok(I.wilson(18, 20) > I.wilson(5, 5));
  assert.strictEqual(I.wilson(0, 0), 0);
});

test('strongSide keeps a side at 75%+ with 5+ games and flips unders', () => {
  assert.strictEqual(I.strongSide(['hit', 'hit', 'hit', 'miss']), null);  // too few games
  const yes = I.strongSide(['hit', 'hit', 'hit', 'miss', 'hit']);
  assert.deepStrictEqual([yes.side, yes.hits, yes.n], ['yes', 4, 5]);
  const no = I.strongSide(['miss', 'miss', 'push', 'miss', 'miss', 'miss', 'hit', 'miss']);
  assert.deepStrictEqual([no.side, no.hits, no.n], ['no', 6, 8]);
  assert.strictEqual(I.strongSide(['hit', 'miss', 'hit', 'miss', 'hit', 'miss']), null);
});

test('player insight sentences and links match the split', () => {
  const { L, today } = league(10, () => 110);
  // p1 scores 30 at home, 12 on the road. Today he's home against BBB.
  const row = (g, i) => [g.id, 'AAA', 1, 34, i % 2 === 0 ? 30 : 12, 5, 3, 1, 4, 6, 12, 2, 2, 1, 4, 1, 0, 2, 3, 5];
  L.logs = { p1: L.games.filter(g => g.state === 'post').map(row) };
  L.players = { p1: { n: 'Pat One', t: 'AAA' } };
  const rows = C.playerRows(L, 'p1');
  const ins = I.playerInsights(L, L.players.p1, rows, { id: 'p1', s: 'pts', l: 24.5, o: -110, u: -110, bk: 'draftkings' },
    { gid: 'today', t: today.t, home: true, opp: 'BBB', rest: 1, outMates: [] });
  const home = ins.find(x => x.split === 'loc');
  assert.strictEqual(home.text, 'Pat One has exceeded 24.5 points in each of his last 5 games at home (30.0 points/game average).');
  assert.deepStrictEqual([home.side, home.hits, home.n, home.price], ['o', 5, 5, -110]);
  assert.deepStrictEqual(home.params, { id: 'p1', stat: 'pts', line: 24.5, opp: 'BBB', win: 'l10', loc: 'home' });
  // 50/50 overall, so no plain last-10 insight
  assert.ok(!ins.some(x => x.split === 'l10'));
});

test("team ATS as an underdog uses each game's own closing line", () => {
  // AAA is a 2.5-point dog in even games (home) and wins those; favored in odd games and loses by 1.
  const { L, today } = league(12, i => (i % 2 === 0 ? 105 : 99), { sp: 3.5, tot: 210, mlh: 140, mla: -160, sph: -110, spa: -110 });
  const ins = I.teamInsights(L, today, 'AAA');
  const dog = ins.find(x => x.market === 'spread' && x.split === 'dog');
  assert.strictEqual(dog.text, 'The Alpha Aces are 6-0 (100.0%) against the spread in their last 6 games as an underdog.');
  assert.deepStrictEqual([dog.label, dog.price], ['AAA +3.5 Spread', -110]);
  // Every final went under 210 and under each game's own 205 total
  const total = ins.find(x => x.market === 'total' && x.split === 'l10');
  assert.strictEqual(total.text, "The under 210 has hit in 10 of the Aces' last 10 games.");
  assert.strictEqual(total.label, 'Under 210');
  // AAA won the first quarter 30-20 at home and lost it 20-30 on the road: 50/50, no insight
  assert.ok(!ins.some(x => x.market === 'q1'));
});

test('keepBest keeps the strongest per market, one per family', () => {
  const mk = (group, family, hits, n) => ({ group, family, hits, n, rate: hits / n, strength: I.wilson(hits, n) });
  const out = I.keepBest([mk('a|pts', 'recent', 5, 5), mk('a|pts', 'recent', 18, 20), mk('a|pts', 'loc', 8, 10), mk('a|pts', 'h2h', 6, 6), mk('b|ml', 'recent', 9, 10)]);
  assert.deepStrictEqual(out.filter(x => x.group === 'a|pts').map(x => [x.family, x.n]), [['h2h', 6], ['recent', 20]]);
  assert.strictEqual(out.length, 3);
});
