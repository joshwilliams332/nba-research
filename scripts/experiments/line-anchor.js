// Step 1 of the model rebuild (Nov 17, 2026): anchor on the books. For every real prop line in store/odds/props
// (graded against the box scores), the books-implied mean is the mean that makes the model's distribution give the
// books' no-vig chance (median over books at the same line) at their line; the final mean = book mean + k * (model mean -
// book mean). k = 0 is the books, k = 1 the old model. Scored by log loss (lower is better) and by the picks rule
// (54%+, 3%+ edge at the posted price), on the first week (Oct 28 - Nov 2, tuning) and Nov 3 on (held out).
// Run after `python3 scripts/build_data.py --offline` with the data branch in store/:  node scripts/experiments/line-anchor.js
const R = require('path').join(__dirname, '..', '..'), fs = require('fs');
Object.assign(globalThis, require(R + '/site/assets/common.js'));
for (const f of ['context', 'lines']) { try { Object.assign(globalThis, require(R + `/site/assets/${f}.js`)); } catch (e) {} }
const M = require(R + '/site/assets/model.js');
const r = n => JSON.parse(fs.readFileSync(`${R}/site/data/${n}.json`));
const L = indexLab(r('meta'), r('teams'), r('games')); for (const n of ['players', 'logs']) L[n] = r(n);
L.injuries = [];
const imp = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const days = fs.readdirSync(`${R}/store/odds/props`).filter(f => /^2026-1[01]-\d\d\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
function market(pr) {
  const vals = [];
  for (const v of Object.values(pr.books || {})) if (v && v[0] === pr.l && v[1] && v[2]) { const o = imp(v[1]), u = imp(v[2]); vals.push(o / (o + u)); }
  if (!vals.length && pr.o && pr.u) { const o = imp(pr.o), u = imp(pr.u); vals.push(o / (o + u)); }
  if (!vals.length) return null; vals.sort((a, b) => a - b); return vals[Math.floor(vals.length / 2)];
}
function bookMean(line, p, disp) {   // probOver rises with the mean: bisect
  let lo = 0.05, hi = Math.max(5, line * 4);
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (M.probOver(line, mid, disp) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const items = [];
for (const day of days) {
  const raw = JSON.parse(fs.readFileSync(`${R}/store/odds/props/${day}.json`));
  for (const [gid, props] of Object.entries(raw.games)) {
    const g = L.byId.get(gid); if (!g || g.state !== 'post') continue;
    for (const pr of props) {
      if (!STATS[pr.s] || STATS[pr.s].period || !L.players[pr.id]) continue;
      const row = playerRows(L, pr.id).find(x => x.g.id === gid); if (!row || !(row.min > 0)) continue;
      const actual = STATS[pr.s].f(row); if (actual === pr.l) continue;
      const mk = market(pr); if (mk == null) continue;
      const pj = M.project(L, pr.id, pr.s, g, { absent: [] }); if (!pj) continue;
      items.push({ day, late: day >= '2026-11-03', s: pr.s, l: pr.l, o: pr.o, u: pr.u, mk, mu: pj.mean, disp: pj.disp, y: actual > pr.l ? 1 : 0,
        bm: bookMean(pr.l, Math.min(0.97, Math.max(0.03, mk)), pj.disp) });
    }
  }
}
const ll = (p, y) => { p = Math.min(0.97, Math.max(0.03, p)); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
function score(sel, k) {
  let a = 0, b = 0, n = 0; const pk = [0, 0, 0];
  for (const it of sel) {
    const mu = it.bm + k * (it.mu - it.bm), p = M.probOver(it.l, mu, it.disp);
    a += ll(p, it.y); b += ll(it.mk, it.y); n++;
    for (const side of ['o', 'u']) {
      const price = side === 'o' ? it.o : it.u; if (!price || price < -200 || price > 180) continue;
      const ps = side === 'o' ? p : 1 - p, dec = price > 0 ? 1 + price / 100 : 1 + 100 / -price;
      if (ps * dec - 1 >= 0.03 && ps >= 0.54) { const win = side === 'o' ? it.y === 1 : it.y === 0; pk[0] += win; pk[1]++; pk[2] += win ? dec - 1 : -1; }
    }
  }
  return { model: a / n, books: b / n, n, picks: pk };
}
const fmt = s => `score ${s.model.toFixed(4)} vs books ${s.books.toFixed(4)} (${s.model < s.books - 1e-6 ? 'BETTER' : s.model > s.books + 1e-6 ? 'worse' : 'same'}) n=${s.n} | picks ${s.picks[0]}-${s.picks[1] - s.picks[0]} ${s.picks[2] >= 0 ? '+' : ''}${s.picks[2].toFixed(1)}u`;
const early = items.filter(i => !i.late), late = items.filter(i => i.late);
console.log('Books-implied mean vs the model mean (avg model - books):', (items.reduce((a, i) => a + i.mu - i.bm, 0) / items.length).toFixed(2));
for (const k of [0, 0.1, 0.2, 0.3, 0.5, 1]) console.log(`k=${k}`.padEnd(6), 'early', fmt(score(early, k)), '\n      late ', fmt(score(late, k)));
console.log('\nBy stat, best k on the early weeks, then checked on the late weeks:');
for (const s of ['pts', 'reb', 'ast', 'fg3m']) {
  const e = early.filter(i => i.s === s), l = late.filter(i => i.s === s);
  let best = 0, bv = Infinity; for (const k of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) { const v = score(e, k).model; if (v < bv) { bv = v; best = k; } }
  console.log(`  ${s.padEnd(5)} best k ${best} | early ${fmt(score(e, best))}\n        late  ${fmt(score(l, best))}`);
}
