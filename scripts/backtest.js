#!/usr/bin/env node
/* Replay every past game through the projection model (site/assets/model.js) and score it.

   For each player-game with enough earlier games, the model projects points, rebounds, assists, threes and PRA
   using only games before it (the same code the site runs live). We score:
   - accuracy of the projected number vs a naive baseline (his last-10 average), as mean absolute error;
   - calibration of the chance of clearing a line: the "typical" line (half point above the floor of his last-10
     average), and, where we pulled one that day, the real sportsbook line. If the model says 60%, does it happen
     about 60% of the time?
   - how often its leans held: over when it gave 60%+, under when it gave 40% or less.
   Teammates out are taken from who actually sat that night (players averaging 20+ minutes who missed the game),
   standing in for the injury report the live site uses.

   Writes site/data/model.json for model.html. Runs after scripts/build_data.py in the deploy workflow:
       node scripts/backtest.js            # reads and writes site/data
*/
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../site/assets/common.js');
const M = require('../site/assets/model.js');

const DATA = path.join(__dirname, '..', 'site', 'data');
const STATS = ['pts', 'reb', 'ast', 'fg3m', 'pra'];
const MIN_PRIOR = 10;      // earlier games a player needs before a game is scored
const MIN_MINUTES = 10;    // skip garbage-time cameos: projections are for rotation players

const read = name => JSON.parse(fs.readFileSync(path.join(DATA, `${name}.json`), 'utf8'));

function run() {
  const started = Date.now();
  const meta = read('meta');
  const L = C.indexLab(meta, read('teams'), read('games'));
  L.players = read('players');
  L.logs = read('logs');
  let proplines = {};
  try { proplines = read('proplines'); } catch (e) { /* no prop history yet */ }
  const ctx = M.modelContext(L);

  const typical = [], real = [];
  const err = Object.fromEntries(STATS.map(s => [s, { n: 0, model: 0, base: 0 }]));
  const bySeason = {};
  for (const pid of Object.keys(L.logs)) {
    const rows = C.playerRows(L, pid);
    for (let i = MIN_PRIOR; i < rows.length; i++) {
      const r = rows[i], g = r.g;
      if (r.min < MIN_MINUTES) continue;
      const prior = rows.slice(0, i).filter(x => x.g.s >= g.s - 1);
      if (prior.length < MIN_PRIOR) continue;
      const absent = M.missingMates(ctx, r.team, g);
      for (const stat of STATS) {
        const pr = M.project(L, pid, stat, g, { team: r.team, rows: prior, absent });
        if (!pr) continue;
        const f = C.STATS[stat].f, actual = f(r);
        const base = C.mean(prior.slice(-10).map(f));
        const e = err[stat];
        e.n++; e.model += Math.abs(pr.mean - actual); e.base += Math.abs(base - actual);
        const line = C.typicalLine(prior, stat);
        const p = pr.over(line);
        typical.push({ p, hit: actual > line, stat, s: g.s });
        const season = bySeason[g.s] = bySeason[g.s] || { n: 0, model: 0, base: 0 };
        if (stat === 'pts') { season.n++; season.model += Math.abs(pr.mean - actual); season.base += Math.abs(base - actual); }
        const book = ((proplines[pid] || {})[g.id] || {})[stat];
        if (book != null && actual !== book) real.push({ p: pr.over(book), hit: actual > book, stat, s: g.s });
      }
    }
  }

  const leans = preds => {
    const over = preds.filter(x => x.p >= 0.6), under = preds.filter(x => x.p <= 0.4);
    return {
      over: { n: over.length, hit: over.length ? over.filter(x => x.hit).length / over.length : null },
      under: { n: under.length, hit: under.length ? under.filter(x => !x.hit).length / under.length : null },
    };
  };
  const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const summary = preds => ({
    n: preds.length, brier: round(M.brier(preds), 4),
    overRate: round(preds.filter(x => x.hit).length / (preds.length || 1)),
    calibration: M.calibration(preds).map(b => ({ ...b, pred: round(b.pred), actual: round(b.actual) })),
    leans: (l => ({ over: { n: l.over.n, hit: round(l.over.hit) }, under: { n: l.under.n, hit: round(l.under.hit) } }))(leans(preds)),
  });

  const out = {
    generated: new Date().toISOString().slice(0, 16) + 'Z',
    seasons: [...new Set(typical.map(x => x.s))].sort(),
    minPrior: MIN_PRIOR, minMinutes: MIN_MINUTES,
    accuracy: Object.fromEntries(STATS.map(s => [s, {
      n: err[s].n, mae: round(err[s].model / (err[s].n || 1), 2), baseline: round(err[s].base / (err[s].n || 1), 2),
    }])),
    ptsBySeason: Object.fromEntries(Object.entries(bySeason).map(([s, v]) => [s, { n: v.n, mae: round(v.model / (v.n || 1), 2), baseline: round(v.base / (v.n || 1), 2) }])),
    typical: summary(typical),
    typicalByStat: Object.fromEntries(STATS.map(s => {
      const list = typical.filter(x => x.stat === s);
      return [s, { n: list.length, brier: round(M.brier(list), 4), leans: summary(list).leans }];
    })),
    real: real.length ? summary(real) : { n: 0 },
    settings: M.MODEL,
  };
  fs.writeFileSync(path.join(DATA, 'model.json'), JSON.stringify(out));
  const a = out.accuracy.pts;
  console.log(`Backtest: ${typical.length} predictions over seasons ${out.seasons.join(', ')} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const s of STATS) console.log(`  ${s.padEnd(5)} MAE ${out.accuracy[s].mae} vs last-10 average ${out.accuracy[s].baseline}`);
  console.log(`  typical lines: Brier ${out.typical.brier}; over leans hit ${out.typical.leans.over.hit} (${out.typical.leans.over.n}), under leans ${out.typical.leans.under.hit} (${out.typical.leans.under.n})`);
  console.log(`  real lines: ${out.real.n} graded${out.real.n ? `, Brier ${out.real.brier}` : ''}`);
  return out;
}

if (require.main === module) run();
module.exports = { run };
