// Model rebuild step 3 (Nov 17, 2026): minutes inputs, scored on every player-game of 2025-26 and 2026-27. Projections
// scale with minutes, so a minutes change rescales the mean. ORACLE variants use what is only known near tip-off
// (tonight's starter flag from the box score, which rotation regulars sat) to measure what late news is worth.
// Run after `python3 scripts/build_data.py --offline` with the data branch in store/: node scripts/experiments/minutes.js
const R = require('path').join(__dirname, '..', '..'), fs = require('fs');
Object.assign(globalThis, require(R + '/site/assets/common.js'));
for (const f of ['context', 'lines']) { try { Object.assign(globalThis, require(R + `/site/assets/${f}.js`)); } catch (e) {} }
const M = require(R + '/site/assets/model.js');
const rd = n => JSON.parse(fs.readFileSync(`${R}/site/data/${n}.json`));
const L = indexLab(rd('meta'), rd('teams'), rd('games')); for (const n of ['players', 'logs']) L[n] = rd(n);
L.injuries = [];
const STAT_LIST = ['pts', 'reb', 'ast', 'fg3m'];
const decay = (age, h) => Math.pow(0.5, age / h);
const logp = (k, m, d) => { const p = M.nbCdf(k, m, d) - (k > 0 ? M.nbCdf(k - 1, m, d) : 0); return Math.log(Math.max(p, 1e-9)); };
const rowsOf = {}; for (const pid of Object.keys(L.logs)) rowsOf[pid] = playerRows(L, pid);
// box-score lineups per game and team, for "who sat"
const byGameTeam = {};
for (const [pid, rows] of Object.entries(rowsOf)) for (const r of rows) if (r.min > 0) (byGameTeam[`${r.gid}|${r.team}`] = byGameTeam[`${r.gid}|${r.team}`] || new Set()).add(pid);
const rosterRecent = {}; // team -> pid -> rows (for rotation regulars)
for (const [pid, rows] of Object.entries(rowsOf)) for (const r of rows) ((rosterRecent[r.team] = rosterRecent[r.team] || {})[pid] = rosterRecent[r.team][pid] || []).push(r);
const acc = {}, macc = {};
const add = (season, stat, v, mean, disp, actual) => { const k = `${season}|${stat}|${v}`, z = acc[k] = acc[k] || [0, 0, 0]; z[0] += logp(actual, Math.max(mean, 0.05), disp); z[1] += Math.abs(actual - mean); z[2]++; };
const addMin = (season, v, pm, am) => { const k = `${season}|${v}`, z = macc[k] = macc[k] || [0, 0, 0]; z[0] += Math.abs(am - pm); z[1] += am - pm; z[2]++; };
function roleMinutes(prior, starter) {
  const same = prior.filter(r => r.starter === starter).slice(-15).reverse(); if (same.length < 3) return null;
  let w = 0, m = 0; same.forEach((r, age) => { const x = decay(age, M.MODEL.minHalfLife); w += x; m += x * r.min; }); return m / w;
}
let n = 0;
for (const g of L.games) {
  if (g.state !== 'post' || g.hs == null || g.st !== 2 || (g.s !== 2026 && g.s !== 2027)) continue;
  for (const team of [g.h, g.a]) {
    const played = byGameTeam[`${g.id}|${team}`] || new Set();
    // regulars: 20+ minutes in 5+ of the team's last 10 games before tonight
    const regulars = Object.entries(rosterRecent[team] || {}).filter(([, rs]) => rs.filter(r => r.g.t < g.t && r.g.s === g.s).slice(-10).filter(r => r.min >= 20).length >= 5).map(([pid]) => pid);
    const sat = regulars.filter(pid => !played.has(pid));
    for (const pid of played) {
      const all = rowsOf[pid], row = all.find(x => x.gid === g.id); if (!row || !(row.min > 0)) continue;
      const prior = all.filter(x => x.g.t < g.t && x.g.s >= g.s - 1 && x.min > 0); if (prior.length < 10) continue;
      const lastStart = prior[prior.length - 1].starter;
      for (const stat of STAT_LIST) {
        const pj = M.project(L, pid, stat, g, { absent: [], team }); if (!pj || !pj.minutes) continue;
        const actual = STATS[stat].f(row), scale = mins => (mins ? pj.mean * mins / pj.minutes : pj.mean);
        add(g.s, stat, 'baseline', pj.mean, pj.disp, actual);
        const role = roleMinutes(prior, lastStart); add(g.s, stat, 'role (last game start/bench)', scale(role), pj.disp, actual);
        const oracle = roleMinutes(prior, row.starter); add(g.s, stat, 'ORACLE tonight start/bench', scale(oracle), pj.disp, actual);
        for (const [up, dn] of [[0.03, 0.04], [0.03, 0.08]]) add(g.s, stat, `starter +${up * 100}% / bench -${dn * 100}%`, pj.mean * (lastStart ? 1 + up : 1 - dn), pj.disp, actual);
        const pjA = sat.length ? M.project(L, pid, stat, g, { absent: sat, team }) : pj;
        add(g.s, stat, 'ORACLE who sat (injury news)', (pjA || pj).mean, pj.disp, actual);
        if (stat === 'pts') {
          addMin(g.s, 'baseline', pj.minutes, row.min); addMin(g.s, 'role', role || pj.minutes, row.min); addMin(g.s, 'ORACLE start/bench', oracle || pj.minutes, row.min);
          addMin(g.s, 'starter +3% / bench -4%', pj.minutes * (lastStart ? 1.03 : 0.96), row.min);
          addMin(g.s, row.starter ? 'baseline · starters' : 'baseline · bench', pj.minutes, row.min);
          addMin(g.s, row.rest === 0 ? 'baseline · back-to-back' : 'baseline · rested', pj.minutes, row.min);
        }
      }
      n++;
    }
  }
}
console.log('player-games', n);
for (const season of [2026, 2027]) {
  console.log(`\n${season === 2026 ? '2025-26' : '2026-27'} MINUTES (projected vs played)`);
  for (const [k, z] of Object.entries(macc).filter(([k]) => k.startsWith(season + '|'))) console.log(`  ${k.split('|')[1].padEnd(26)} n=${String(z[2]).padStart(5)}  MAE ${(z[0] / z[2]).toFixed(2)}  bias ${(z[1] / z[2]).toFixed(2)} (played - projected)`);
  for (const stat of STAT_LIST) {
    const rows = Object.entries(acc).filter(([k]) => k.startsWith(`${season}|${stat}|`)); const base = acc[`${season}|${stat}|baseline`];
    console.log(`  ${stat}`);
    for (const [k, z] of rows) console.log(`    ${k.split('|')[2].padEnd(30)} log score ${((z[0] - base[0]) / z[2] >= 0 ? '+' : '')}${((z[0] - base[0]) / z[2]).toFixed(4)}  MAE ${(z[1] / z[2]).toFixed(3)}`);
  }
}
