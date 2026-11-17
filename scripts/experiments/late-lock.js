// Model rebuild step 4 (Nov 17, 2026): would a later lock help? Scores the model (books-anchored, k = share of the gap)
// against the books' pre-tip points lines (store/odds/props/*-close.json, Oct 28 - Nov 10), with and without tonight's
// starters (from the box score; only known near tip). Also compares the morning and closing lines on the same props.
// Run after `python3 scripts/build_data.py --offline` with the data branch in store/: node scripts/experiments/late-lock.js
const R = require('path').join(__dirname, '..', '..'), fs = require('fs');
Object.assign(globalThis, require(R + '/site/assets/common.js'));
for (const f of ['context', 'lines']) { try { Object.assign(globalThis, require(R + `/site/assets/${f}.js`)); } catch (e) {} }
const M = require(R + '/site/assets/model.js');
const rd = n => JSON.parse(fs.readFileSync(`${R}/site/data/${n}.json`));
const L = indexLab(rd('meta'), rd('teams'), rd('games')); for (const n of ['players', 'logs']) L[n] = rd(n);
L.injuries = [];
const imp = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const decay = (age, h) => Math.pow(0.5, age / h);
function market(pr) { const v = []; for (const b of Object.values(pr.books || {})) if (b && b[0] === pr.l && b[1] && b[2]) { const o = imp(b[1]), u = imp(b[2]); v.push(o / (o + u)); }
  if (!v.length && pr.o && pr.u) { const o = imp(pr.o), u = imp(pr.u); v.push(o / (o + u)); } if (!v.length) return null; v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; }
function bookMean(line, p, d) { let lo = 0.05, hi = Math.max(5, line * 4); for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (M.probOver(line, m, d) < p) lo = m; else hi = m; } return (lo + hi) / 2; }
function roleMinutes(prior, starter) { const s = prior.filter(r => r.starter === starter).slice(-15).reverse(); if (s.length < 3) return null; let w = 0, m = 0; s.forEach((r, a) => { const x = decay(a, M.MODEL.minHalfLife); w += x; m += x * r.min; }); return m / w; }
const ll = (p, y) => { p = Math.min(0.97, Math.max(0.03, p)); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const items = [];
for (const f of fs.readdirSync(`${R}/store/odds/props`).filter(f => f.endsWith('-close.json'))) {
  const day = f.slice(0, 10), close = JSON.parse(fs.readFileSync(`${R}/store/odds/props/${f}`));
  let morning = {}; try { morning = JSON.parse(fs.readFileSync(`${R}/store/odds/props/${day}.json`)).games; } catch (e) {}
  for (const [gid, props] of Object.entries(close.games)) {
    const g = L.byId.get(gid); if (!g || g.state !== 'post') continue;
    for (const pr of props) {
      if (pr.s !== 'pts' || !L.players[pr.id]) continue;
      const all = playerRows(L, pr.id), row = all.find(x => x.gid === gid); if (!row || !(row.min > 0)) continue;
      const actual = row.pts; if (actual === pr.l) continue;
      const mk = market(pr); if (mk == null) continue;
      const pj = M.project(L, pr.id, 'pts', g, { absent: [] }); if (!pj || !pj.minutes) continue;
      const prior = all.filter(x => x.g.t < g.t && x.g.s >= g.s - 1 && x.min > 0);
      const om = roleMinutes(prior, row.starter);
      const mp = (morning[gid] || []).find(x => x.id === pr.id && x.s === 'pts');
      items.push({ l: pr.l, y: actual > pr.l ? 1 : 0, mk, disp: pj.disp, mu: pj.mean, muS: om ? pj.mean * om / pj.minutes : pj.mean,
        bm: bookMean(pr.l, Math.min(0.97, Math.max(0.03, mk)), pj.disp), morningMk: mp && mp.l === pr.l ? market(mp) : null, moved: mp ? pr.l - mp.l : null });
    }
  }
}
const n = items.length; console.log('closing points lines graded:', n);
const books = items.reduce((a, i) => a + ll(i.mk, i.y), 0) / n;
console.log('books at close            ', books.toFixed(4));
const same = items.filter(i => i.morningMk != null); if (same.length) console.log(`books in the morning (same line, n=${same.length}) ${(same.reduce((a, i) => a + ll(i.morningMk, i.y), 0) / same.length).toFixed(4)} vs close ${(same.reduce((a, i) => a + ll(i.mk, i.y), 0) / same.length).toFixed(4)}`);
const mv = items.filter(i => i.moved); console.log(`lines that moved between morning and close: ${mv.length} of ${items.filter(i => i.moved != null).length}`);
for (const [name, key] of [['model', 'mu'], ['model + tonight\'s starters', 'muS']]) for (const k of [0, 0.1, 0.2, 0.3, 1]) {
  const s = items.reduce((a, i) => a + ll(M.probOver(i.l, i.bm + k * (i[key] - i.bm), i.disp), i.y), 0) / n;
  console.log(`${name.padEnd(28)} k=${String(k).padEnd(4)} ${s.toFixed(4)} ${s < books - 1e-6 ? 'BETTER than close' : s > books + 1e-6 ? 'worse' : 'same'}`);
}
