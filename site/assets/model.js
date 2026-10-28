/* Hoop Lab projection model: expected minutes x per-minute rate, adjusted for the opponent's defense against the
   player's position and for the game's expected pace, turned into over / under probabilities.
   Loaded after common.js and context.js. Pure functions, unit tested in tests/model.test.js, and run over every
   past game by scripts/backtest.js (results in data/model.json, shown on model.html).

   Everything is computed from games strictly before the one being projected, so the backtest never peeks. */
'use strict';

if (typeof module !== 'undefined' && typeof STATS === 'undefined') {
  // In Node (tests, backtest), make the helpers common.js and context.js define as browser globals global here too.
  // (A `var` would clash with common.js's `const STATS` in the browser, where all scripts share one scope.)
  const { STATS, playerRows, posBucket, isFinal } = require('./common.js');
  const { teamBoxTotals } = require('./context.js');
  Object.assign(globalThis, { STATS, playerRows, posBucket, isFinal, teamBoxTotals });
}

// Tuning. The backtest reports how much each adjustment helps (or doesn't) on games it wasn't tuned on.
const MODEL = {
  minHalfLife: 5,      // minutes: weighted average of recent games, weight halves every 5 games back
  minGames: 15,        //   over at most the last 15 games
  rateHalfLife: 30,    // per-minute rate: steadier, so a longer memory
  rateGames: 50,
  ratePriorMin: 100,   // the rate is blended with the league rate for his position as if 100 such minutes were added
  needGames: 5,        // no projection with fewer games than this
  oppGames: 30,        // defense: the opponent's last 30 games
  oppShrink: 100,      //   pulled toward average as if 100 average games were added (matchup effects are small)
  paceGames: 10,       // pace: each team's last 10 games
  // Spread around the projection: variance = phi x mean (negative binomial). Fitted by the backtest and
  // replaced by data/model.json when it's loaded; these are fallbacks.
  phi: { pts: 2.6, reb: 1.6, ast: 1.5, fg3m: 1.25, pra: 3.2, pr: 2.8, pa: 2.9, ra: 1.8, stl: 1.05, blk: 1.3, sb: 1.2, tov: 1.15, fga: 1.6, fg3a: 1.4, fta: 2.0 },
};
const MODEL_STATS = Object.keys(MODEL.phi);
const BUCKETS = ['G', 'F', 'C', 'ALL'];

/* Weighted average with weights halving every `halfLife` items back from the end of the list. */
function decayWeights(n, halfLife) {
  return Array.from({ length: n }, (_, i) => Math.pow(0.5, (n - 1 - i) / halfLife));
}

/* Expected minutes from a player's recent games (oldest first). */
function projectMinutes(rows, o = MODEL) {
  const recent = rows.slice(-o.minGames);
  if (!recent.length) return null;
  const w = decayWeights(recent.length, o.minHalfLife);
  let s = 0, ws = 0;
  recent.forEach((r, i) => { s += w[i] * r.min; ws += w[i]; });
  return s / ws;
}

/* Per-minute rate for one stat: decayed sum of the stat over decayed sum of minutes, blended with `prior`
   (the league's per-minute rate for his position) as if o.ratePriorMin minutes at that rate were added. */
function perMinuteRate(rows, stat, prior, o = MODEL) {
  const recent = rows.slice(-o.rateGames).filter(r => r.min > 0);
  const w = decayWeights(recent.length, o.rateHalfLife), f = STATS[stat].f;
  let s = 0, m = 0;
  recent.forEach((r, i) => { s += w[i] * f(r); m += w[i] * r.min; });
  const k = prior != null ? o.ratePriorMin : 0;
  return m + k ? (s + k * (prior || 0)) / (m + k) : null;
}

// ---------------------------------------------------------------- team index (defense and pace over time)

/* Per team, its final games in time order with prefix sums of what its defense allowed (per position bucket and
   stat), possessions and pace, so any "last N games before t" window is two lookups. Memoized on L. */
function modelIndex(L) {
  if (L._model) return L._model;
  const box = teamBoxTotals(L), cols = L.meta.cols;
  const allowed = new Map();  // gid -> defending team -> bucket -> stat (and minutes) -> sum
  const KEYS = [...MODEL_STATS, 'min'];
  const blank = () => Object.fromEntries(BUCKETS.map(b => [b, Object.fromEntries(KEYS.map(s => [s, 0]))]));
  for (const [pid, rows] of Object.entries(L.logs || {})) {
    const bucket = posBucket((L.players[pid] || {}).p);
    for (const r of rows) {
      const g = L.byId.get(r[0]);
      if (!g) continue;
      const def = r[1] === g.h ? g.a : g.h;
      if (!allowed.has(g.id)) allowed.set(g.id, {});
      const a = allowed.get(g.id), d = a[def] || (a[def] = blank());
      const row = {};
      cols.forEach((c, i) => { row[c] = r[3 + i]; });
      for (const s of KEYS) {
        const v = s === 'min' ? row.min : STATS[s].f(row);
        d.ALL[s] += v;
        if (bucket) d[bucket][s] += v;
      }
    }
  }
  const teams = {};
  for (const team of Object.keys(L.teams)) {
    const list = (L.teamGames[team] || []).filter(g => isFinal(g) && allowed.has(g.id) && (box.get(g.id) || {})[team]);
    const t = [], poss = [0], pace = [0], sums = [blank()];
    list.forEach((g, i) => {
      const bx = box.get(g.id)[team], d = allowed.get(g.id)[team] || blank(), prev = sums[i], next = blank();
      for (const b of BUCKETS) for (const s of KEYS) next[b][s] = prev[b][s] + d[b][s];
      t.push(g.t);
      poss.push(poss[i] + (bx.poss || 0));
      pace.push(pace[i] + (bx.pace || 0));
      sums.push(next);
    });
    teams[team] = { t, poss, pace, sums };
  }
  // League: what every defense allowed (= what every offense produced), by bucket and stat, plus minutes played,
  // in time order. Gives both the per-possession baseline for defenses and the per-minute prior for players.
  const all = [];
  for (const [team, x] of Object.entries(teams)) x.t.forEach((t, i) => all.push({ t, team, i }));
  all.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const lg = { t: all.map(e => e.t), poss: [0], sums: [blank()] };
  all.forEach((e, k) => {
    const x = teams[e.team], prev = lg.sums[k], next = blank();
    for (const b of BUCKETS) for (const s of KEYS) next[b][s] = prev[b][s] + x.sums[e.i + 1][b][s] - x.sums[e.i][b][s];
    lg.poss.push(lg.poss[k] + x.poss[e.i + 1] - x.poss[e.i]);
    lg.sums.push(next);
  });
  L._model = { teams, lg };
  return L._model;
}

/* Index of the first entry in sorted `arr` that is >= x. */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/* League prefix-sum range for the 365 days before `before`: [start, end). */
function leagueWindow(M, before) {
  const yearAgo = new Date(Date.parse(before) - 365 * 864e5).toISOString();
  return [lowerBound(M.lg.t, yearAgo), lowerBound(M.lg.t, before)];
}

/* The league's per-minute rate for a position and stat over the year before `before` (the prior for thin samples). */
function leagueRate(L, bucket, stat, before) {
  const M = modelIndex(L), b = bucket || 'ALL', [ls, le] = leagueWindow(M, before);
  const mins = M.lg.sums[le][b].min - M.lg.sums[ls][b].min;
  return mins ? (M.lg.sums[le][b][stat] - M.lg.sums[ls][b][stat]) / mins : null;
}

/* How much more (> 1) or less (< 1) than average `opp` has allowed per possession to this position and stat,
   over its last o.oppGames games before time `before`, shrunk toward 1 by o.oppShrink games. */
function defenseFactor(L, opp, bucket, stat, before, o = MODEL) {
  const M = modelIndex(L), x = M.teams[opp];
  if (!x) return { f: 1, n: 0 };
  const end = lowerBound(x.t, before), start = Math.max(0, end - o.oppGames), n = end - start;
  if (!n) return { f: 1, n: 0 };
  const b = bucket || 'ALL';
  const allowed = x.sums[end][b][stat] - x.sums[start][b][stat], poss = x.poss[end] - x.poss[start];
  // League over the 365 days before this game.
  const [ls, le] = leagueWindow(M, before);
  const lAllowed = M.lg.sums[le][b][stat] - M.lg.sums[ls][b][stat], lPoss = M.lg.poss[le] - M.lg.poss[ls];
  if (!poss || !lPoss || !lAllowed) return { f: 1, n };
  const raw = (allowed / poss) / (lAllowed / lPoss);
  const w = n / (n + o.oppShrink);
  return { f: 1 + (raw - 1) * w, raw, n };
}

/* A team's average pace over its last o.paceGames games before `before`, or null. */
function paceBefore(L, team, before, o = MODEL) {
  const x = modelIndex(L).teams[team];
  if (!x) return null;
  const end = lowerBound(x.t, before), start = Math.max(0, end - o.paceGames);
  return end > start ? (x.pace[end] - x.pace[start]) / (end - start) : null;
}

/* Expected pace for the game over the player's team's own recent pace (the pace his rate was earned at). */
function paceFactor(L, team, opp, before, o = MODEL) {
  const mine = paceBefore(L, team, before, o), theirs = paceBefore(L, opp, before, o);
  if (!mine || !theirs) return 1;
  return ((mine + theirs) / 2) / mine;
}

/* Projection for one player, stat and game. `rows` are the player's game-log rows (playerRows), any order of
   games; only those before the game are used. opts: {team, opp, useDvp, usePace} (team / opp default to
   the player's side of `g`; set useDvp / usePace false to switch an adjustment off).
   Returns {mean, min, rate, dvp, pace, games} or null when there isn't enough history. */
function project(L, pid, g, stat, rows, opts = {}) {
  const o = MODEL;
  const before = (rows || playerRows(L, pid)).filter(r => r.g.t < g.t);
  if (before.length < o.needGames || !STATS[stat] || !o.phi[stat]) return null;
  const last = before[before.length - 1];
  const team = opts.team || ((L.players[pid] || {}).t === g.a || (L.players[pid] || {}).t === g.h ? (L.players[pid] || {}).t : last.team);
  const opp = opts.opp || (team === g.h ? g.a : g.h);
  const bucket = posBucket((L.players[pid] || {}).p);
  const min = projectMinutes(before, o);
  const rate = perMinuteRate(before, stat, leagueRate(L, bucket, stat, g.t), o);
  if (min == null || rate == null) return null;
  const dvp = opts.useDvp === false ? { f: 1, n: 0 } : defenseFactor(L, opp, bucket, stat, g.t, o);
  const pace = opts.usePace === false ? 1 : paceFactor(L, team, opp, g.t, o);
  return { mean: min * rate * dvp.f * pace, min, rate, dvp: dvp.f, dvpGames: dvp.n, pace, games: before.length, opp };
}

// ---------------------------------------------------------------- probabilities

/* P(over), P(under), P(push) for a line when the stat is negative binomial with this mean and variance
   phi x mean (Poisson when phi <= 1). Half-point lines can't push. */
function lineProbs(mean, line, phi) {
  if (!(mean >= 0)) return null;
  const cut = Math.floor(line);           // over needs more than `line`: X >= cut + 1
  const isInt = Number.isInteger(line);
  let pmf, step;
  if (mean === 0) { pmf = 1; step = () => 0; } else if (!(phi > 1.0001)) {
    pmf = Math.exp(-mean); step = k => mean / (k + 1);
  } else {
    const p = 1 / phi, r = mean / (phi - 1);
    pmf = Math.pow(p, r); step = k => (k + r) / (k + 1) * (1 - p);
  }
  let cdf = 0, at = 0;
  for (let k = 0; k <= cut; k++) {
    cdf += pmf;
    if (k === cut) at = pmf;
    pmf *= step(k);
  }
  const push = isInt ? at : 0;
  const under = isInt ? cdf - at : cdf;
  return { over: Math.max(0, 1 - cdf), under, push };
}

/* Fitted dispersion for a stat: from data/model.json when loaded, else the built-in fallback. */
function phiFor(L, stat) {
  const fit = L && L.model && L.model.phi;
  return (fit && fit[stat]) || MODEL.phi[stat];
}

/* Everything the site shows for one prop: projection, gap to the line and the model's lean.
   Returns null without enough history. */
function projectLine(L, pid, g, stat, line, rows) {
  const pr = project(L, pid, g, stat, rows);
  if (!pr) return null;
  const pb = lineProbs(pr.mean, line, phiFor(L, stat));
  const side = pb.over > pb.under ? 'o' : 'u';
  return { ...pr, line, gap: pr.mean - line, over: pb.over, under: pb.under, push: pb.push, side, conf: side === 'o' ? pb.over : pb.under };
}

// ---------------------------------------------------------------- display (browser only)

/* How strongly a probability backs one side: 'up' (55%+), 'down' (45% or less) or ''. */
const leanClass = p => (p >= 0.55 ? 'up' : p <= 0.45 ? 'down' : '');

/* One-line model row for a prop card: "MODEL 26.1 +1.6 ... Over 61%", for the side the card shows. */
function projRow(pj, side) {
  if (!pj) return '';
  const p = side === 'u' ? pj.under : pj.over;
  const tip = `Projection ${pj.mean.toFixed(1)}: ${pj.min.toFixed(1)} min x ${(pj.rate * 36).toFixed(1)} per 36`
    + ` x defense ${pj.dvp.toFixed(2)} x pace ${pj.pace.toFixed(2)}. Over ${pct(pj.over)}, under ${pct(pj.under)}.`;
  return `<div class="projrow" title="${esc(tip)}"><small>MODEL</small><b>${fmt1(pj.mean)}</b>
    <span class="gap ${pj.gap >= 0 ? 'up' : 'down'}">${signed(Math.round(pj.gap * 10) / 10)}</span><span class="grow"></span>
    <span>${side === 'u' ? 'Under' : 'Over'} <b class="${leanClass(p)}">${pct(p)}</b></span></div>`;
}

/* Projection box for the player page line card. */
function projBox(pj, stat, side) {
  if (!pj) return '';
  const p = side === 'u' ? pj.under : pj.over;
  const part = (label, v) => `<span><small>${label}</small><b>${v}</b></span>`;
  return `<div class="projbox"><div class="projhead"><div><small>MODEL PROJECTION</small><div class="big">${fmt1(pj.mean)}
      <span class="gap ${pj.gap >= 0 ? 'up' : 'down'}">${signed(Math.round(pj.gap * 10) / 10)} vs ${pj.line}</span></div></div>
      <div class="lean"><small>${side === 'u' ? 'UNDER' : 'OVER'} ${pj.line}</small><b class="${leanClass(p)}">${pct(p)}</b></div></div>
    <div class="projparts">${part('MIN', fmt1(pj.min))}${part(`${STATS[stat].short}/36`, fmt1(pj.rate * 36))}${part(`DEF ${esc(pj.opp)}`, `×${pj.dvp.toFixed(2)}`)}${part('PACE', `×${pj.pace.toFixed(2)}`)}</div>
    <p class="note">Minutes × per-minute rate, adjusted for ${esc(pj.opp)}'s defense against his position and the expected pace.
      <a href="model.html" style="color:var(--accent)">How it's built and how it has done</a>.</p></div>`;
}

if (typeof module !== 'undefined') {
  module.exports = { leanClass, MODEL, MODEL_STATS, decayWeights, projectMinutes, perMinuteRate, modelIndex, leagueRate, defenseFactor, paceBefore, paceFactor, project, lineProbs, phiFor, projectLine };
}
