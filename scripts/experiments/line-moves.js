// Does the model predict which way the books' points line moves between the morning pull and the pre-tip pull?
// (Nov 17, 2026; *-close.json days.) Run after build_data.py --offline: node scripts/experiments/line-moves.js
const R = require('path').join(__dirname, '..', '..'), fs = require('fs');
Object.assign(globalThis, require(R + '/site/assets/common.js'));
for (const f of ['context', 'lines']) { try { Object.assign(globalThis, require(R + `/site/assets/${f}.js`)); } catch (e) {} }
const M = require(R + '/site/assets/model.js');
const rd = n => JSON.parse(fs.readFileSync(`${R}/site/data/${n}.json`));
const L = indexLab(rd('meta'), rd('teams'), rd('games')); for (const n of ['players', 'logs']) L[n] = rd(n); L.injuries = [];
const imp = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
const nv = pr => { const v = []; for (const b of Object.values(pr.books || {})) if (b && b[0] === pr.l && b[1] && b[2]) { const o = imp(b[1]), u = imp(b[2]); v.push(o / (o + u)); } if (!v.length && pr.o && pr.u) { const o = imp(pr.o), u = imp(pr.u); v.push(o / (o + u)); } if (!v.length) return null; v.sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const res = {}; let n = 0;
for (const f of fs.readdirSync(`${R}/store/odds/props`).filter(f => f.endsWith('-close.json'))) {
  const day = f.slice(0, 10), close = JSON.parse(fs.readFileSync(`${R}/store/odds/props/${f}`)).games;
  let morning; try { morning = JSON.parse(fs.readFileSync(`${R}/store/odds/props/${day}.json`)).games; } catch (e) { continue; }
  for (const [gid, props] of Object.entries(close)) {
    const g = L.byId.get(gid); if (!g) continue;
    for (const c of props) {
      if (c.s !== 'pts') continue; const m = (morning[gid] || []).find(x => x.id === c.id && x.s === 'pts'); if (!m) continue;
      const pj = M.project(L, c.id, 'pts', g, { absent: [] }); if (!pj) continue;
      // movement toward the over: line went up, or same line with a higher no-vig over chance
      const mo = nv(m), co = nv(c); if (mo == null || co == null) continue;
      const move = c.l !== m.l ? Math.sign(c.l - m.l) : (Math.abs(co - mo) >= 0.02 ? Math.sign(co - mo) : 0);
      const lean = pj.over(m.l) - mo; if (move === 0) continue; n++;
      for (const t of [0.05, 0.10, 0.15]) if (Math.abs(lean) >= t) { const z = res[t] = res[t] || [0, 0]; z[0] += Math.sign(lean) === move; z[1]++; }
    }
  }
}
console.log('morning -> pre-tip points props that moved:', n);
for (const [t, z] of Object.entries(res)) console.log(`model leaning ${t * 100}%+ off the morning books: line moved its way ${z[0]} of ${z[1]} (${(z[0] / z[1] * 100).toFixed(0)}%)`);
