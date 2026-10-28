#!/usr/bin/env node
/* Backtest the projection model (site/assets/model.js) on every game of last season, then write
   site/data/model.json for the Model page and for the prop rows' probabilities.

   For each player game, the model only sees games played before it. The season is split in two:
     fit:  games before Jan 1, used only to fit how spread out each stat is around the projection (phi)
     test: Jan 1 on, everything reported (accuracy, calibration, leans) comes from these games
   This season's games so far are scored too, as a second out-of-sample check.

   No sportsbook line history exists for last season (The Odds API's history is paid), so each game is judged
   against the line the site uses when there's no book: the typical line, floor(last-10 average) + 0.5.

   Usage: node scripts/backtest.js [--data site/data]   (run after scripts/build_data.py) */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../site/assets/common.js');
const M = require('../site/assets/model.js');

const REPORT_STATS = ['pts', 'reb', 'ast', 'fg3m', 'pra'];
const BINS = 10;
const LEANS = [0.55, 0.6, 0.65];

function loadLab(dir) {
  const read = n => JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
  const L = C.indexLab(read('meta'), read('teams'), read('games'));
  L.players = read('players');
  L.logs = read('logs');
  return L;
}

/* Sum of squared error over sum of projections: the variance-to-mean ratio of a negative binomial fit. */
function fitPhi(rows) {
  let se = 0, mu = 0;
  for (const r of rows) { se += (r.y - r.mu) ** 2; mu += r.mu; }
  return mu ? Math.max(1, se / mu) : null;
}

const r3 = x => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const mae = (rows, k) => r3(C.mean(rows.map(r => Math.abs(r[k] - r.y))));

/* Brier score and log loss of P(over) against what happened (half-point lines: no pushes). */
function scores(rows, k) {
  const ok = rows.filter(r => r[k] != null);
  const brier = C.mean(ok.map(r => (r[k] - r.over) ** 2));
  const eps = 1e-6;
  const ll = C.mean(ok.map(r => -Math.log(Math.min(1 - eps, Math.max(eps, r.over ? r[k] : 1 - r[k])))));
  return { brier: r3(brier), logloss: r3(ll) };
}

/* Predicted P(over) in 10 bins vs how often the over actually hit. */
function calibration(rows) {
  const bins = Array.from({ length: BINS }, (_, i) => ({ lo: i / BINS, hi: (i + 1) / BINS, n: 0, p: 0, hits: 0 }));
  for (const r of rows) {
    const b = bins[Math.min(BINS - 1, Math.floor(r.pOver * BINS))];
    b.n++; b.p += r.pOver; b.hits += r.over;
  }
  return bins.filter(b => b.n).map(b => ({ lo: b.lo, hi: b.hi, n: b.n, pred: r3(b.p / b.n), actual: r3(b.hits / b.n) }));
}

/* How the model's side did when it leaned at least this hard. Typical lines sit above the median more often than
   not (unders hit more), so each lean also reports `under`: what blindly taking the under did on the same games. */
function leans(rows) {
  return LEANS.map(min => {
    const picked = rows.filter(r => Math.max(r.pOver, 1 - r.pOver) >= min);
    const hits = picked.filter(r => (r.pOver >= 0.5) === !!r.over).length;
    const unders = picked.filter(r => !r.over).length;
    return { min, n: picked.length, hits, rate: picked.length ? r3(hits / picked.length) : null,
      overs: picked.filter(r => r.pOver >= 0.5).length, under: picked.length ? r3(unders / picked.length) : null };
  });
}

function summarize(rows) {
  return {
    n: rows.length,
    mae: { model: mae(rows, 'mu'), base: mae(rows, 'muBase'), pace: mae(rows, 'muPace'), dvp: mae(rows, 'muDvp'),
      l10: mae(rows, 'l10'), season: mae(rows.filter(r => r.seasonAvg != null), 'seasonAvg') },
    bias: r3(C.mean(rows.map(r => r.mu - r.y))),
    model: scores(rows, 'pOver'),
    hitRate: scores(rows, 'pAdj'),
    baseRate: scores(rows, 'pBase'),
    coin: scores(rows.map(r => ({ ...r, half: 0.5 })), 'half'),
    overRate: r3(C.mean(rows.map(r => r.over))),
    calibration: calibration(rows),
    leans: leans(rows),
  };
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.includes('--data') ? args[args.indexOf('--data') + 1] : path.join(__dirname, '..', 'site', 'data');
  const t0 = Date.now();
  const L = loadLab(dir);
  const season = L.meta.season - 1, current = L.meta.season;
  const split = `${season}-01-01`;
  const out = [];  // one record per player game and stat

  for (const pid of Object.keys(L.logs)) {
    const rows = C.playerRows(L, pid);
    rows.forEach((row, i) => {
      if (row.g.s !== season && row.g.s !== current) return;
      const before = rows.slice(0, i);
      if (before.length < M.MODEL.needGames) return;
      const opts = { team: row.team, opp: row.opp };
      for (const stat of M.MODEL_STATS) {
        const full = M.project(L, pid, row.g, stat, before, opts);
        if (!full) continue;
        const f = C.STATS[stat].f;
        const rec = { pid, gid: row.gid, d: row.g.d, s: row.g.s, stat, y: f(row), mu: full.mean };
        if (REPORT_STATS.includes(stat)) {
          rec.muBase = M.project(L, pid, row.g, stat, before, { ...opts, useDvp: false, usePace: false }).mean;
          rec.muPace = M.project(L, pid, row.g, stat, before, { ...opts, useDvp: false }).mean;
          rec.muDvp = M.project(L, pid, row.g, stat, before, { ...opts, usePace: false }).mean;
          rec.l10 = C.mean(before.slice(-10).map(f));
          const sameSeason = before.filter(r => r.g.s === row.g.s);
          rec.seasonAvg = sameSeason.length >= 5 ? C.mean(sameSeason.map(f)) : null;
          // The line the site would show with no sportsbook, and the site's own sample-adjusted L10 hit rate at it.
          rec.line = C.typicalLine(before, stat);
          rec.over = rec.y > rec.line ? 1 : 0;
          const prior = C.priorRate(C.tally(before.map(r => C.outcome(f(r), rec.line, 'o'))));
          rec.pAdj = C.adjustedRate(C.tally(before.slice(-10).map(r => C.outcome(f(r), rec.line, 'o'))), prior);
        }
        out.push(rec);
      }
    });
  }

  const inSeason = out.filter(r => r.s === season);
  const fitRows = inSeason.filter(r => r.d < split), testRows = inSeason.filter(r => r.d >= split);
  const phiFit = {}, phiLive = {};
  for (const stat of M.MODEL_STATS) {
    phiFit[stat] = r3(fitPhi(fitRows.filter(r => r.stat === stat)));
    phiLive[stat] = r3(fitPhi(inSeason.filter(r => r.stat === stat)));
  }
  // Base rate: how often the over hit at typical lines in the fit half, per stat (a constant guess).
  const baseOver = Object.fromEntries(REPORT_STATS.map(s => [s, C.mean(fitRows.filter(r => r.stat === s).map(r => r.over))]));
  const withProb = (rows, phi) => rows.filter(r => r.line != null)
    .map(r => ({ ...r, pOver: M.lineProbs(r.mu, r.line, phi[r.stat]).over, pBase: baseOver[r.stat] }));
  const test = withProb(testRows, phiFit);
  const now = withProb(out.filter(r => r.s === current), phiLive);

  const report = { stats: {}, all: summarize(test.filter(r => REPORT_STATS.includes(r.stat))) };
  for (const stat of REPORT_STATS) report.stats[stat] = summarize(test.filter(r => r.stat === stat));
  const thisSeason = now.length ? { all: summarize(now), stats: Object.fromEntries(REPORT_STATS.map(s => [s, summarize(now.filter(r => r.stat === s))])) } : null;

  const doc = {
    built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    season, current, fitBefore: split,
    fitGames: new Set(fitRows.map(r => r.gid)).size, testGames: new Set(testRows.map(r => r.gid)).size,
    params: { ...M.MODEL, phi: undefined },
    phi: phiLive, phiFit, baseOver: Object.fromEntries(Object.entries(baseOver).map(([k, v]) => [k, r3(v)])),
    test: report, thisSeason,
  };
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(doc));

  const a = report.all;
  console.log(`Backtest ${season - 1}-${String(season).slice(2)}: ${a.n} player props in ${doc.testGames} test games (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  MAE model ${a.mae.model} | L10 avg ${a.mae.l10} | no adjustments ${a.mae.base}`);
  console.log(`  Brier model ${a.model.brier} | L10 hit rate ${a.hitRate.brier} | base rate ${a.baseRate.brier} | coin flip ${a.coin.brier}`);
  for (const l of a.leans) console.log(`  leans >= ${l.min}: ${l.hits}/${l.n} (${l.rate}; always-under ${l.under})`);
  if (thisSeason) console.log(`  this season so far: ${thisSeason.all.n} props, Brier ${thisSeason.all.model.brier} vs ${thisSeason.all.hitRate.brier}`);
}

if (require.main === module) main();
module.exports = { fitPhi, calibration, leans, summarize };
