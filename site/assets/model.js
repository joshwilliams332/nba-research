/* Hoop Lab projection model: a projected stat line for a player in an upcoming game, and the chance of clearing a line.

   projection = projected minutes × per-minute rate × opponent factor × pace factor
   - Minutes: exponentially weighted recent minutes, plus part of the change in his minutes in past games without a
     key teammate who is out.
   - Per-minute rate: decay-weighted over this season and last (recent games count most), padded with a
     position-average rate so a few games can't swing it, and nudged by the same teammate-out split.
   - Opponent: what this defense allows per game to his position, relative to the league, half-strength and capped.
   - Pace: tonight's expected pace relative to his team's usual pace, half-strength and capped.
   The spread around the projection is a negative binomial (counts that vary more than a Poisson), with the
   player's own variance-to-mean ratio from recent games, shrunk toward a typical value for the stat.

   Everything uses only games before the one being projected, so scripts/backtest.js can replay past seasons
   through the same code. Loads after common.js and context.js in the browser; tested in tests/model.test.js. */
'use strict';

if (typeof module !== 'undefined' && typeof STATS === 'undefined') {
  // In Node (tests, backtest), put the helpers the browser gets as globals on the global object. (Declaring them
  // here with var would clash with common.js's own declarations when both load as browser scripts.)
  Object.assign(globalThis, require('./common.js'), require('./context.js'));
}

// Tuning. Each was chosen on last season's games in scripts/backtest.js, then left alone.
const MODEL = {
  minHalfLife: 4,        // games: half-life of the minutes average
  rateHalfLife: 20,      // games: half-life of the per-minute rate average
  ratePadMinutes: 150,   // minutes of position-average rate blended in (matters most with few games)
  oppPadGames: 10,       // games of last season's (or league) average blended into this season's defense numbers
  oppStrength: 0.5,      // how much of the defense's relative difference to apply
  oppCap: 0.15,          // opponent factor stays within 1 ± this
  paceStrength: 0.5,
  paceCap: 0.06,
  mateStrength: 0.5,     // how much of a teammate-out split to apply
  mateMinGames: 3,       // games with and without him needed before the split counts
  maxMinutes: 42,
  minGames: 5,           // prior games needed to project at all
  dispersion: { pts: 2.6, reb: 1.6, ast: 1.5, fg3m: 1.25, pra: 2.6, pr: 2.4, pa: 2.4, ra: 1.6, stl: 1.1, blk: 1.2, sb: 1.15, tov: 1.2, fga: 1.6, fg3a: 1.5, fta: 1.7 },
  dispersionPad: 15,     // games of the typical dispersion blended into the player's own
};
const MODEL_STATS = STAT_ORDER.filter(s => !STATS[s].period);

// ---------------------------------------------------------------- distribution

/* Negative binomial P(X <= k) for a count with this mean and variance = mean × disp (disp > 1). */
function nbCdf(k, m, disp) {
  if (k < 0) return 0;
  if (!(m > 0)) return 1;
  const d = Math.max(disp, 1.0001);
  const r = m / (d - 1), p = 1 / d;          // var = m / p  ->  p = 1/d ;  m = r(1-p)/p  ->  r = m p / (1-p)
  let logPk = r * Math.log(p), sum = Math.exp(logPk);
  for (let i = 1; i <= Math.floor(k); i++) {
    logPk += Math.log((i - 1 + r) / i) + Math.log(1 - p);
    sum += Math.exp(logPk);
  }
  return Math.min(1, sum);
}

/* Chance the stat lands over / under a line (a push, possible on whole-number lines, counts for neither). */
function probOver(line, m, disp) {
  return 1 - nbCdf(Math.floor(line), m, disp);
}
function probUnder(line, m, disp) {
  return nbCdf(Math.ceil(line) - 1, m, disp);
}

// ---------------------------------------------------------------- context (built once per page / backtest)

const isFinalG = g => g.state === 'post' && g.hs != null;
const decay = (age, halfLife) => Math.pow(0.5, age / halfLife);

/* Everything the model looks up by date: each defense's game-by-game amounts allowed by position, league averages,
   each team's pace by game, who played in each game, and position-average per-minute rates. Memoized on L. */
function modelContext(L) {
  if (L._model) return L._model;
  const cols = L.meta.cols;
  const box = teamBoxTotals(L);
  const byGame = new Map();          // gid -> {team: {pid: minutes}}
  const allowed = new Map();         // gid -> {defense team: {bucket: {stat: amount}}}
  const posRate = {};                // bucket -> stat -> [amount, minutes]
  const empty = () => Object.fromEntries(MODEL_STATS.map(s => [s, 0]));
  for (const [pid, rows] of Object.entries(L.logs || {})) {
    const bucket = posBucket((L.players[pid] || {}).p) || 'F';
    for (const r of rows) {
      const g = L.byId.get(r[0]);
      if (!g) continue;
      const row = {};
      cols.forEach((c, i) => { row[c] = r[3 + i]; });
      const team = r[1], def = team === g.h ? g.a : g.h;
      if (!byGame.has(g.id)) byGame.set(g.id, {});
      (byGame.get(g.id)[team] = byGame.get(g.id)[team] || {})[pid] = row.min;
      if (!allowed.has(g.id)) allowed.set(g.id, {});
      const a = allowed.get(g.id);
      const d = a[def] = a[def] || { G: empty(), F: empty(), C: empty() };
      const pr = posRate[bucket] = posRate[bucket] || Object.fromEntries(MODEL_STATS.map(s => [s, [0, 0]]));
      for (const s of MODEL_STATS) {
        const v = STATS[s].f(row);
        d[bucket][s] += v;
        pr[s][0] += v;
        pr[s][1] += row.min;
      }
    }
  }
  // Each team's final games in order, with what its defense allowed and its pace.
  const seq = {};
  for (const team of Object.keys(L.teams)) {
    seq[team] = (L.teamGames[team] || []).filter(g => isFinalG(g) && allowed.has(g.id) && (allowed.get(g.id)[team]))
      .map(g => ({ g, t: g.t, s: g.s, allowed: allowed.get(g.id)[team], pace: ((box.get(g.id) || {})[team] || {}).pace }));
  }
  const ctx = { L, byGame, seq, posRate, cache: new Map() };
  L._model = ctx;
  return ctx;
}

/* A team's games before time t (binary search on its sorted list). */
function priorGames(ctx, team, t) {
  const list = ctx.seq[team] || [];
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
  return list.slice(0, lo);
}

/* Per-game amount a defense allowed to a position, as of time t in season s:
   this season's games padded with MODEL.oppPadGames of last season's rate (or the league's when he has none). */
function allowedPerGame(ctx, team, bucket, stat, t, s, fallback) {
  const prior = priorGames(ctx, team, t);
  const cur = prior.filter(x => x.s === s), prev = prior.filter(x => x.s === s - 1);
  const sum = list => list.reduce((a, x) => a + x.allowed[bucket][stat], 0);
  const base = prev.length >= 20 ? sum(prev) / prev.length : fallback;
  if (base == null) return cur.length ? sum(cur) / cur.length : null;
  return (sum(cur) + MODEL.oppPadGames * base) / (cur.length + MODEL.oppPadGames);
}

/* League-average per-game amount allowed to a position before time t: the mean over all teams of their own rate. */
function leagueAllowed(ctx, bucket, stat, t, s) {
  const key = `lg|${bucket}|${stat}|${t.slice(0, 10)}|${s}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  let total = 0, n = 0;
  for (const team of Object.keys(ctx.seq)) {
    for (const x of priorGames(ctx, team, t)) {
      if (x.s !== s && x.s !== s - 1) continue;
      total += x.allowed[bucket][stat];
      n++;
    }
  }
  const v = n ? total / n : null;
  ctx.cache.set(key, v);
  return v;
}

/* Opponent factor: this defense vs the league for this position and stat, at MODEL.oppStrength, capped. */
function oppFactor(ctx, opp, bucket, stat, t, s) {
  const lg = leagueAllowed(ctx, bucket, stat, t, s);
  if (!lg) return 1;
  const own = allowedPerGame(ctx, opp, bucket, stat, t, s, lg);
  if (own == null) return 1;
  const f = 1 + MODEL.oppStrength * (own / lg - 1);
  return Math.min(1 + MODEL.oppCap, Math.max(1 - MODEL.oppCap, f));
}

/* Pace factor: average of both teams' last-10 pace vs the player's team's last-10 pace. */
function paceFactor(ctx, team, opp, t) {
  const recent = x => {
    const vals = priorGames(ctx, x, t).slice(-10).map(y => y.pace).filter(Boolean);
    return vals.length ? mean(vals) : null;
  };
  const mine = recent(team), theirs = recent(opp);
  if (!mine || !theirs) return 1;
  const f = 1 + MODEL.paceStrength * ((mine + theirs) / 2 / mine - 1);
  return Math.min(1 + MODEL.paceCap, Math.max(1 - MODEL.paceCap, f));
}

/* Teammates who play big minutes (20+ a game over the team's last 10, in 3+ of them) and sat out game g.
   Used by the backtest, where we know who didn't play; live projections use the injury report instead. */
function missingMates(ctx, team, g) {
  const key = `miss|${g.id}|${team}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const tonight = (ctx.byGame.get(g.id) || {})[team] || {};
  const mins = {};
  for (const x of priorGames(ctx, team, g.t).slice(-10)) {
    for (const [pid, m] of Object.entries((ctx.byGame.get(x.g.id) || {})[team] || {})) (mins[pid] = mins[pid] || []).push(m);
  }
  const out = Object.entries(mins).filter(([pid, m]) => m.length >= 3 && mean(m) >= 20 && !(pid in tonight)).map(([pid]) => pid);
  ctx.cache.set(key, out);
  return out;
}

/* How a player's minutes and per-minute rate changed in past games without a teammate (same team, this season and
   last), when there are enough games each way. {dMin, rateRatio} or null. */
function mateSplit(ctx, rows, team, mate, stat) {
  const f = STATS[stat].f;
  const withR = [], withoutR = [];
  for (const r of rows) {
    if (r.team !== team) continue;
    const played = (ctx.byGame.get(r.gid) || {})[team] || {};
    (mate in played ? withR : withoutR).push(r);
  }
  // Only count "without" games while the teammate was around (between his first and last game here).
  const mateGames = rows.filter(r => r.team === team && mate in ((ctx.byGame.get(r.gid) || {})[team] || {}));
  if (mateGames.length < MODEL.mateMinGames) return null;
  const first = mateGames[0].g.t;
  const without = withoutR.filter(r => r.g.t > first);
  if (without.length < MODEL.mateMinGames || withR.length < MODEL.mateMinGames) return null;
  const rate = list => { const m = list.reduce((a, r) => a + r.min, 0); return m ? list.reduce((a, r) => a + f(r), 0) / m : null; };
  const rw = rate(withR), rwo = rate(without);
  return {
    dMin: mean(without.map(r => r.min)) - mean(withR.map(r => r.min)),
    rateRatio: rw && rwo ? Math.min(1.25, Math.max(0.8, rwo / rw)) : 1,
    n: without.length,
  };
}

// ---------------------------------------------------------------- projection

/* Project one stat for player pid in game g.
   opts: team (default: his current team), rows (his game rows; only those before g count),
         absent (teammate ids out tonight; default: the injury report for upcoming games).
   Returns {mean, minutes, rate, opp, pace, disp, games, absent, over(line), under(line)} or null. */
function project(L, pid, stat, g, opts = {}) {
  if (!STATS[stat] || STATS[stat].period) return null;
  const ctx = modelContext(L);
  const p = L.players[pid] || {};
  const team = opts.team || p.t;
  if (!team || (g.h !== team && g.a !== team)) return null;
  const opp = g.h === team ? g.a : g.h;
  const rows = (opts.rows || playerRows(L, pid)).filter(r => r.g.t < g.t && r.g.s >= g.s - 1 && r.min > 0);
  if (rows.length < MODEL.minGames) return null;
  const f = STATS[stat].f;
  const bucket = posBucket(p.p) || 'F';

  // Minutes: exponentially weighted, most recent first.
  const recent = rows.slice(-20).reverse();
  let wSum = 0, mSum = 0;
  recent.forEach((r, age) => { const w = decay(age, MODEL.minHalfLife); wSum += w; mSum += w * r.min; });
  let minutes = mSum / wSum;

  // Per-minute rate, decay-weighted over every prior game, padded with the position average.
  const pos = ctx.posRate[bucket][stat];
  const posRate = pos[1] ? pos[0] / pos[1] : 0;
  let a = MODEL.ratePadMinutes * posRate, m = MODEL.ratePadMinutes;
  rows.slice().reverse().forEach((r, age) => { const w = decay(age, MODEL.rateHalfLife); a += w * f(r); m += w * r.min; });
  let rate = a / m;

  // Teammates out tonight.
  let absent = opts.absent;
  if (!absent) absent = g.state === 'pre' && typeof outMates === 'function' ? outMates(L, pid).map(x => x.id) : [];
  const used = [];
  for (const mate of absent) {
    const split = mateSplit(ctx, rows, team, mate, stat);
    if (!split) continue;
    // The averages above already reflect games he's missed lately, so only adjust for the share of the
    // weighted recent games he actually played (if he's been out all week, there's little left to adjust).
    const share = (halfLife, list) => {
      let w = 0, on = 0;
      list.forEach((r, age) => {
        const x = decay(age, halfLife);
        w += x;
        if (mate in ((ctx.byGame.get(r.gid) || {})[team] || {})) on += x;
      });
      return w ? on / w : 0;
    };
    minutes += MODEL.mateStrength * share(MODEL.minHalfLife, recent) * split.dMin;
    rate *= 1 + MODEL.mateStrength * share(MODEL.rateHalfLife, rows.slice().reverse()) * (split.rateRatio - 1);
    used.push(mate);
  }
  minutes = Math.max(0, Math.min(MODEL.maxMinutes, minutes));

  const of = oppFactor(ctx, opp, bucket, stat, g.t, g.s);
  const pf = paceFactor(ctx, team, opp, g.t);
  const mu = Math.max(0.01, minutes * rate * of * pf);

  // Spread: his variance-to-mean ratio over the last 30 games, shrunk toward the stat's typical value.
  const vals = rows.slice(-30).map(f), vm = mean(vals);
  const varr = vals.length > 1 ? vals.reduce((x, v) => x + (v - vm) ** 2, 0) / (vals.length - 1) : 0;
  const own = vm > 0 ? varr / vm : MODEL.dispersion[stat];
  const typical = MODEL.dispersion[stat] || 1.5;
  const disp = Math.max(1.05, (vals.length * own + MODEL.dispersionPad * typical) / (vals.length + MODEL.dispersionPad));

  return {
    mean: mu, minutes, rate, opp: of, pace: pf, disp, games: rows.length, absent: used,
    over: line => probOver(line, mu, disp), under: line => probUnder(line, mu, disp),
  };
}

// ---------------------------------------------------------------- backtest scoring

/* Calibration table: predictions [{p, hit}] bucketed by predicted chance (10 buckets of 10%).
   Each bucket reports how many, the average prediction and how often it actually happened. */
function calibration(preds, buckets = 10) {
  const out = Array.from({ length: buckets }, (_, i) => ({ lo: i / buckets, hi: (i + 1) / buckets, n: 0, pred: 0, hits: 0 }));
  for (const x of preds) {
    const b = out[Math.min(buckets - 1, Math.floor(x.p * buckets))];
    b.n++; b.pred += x.p; b.hits += x.hit ? 1 : 0;
  }
  return out.map(b => ({ lo: b.lo, hi: b.hi, n: b.n, pred: b.n ? b.pred / b.n : null, actual: b.n ? b.hits / b.n : null }));
}

/* Brier score: mean squared error of predicted chances (lower is better; always guessing 50% scores 0.25). */
function brier(preds) {
  return preds.length ? preds.reduce((a, x) => a + (x.p - (x.hit ? 1 : 0)) ** 2, 0) / preds.length : null;
}

// ---------------------------------------------------------------- display (browser only)

/* "Proj 26.1 · 58% over" chip for prop rows: projection, gap to the line and the chance of the chosen side. */
function projTag(L, pid, stat, line, g, side = 'o', rows) {
  const pr = project(L, pid, stat, g, rows ? { rows } : {});
  if (!pr) return '';
  const pSide = side === 'u' ? pr.under(line) : pr.over(line);
  const gap = pr.mean - line;
  const lean = pSide >= 0.58 ? ' lean' : pSide <= 0.42 ? ' against' : '';
  const tip = `Hoop Lab projection ${pr.mean.toFixed(1)} ${STATS[stat].short} (${pr.minutes.toFixed(1)} min, opponent ×${pr.opp.toFixed(2)}, pace ×${pr.pace.toFixed(2)}${pr.absent.length ? `, with ${pr.absent.length} teammate${pr.absent.length > 1 ? 's' : ''} out` : ''}). ${Math.round(pSide * 100)}% chance of the ${side === 'u' ? 'under' : 'over'} ${line}. See model.html for how it's built and how accurate it has been.`;
  return `<a class="projtag${lean}" href="model.html" title="${esc(tip)}">Proj <b>${pr.mean.toFixed(1)}</b> <small>${signed(Math.round(gap * 10) / 10)}</small> · ${Math.round(pSide * 100)}% ${side === 'u' ? 'U' : 'O'}</a>`;
}

/* Projection box for the player page line card. */
function projBoxHTML(L, pid, stat, line, g, rows) {
  const pr = project(L, pid, stat, g, rows ? { rows } : {});
  if (!pr) return '';
  const names = pr.absent.map(id => lastName((L.players[id] || {}).n || id));
  const o = pr.over(line), u = pr.under(line);
  return `<div class="projbox">
    <div><small>PROJECTION</small><b>${pr.mean.toFixed(1)}</b><span class="muted">${signed(Math.round((pr.mean - line) * 10) / 10)} vs ${line}</span></div>
    <div><small>OVER ${line}</small><b class="${o >= 0.58 ? 'evpos' : ''}">${Math.round(o * 100)}%</b><span class="muted">under ${Math.round(u * 100)}%</span></div>
    <p class="note">${pr.minutes.toFixed(1)} projected minutes · opponent ×${pr.opp.toFixed(2)} · pace ×${pr.pace.toFixed(2)}${names.length ? ` · adjusted for ${esc(names.join(', '))} out` : ''}.
      <a href="model.html" style="color:var(--accent)">How it works and how accurate it's been →</a></p></div>`;
}

if (typeof module !== 'undefined') {
  module.exports = { MODEL, MODEL_STATS, nbCdf, probOver, probUnder, modelContext, oppFactor, paceFactor, missingMates, mateSplit, project, calibration, brier };
}
