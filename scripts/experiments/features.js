// Model rebuild step 2 (Nov 17, 2026): test new inputs one at a time on every player-game of last season (2025-26) and
// this season, scored by how likely each projection made the actual result (negative-binomial log score; higher is
// better) and by mean absolute error. Past seasons have no sportsbook prop lines (paid-only), so this measures accuracy
// against what happened; the real-line test is scripts/experiments/line-anchor.js.
//   baseline  current model (absent teammates not used: they aren't known for past games)
//   volume    points = minutes x (2PA, 3PA, FTA per minute) x each shot's make rate, shrunk to the league average,
//             x the same opponent and pace factors (hot shooting regresses; attempts are steadier than makes)
//   total     mean x (team's implied points from the spread / total / its recent average)^ALPHA
//   blowout   starters' minutes cut when the spread is big: x (1 - BETA x (|spread| - 9)) past 9 points
// Run after `python3 scripts/build_data.py --offline` with the data branch in store/: node scripts/experiments/features.js
const R = require('path').join(__dirname, '..', '..'), fs = require('fs');
Object.assign(globalThis, require(R + '/site/assets/common.js'));
for (const f of ['context', 'lines']) { try { Object.assign(globalThis, require(R + `/site/assets/${f}.js`)); } catch (e) {} }
const M = require(R + '/site/assets/model.js');
const rd = n => JSON.parse(fs.readFileSync(`${R}/site/data/${n}.json`));
const L = indexLab(rd('meta'), rd('teams'), rd('games')); for (const n of ['players', 'logs']) L[n] = rd(n);
L.injuries = [];
const STAT_LIST = ['pts', 'reb', 'ast', 'fg3m'];
const ALPHAS = [0.5, 1], BETAS = [0.01, 0.02];
const decay = (age, h) => Math.pow(0.5, age / h);

// league shooting baselines per season (made / attempted)
const league = {};
for (const pid of Object.keys(L.logs)) for (const r of playerRows(L, pid)) {
  const s = league[r.g.s] = league[r.g.s] || { m2: 0, a2: 0, m3: 0, a3: 0, mf: 0, af: 0 };
  s.m2 += r.fgm - r.fg3m; s.a2 += r.fga - r.fg3a; s.m3 += r.fg3m; s.a3 += r.fg3a; s.mf += r.ftm; s.af += r.fta;
}
// team points per game, in date order, for recent averages
const teamPts = {};
for (const g of [...L.games].filter(g => g.state === 'post' && g.hs != null).sort((a, b) => a.t < b.t ? -1 : 1)) {
  (teamPts[g.h] = teamPts[g.h] || []).push([g.t, g.hs]); (teamPts[g.a] = teamPts[g.a] || []).push([g.t, g.as]);
}
const recentTeamPts = (team, t) => { const l = (teamPts[team] || []).filter(x => x[0] < t).slice(-20); return l.length >= 5 ? l.reduce((a, x) => a + x[1], 0) / l.length : null; };

function volumePoints(rows, minutes, season, of, pf) {
  const lg = league[season] || league[season - 1];
  let a2 = 0, a3 = 0, af = 0, wm = 0, m2 = 0, n2 = 0, m3 = 0, n3 = 0, mf = 0, nf = 0;
  rows.slice().reverse().forEach((r, age) => {
    const w = decay(age, M.MODEL.rateHalfLife);
    a2 += w * (r.fga - r.fg3a); a3 += w * r.fg3a; af += w * r.fta; wm += w * r.min;
    m2 += r.fgm - r.fg3m; n2 += r.fga - r.fg3a; m3 += r.fg3m; n3 += r.fg3a; mf += r.ftm; nf += r.fta;
  });
  const pad = 30;  // minutes of league-typical volume
  const p2 = (m2 + 150 * lg.m2 / lg.a2) / (n2 + 150), p3 = (m3 + 150 * lg.m3 / lg.a3) / (n3 + 150), pft = (mf + 60 * lg.mf / lg.af) / (nf + 60);
  const per = (a2 * 2 * p2 + a3 * 3 * p3 + af * pft) / (wm + pad);
  return minutes * per * of * pf;
}

const logp = (k, m, d) => { const p = M.nbCdf(k, m, d) - (k > 0 ? M.nbCdf(k - 1, m, d) : 0); return Math.log(Math.max(p, 1e-9)); };
const acc = {};
const add = (season, stat, variant, mean, disp, actual) => {
  const k = `${season}|${stat}|${variant}`, z = acc[k] = acc[k] || [0, 0, 0, 0];
  z[0] += logp(actual, Math.max(mean, 0.05), disp); z[1] += Math.abs(actual - mean); z[2] += actual - mean; z[3]++;
};

let done = 0;
for (const g of L.games) {
  if (g.state !== 'post' || g.hs == null || g.st !== 2 || (g.s !== 2026 && g.s !== 2027)) continue;
  const line = g.line && g.line.sp != null && g.line.tot != null ? g.line : null;
  const implied = line ? { [g.h]: line.tot / 2 - line.sp / 2, [g.a]: line.tot / 2 + line.sp / 2 } : null;
  const spread = line ? Math.abs(line.sp) : null;
  for (const pid of Object.keys(L.logs)) {
    const all = playerRows(L, pid); const row = all.find(x => x.gid === g.id); if (!row || !(row.min > 0)) continue;
    const prior = all.filter(x => x.g.t < g.t && x.g.s >= g.s - 1 && x.min > 0); if (prior.length < 10) continue;
    for (const stat of STAT_LIST) {
      const pj = M.project(L, pid, stat, g, { absent: [], team: row.team }); if (!pj) continue;
      const actual = STATS[stat].f(row);
      add(g.s, stat, 'baseline', pj.mean, pj.disp, actual);
      if (stat === 'pts') add(g.s, stat, 'volume', volumePoints(prior, pj.minutes, g.s, pj.opp || 1, pj.pace || 1), pj.disp, actual);
      const tp = implied && recentTeamPts(row.team, g.t);
      for (const a of ALPHAS) add(g.s, stat, `total a=${a}`, tp ? pj.mean * Math.pow(implied[row.team] / tp, a) : pj.mean, pj.disp, actual);
      const starter = pj.minutes >= 28;
      for (const b of BETAS) add(g.s, stat, `blowout b=${b}`, starter && spread > 9 ? pj.mean * Math.max(0.75, 1 - b * (spread - 9)) : pj.mean, pj.disp, actual);
    }
    done++;
  }
}
console.log(`player-games scored: ${done}`);
for (const season of [2026, 2027]) for (const stat of STAT_LIST) {
  const rows = Object.entries(acc).filter(([k]) => k.startsWith(`${season}|${stat}|`)).map(([k, z]) => [k.split('|')[2], z]);
  const base = rows.find(r => r[0] === 'baseline')[1];
  console.log(`\n${season === 2026 ? '2025-26' : '2026-27'} ${stat} (n=${base[3]})`);
  for (const [v, z] of rows) console.log(`  ${v.padEnd(14)} log score ${(z[0] / z[3]).toFixed(4)} (${((z[0] - base[0]) / z[3] >= 0 ? '+' : '')}${((z[0] - base[0]) / z[3]).toFixed(4)})  MAE ${(z[1] / z[3]).toFixed(3)}  bias ${(z[2] / z[3]).toFixed(2)}`);
}
