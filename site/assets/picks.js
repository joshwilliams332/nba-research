/* Hoop Lab saved picks: stored on this device (localStorage), graded from box scores, summarized, shared as images.
   Loaded after common.js. Picks are for tracking only; nothing is sent anywhere. */
'use strict';

const PICKS_KEY = 'hooplab.picks';
const PICKS_VERSION = 1;
const DEFAULT_PRICE = -110;  // used for payouts when a pick was saved without a price (e.g. a typical line)

// ---------------------------------------------------------------- storage

function loadPicks() {
  try {
    const raw = JSON.parse(localStorage.getItem(PICKS_KEY));
    return Array.isArray(raw) ? raw.filter(validPick) : [];
  } catch (e) { return []; }
}

function savePicks(list) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}

/* Same game, player (or team), market, side and line = the same pick. */
function pickKey(p) {
  if (p.type === 'parlay') return `parlay|${(p.legs || []).map(pickKey).sort().join('+')}|${p.savedAt || ''}`;
  return [p.gid, p.pid || p.team || '', p.stat, p.side, p.line].join('|');
}

function makePick(fields) {
  const p = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    savedAt: new Date().toISOString(),
    gid: String(fields.gid), stat: fields.stat, side: fields.side, line: +fields.line,
    price: fields.price == null || fields.price === '' ? null : +fields.price,
    book: fields.book || null, units: fields.units > 0 ? +fields.units : 1,
  };
  if (fields.pid) p.pid = String(fields.pid);
  if (fields.team) p.team = fields.team;
  if (fields.name) p.name = fields.name;
  return p;
}

/* Add the pick, or remove it if the same pick is already saved. Returns true when it ends up saved. */
function togglePick(fields) {
  const list = loadPicks(), p = makePick(fields), key = pickKey(p);
  const i = list.findIndex(x => pickKey(x) === key);
  if (i >= 0) { list.splice(i, 1); savePicks(list); return false; }
  list.push(p);
  savePicks(list);
  return true;
}

function savedKeys() {
  return new Set(loadPicks().map(pickKey));
}

// ---------------------------------------------------------------- parlays

const PARLAY_MAX_LEGS = 12;

/* American odds <-> decimal. */
const toDecimal = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
function toAmerican(d) {
  if (!(d > 1)) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/* The parlay's price from its legs' prices (a leg without one counts as -110). */
function parlayPrice(legs) {
  if (!legs.length) return null;
  return toAmerican(legs.reduce((d, l) => d * toDecimal(l.price == null ? DEFAULT_PRICE : l.price), 1));
}

/* A profit boost of `boost` % on American odds: the winnings grow, the stake doesn't. */
function boostedPrice(price, boost) {
  if (price == null || !(boost > 0)) return price;
  return toAmerican(1 + (toDecimal(price) - 1) * (1 + boost / 100));
}

/* A parlay from saved singles (copies of their legs, so removing a single later doesn't change the parlay).
   fields: {legs, price?, boost?, units?, book?}. With no price, it's worked out from the legs. */
function makeParlay(fields) {
  const legs = fields.legs.map(l => {
    const leg = { gid: String(l.gid), stat: l.stat, side: l.side, line: +l.line, price: l.price == null || l.price === '' ? null : +l.price };
    for (const k of ['pid', 'team', 'name', 'book']) if (l[k]) leg[k] = String(l[k]);
    return leg;
  });
  const price = fields.price == null || fields.price === '' ? parlayPrice(legs) : +fields.price;
  const p = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, type: 'parlay',
    savedAt: new Date().toISOString(), legs, price, units: fields.units > 0 ? +fields.units : 1,
    book: fields.book || null,
  };
  if (fields.boost > 0) p.boost = +fields.boost;
  return p;
}

function validParlay(p) {
  if (!p.id || !Array.isArray(p.legs) || p.legs.length < 2 || p.legs.length > PARLAY_MAX_LEGS) return false;
  if (!p.legs.every(l => validPick({ ...l, id: 'leg' }))) return false;
  if (p.price != null && (typeof p.price !== 'number' || !isFinite(p.price) || Math.abs(p.price) < 100)) return false;
  if (p.boost != null && !(typeof p.boost === 'number' && p.boost > 0 && p.boost <= 200)) return false;
  if (p.units != null && !(typeof p.units === 'number' && p.units > 0 && p.units <= 100)) return false;
  return true;
}

/* Grade a parlay like a sportsbook: any losing leg loses it (even while others are still to play); once every leg is
   decided, pushed or voided legs drop out and the price is recalculated from the remaining legs; if they all drop
   out it's a push. `legGrade(leg)` grades one leg (the page passes one that also reads live box scores).
   Returns {status, profit, legs: [grade per leg], price (the price it settled at), g (the latest leg's game)}. */
function gradeParlay(L, pick, legGrade = leg => gradeResult(L, leg)) {
  const legs = pick.legs.map(leg => legGrade({ ...leg, units: 1 }));
  const games = legs.map(x => x.g).filter(Boolean).sort((a, b) => (a.t < b.t ? -1 : 1));
  const g = games[games.length - 1] || null, units = pick.units || 1;
  const out = (status, profit, extra = {}) => ({ status, profit, legs, g, ...extra });
  if (legs.some(x => x.status === 'loss')) return out('loss', -units);
  if (legs.some(x => x.status === 'live')) return out('live', 0, { g: legs.find(x => x.status === 'live').g });
  if (legs.some(x => x.status === 'open')) return out('open', 0, { g: legs.find(x => x.status === 'open').g });
  const kept = pick.legs.filter((_, i) => legs[i].status === 'win');
  if (!kept.length) return out('push', 0);
  // All legs stand: the price you got. Some dropped out: rebuilt from the remaining legs' prices.
  const base = kept.length === pick.legs.length && pick.price != null ? pick.price : parlayPrice(kept);
  const price = boostedPrice(base, pick.boost);
  return out('win', payout('win', price, units), { price, reduced: kept.length < pick.legs.length });
}

// ---------------------------------------------------------------- import / export

const TEAM_MARKETS = ['ml', 'spread', 'total'];

/* A pick must name a game, a player or team, a known market, a side and a numeric line. */
function validPick(p) {
  if (p && p.type === 'parlay') return validParlay(p);
  if (!p || typeof p !== 'object' || !p.id || !p.gid || !(p.pid || p.team)) return false;
  const known = (typeof STATS !== 'undefined' && STATS[p.stat]) || TEAM_MARKETS.includes(p.stat);
  if (!known || !['o', 'u', 'h', 'a'].includes(p.side)) return false;
  if (typeof p.line !== 'number' || !isFinite(p.line)) return false;
  if (p.price != null && (typeof p.price !== 'number' || !isFinite(p.price) || Math.abs(p.price) < 100)) return false;
  if (p.units != null && !(typeof p.units === 'number' && p.units > 0 && p.units <= 100)) return false;
  return true;
}

function exportPicks(list = loadPicks()) {
  return JSON.stringify({ app: 'hooplab', v: PICKS_VERSION, picks: list });
}

/* Short code for copy/paste between devices: base64 of the export JSON. */
function exportCode(list = loadPicks()) {
  return btoa(unescape(encodeURIComponent(exportPicks(list))));
}

/* Parse a pasted code or file. Returns {picks, skipped} or throws with a readable message. */
function parseImport(text) {
  let data, s = String(text || '').trim();
  if (!s) throw new Error('Nothing to import.');
  if (s[0] !== '{' && s[0] !== '[') {
    try { s = decodeURIComponent(escape(atob(s.replace(/\s+/g, '')))); } catch (e) { throw new Error("That code isn't valid."); }
  }
  try { data = JSON.parse(s); } catch (e) { throw new Error("That isn't a Hoop Lab picks export."); }
  const raw = Array.isArray(data) ? data : data && data.app === 'hooplab' ? data.picks : null;
  if (!Array.isArray(raw)) throw new Error("That isn't a Hoop Lab picks export.");
  const picks = raw.filter(validPick);
  return { picks, skipped: raw.length - picks.length };
}

/* Merge imported picks into the saved list, skipping ones already there. Returns how many were added. */
function mergePicks(current, incoming) {
  const keys = new Set(current.map(pickKey)), ids = new Set(current.map(p => p.id));
  let added = 0;
  for (const p of incoming) {
    if (keys.has(pickKey(p)) || ids.has(p.id)) continue;
    current.push(p);
    keys.add(pickKey(p));
    added++;
  }
  return added;
}

// ---------------------------------------------------------------- grading

/* Profit in units for a result at American odds. A loss costs the stake; pushes and voids return it. */
function payout(result, price, units = 1) {
  const pr = price == null ? DEFAULT_PRICE : price;
  if (result === 'win') return pr > 0 ? units * pr / 100 : units * 100 / -pr;
  if (result === 'loss') return -units;
  return 0;
}

/* Over / under against the line, or ML / spread / total for a team pick. */
function settle(value, line, side) {
  if (value === line) return 'push';
  return (side === 'o' ? value > line : value < line) ? 'win' : 'loss';
}

/* {status, actual?, profit} for one pick.
   status: 'open' (not started), 'live', 'win' | 'loss' | 'push', 'void' (game final but the player didn't play,
   or the game is missing / postponed). Also carries `close` and `clv` when a closing line is on record. */
function gradePick(L, pick) {
  if (pick.type === 'parlay') return gradeParlay(L, pick);
  const grade = gradeResult(L, pick);
  const close = closeLine(L, pick);
  if (close != null) { grade.close = close; grade.clv = clvPoints(pick, close); }
  return grade;
}

function gradeResult(L, pick) {
  const g = L.byId.get(pick.gid);
  if (!g) return { status: 'void', profit: 0, why: 'game not found' };
  if (g.state === 'pre') return { status: 'open', g, profit: 0 };
  if (g.state === 'in') return { status: 'live', g, profit: 0 };
  if (g.state !== 'post' || g.hs == null) return { status: 'void', g, profit: 0, why: 'no final score' };
  let actual, result;
  if (pick.pid) {
    const row = playerRows(L, pick.pid).find(r => r.gid === pick.gid);
    if (!row) return { status: 'void', g, profit: 0, why: "didn't play" };
    const st = STATS[pick.stat];
    actual = st ? st.f(row) : undefined;
    if (actual == null || isNaN(actual)) return { status: 'void', g, profit: 0, why: 'stat unavailable' };
    result = settle(actual, pick.line, pick.side);
  } else {
    const s = teamSide(g, pick.team);
    if (pick.stat === 'ml') { actual = s.margin; result = s.win ? 'win' : 'loss'; }
    else if (pick.stat === 'spread') { actual = s.margin; result = settle(s.margin + pick.line, 0, 'o'); }
    else { actual = s.total; result = settle(s.total, pick.line, pick.side); }
  }
  return { status: result, g, actual, profit: payout(result, pick.price, pick.units || 1) };
}

/* Record, units and ROI over graded picks. ROI = profit / units risked on decided picks (wins + losses). */
function summarize(graded) {
  const s = { w: 0, l: 0, p: 0, v: 0, open: 0, profit: 0, risked: 0, roi: null, clvN: 0, clvSum: 0 };
  for (const { pick, grade } of graded) {
    const u = pick.units || 1;
    if (grade.status === 'win') { s.w++; s.risked += u; }
    else if (grade.status === 'loss') { s.l++; s.risked += u; }
    else if (grade.status === 'push') s.p++;
    else if (grade.status === 'void') s.v++;
    else s.open++;
    s.profit += grade.profit;
    if (grade.clv != null) { s.clvN++; s.clvSum += grade.clv; }
  }
  s.profit = Math.round(s.profit * 100) / 100;
  if (s.risked) s.roi = s.profit / s.risked;
  s.clv = s.clvN ? s.clvSum / s.clvN : null;
  return s;
}

// ---------------------------------------------------------------- closing line value

/* The closing line for a player pick, when the data has one. Accepts a few shapes so it works with or without
   the pre-tip pull: proplines[pid][gid][stat] = number (one pull: no close), or an object with a close line
   under `close` / `cl` / `c` (a number, or {l} / {line}). Props entries may also carry `cl` / `close`. */
function closeLine(L, pick) {
  if (!pick.pid) return null;
  const read = v => v == null ? null : typeof v === 'number' ? v : (typeof v === 'object' ? (v.l ?? v.line ?? null) : null);
  const entry = (((L.proplines || {})[pick.pid] || {})[pick.gid] || {})[pick.stat];
  if (entry && typeof entry === 'object') {
    const c = read(entry.close ?? entry.cl ?? entry.c);
    if (c != null) return c;
  }
  const prop = (((L.props || {}).games || {})[pick.gid] || []).find(p => p.id === pick.pid && p.s === pick.stat);
  if (prop) {
    const c = read(prop.close ?? prop.cl);
    if (c != null) return c;
  }
  return null;
}

/* Points of closing line value: positive when the line moved toward the pick after it was saved
   (over 22.5 that closed at 24.5 = +2). */
function clvPoints(pick, close) {
  if (close == null || pick.side === 'h' || pick.side === 'a') return null;
  return pick.side === 'o' ? close - pick.line : pick.line - close;
}

// ---------------------------------------------------------------- describing picks

function pickMarketLabel(stat) {
  if (stat === 'ml') return 'Money line';
  if (stat === 'spread') return 'Spread';
  if (stat === 'total') return 'Total';
  return (STATS[stat] || {}).label || stat;
}

/* "Over 24.5 Points", "Under 7.5 Assists", "PHI -4.5", "PHI ML". */
function pickText(p) {
  if (p.type === 'parlay') return `${p.legs.length}-leg parlay`;
  if (p.stat === 'ml') return `${p.team} ML`;
  if (p.stat === 'spread') return `${p.team} ${signed(p.line)}`;
  return `${p.side === 'o' ? 'Over' : 'Under'} ${p.line} ${pickMarketLabel(p.stat)}`;
}

/* Bookmark button for a pick. `fields` is stored as a data attribute and saved on tap by bindPickButtons. */
function pickButton(fields, saved) {
  const data = esc(JSON.stringify(fields));
  return `<button type="button" class="pickbtn${saved ? ' on' : ''}" data-pick="${data}" aria-pressed="${saved}"
    aria-label="${saved ? 'Remove from my picks' : 'Save to my picks'}" title="${saved ? 'Saved to My picks (tap to remove)' : 'Save to My picks'}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21V3Z"/></svg></button>`;
}

/* One delegated listener per container. Runs before the container's own click handlers (capture phase) and stops
   the tap there, so saving a pick doesn't also open a row or follow a card's link. */
function bindPickButtons(root, onChange) {
  if (!root || root.dataset.picksBound) return;
  root.dataset.picksBound = '1';
  root.addEventListener('click', e => {
    const b = e.target.closest('.pickbtn');
    if (!b || !root.contains(b)) return;
    e.preventDefault();
    e.stopPropagation();
    let fields;
    try { fields = JSON.parse(b.dataset.pick); } catch (err) { return; }
    const saved = togglePick(fields);
    b.classList.toggle('on', saved);
    b.setAttribute('aria-pressed', saved);
    b.setAttribute('aria-label', saved ? 'Remove from my picks' : 'Save to my picks');
    pickToast(saved ? 'Saved to My picks' : 'Removed from My picks', saved);
    if (onChange) onChange(saved, fields);
  }, true);
}

function pickToast(text, link) {
  let t = document.getElementById('picktoast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'picktoast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.innerHTML = `${esc(text)}${link ? ' · <a href="picks.html">View</a>' : ''}`;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- share card

/* Draw a share image (1080x1080) for one pick or for the record. Returns a canvas. */
function shareCanvas(opts) {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1080;
  const x = c.getContext('2d');
  const font = (w, s) => `${w} ${s}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const grad = x.createLinearGradient(0, 0, 1080, 1080);
  grad.addColorStop(0, '#12312f'); grad.addColorStop(0.55, '#0b0d10'); grad.addColorStop(1, '#3a1d0c');
  x.fillStyle = grad; x.fillRect(0, 0, 1080, 1080);
  // Brand: ball mark + name
  x.fillStyle = '#ff8a3d'; x.beginPath(); x.arc(110, 110, 40, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#1a0f05'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(70, 110); x.lineTo(150, 110); x.moveTo(110, 70); x.lineTo(110, 150); x.stroke();
  x.fillStyle = '#f1f3f6'; x.font = font(800, 52); x.fillText('Hoop Lab', 170, 128);
  x.fillStyle = '#8d95a3'; x.font = font(600, 30); x.fillText(opts.kicker || 'My picks', 72, 250);
  const wrap = (text, y, size, color, weight = 800, max = 936) => {
    x.font = font(weight, size); x.fillStyle = color;
    const words = String(text).split(' '); let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (x.measureText(test).width > max && line) { x.fillText(line, 72, y); y += size * 1.2; line = w; } else line = test;
    }
    if (line) { x.fillText(line, 72, y); y += size * 1.2; }
    return y;
  };
  let y = wrap(opts.title, 340, 76, '#f1f3f6');
  if (opts.subtitle) y = wrap(opts.subtitle, y + 10, 40, '#c9ced6', 600);
  if (opts.big) {
    x.font = font(900, 150); x.fillStyle = opts.bigColor || '#2ad38b'; x.fillText(opts.big, 72, Math.max(y + 170, 720));
  }
  (opts.lines || []).forEach((l, i) => { x.font = font(600, 36); x.fillStyle = '#c9ced6'; x.fillText(l, 72, 860 + i * 50); });
  x.fillStyle = '#5d6573'; x.font = font(500, 26);
  x.fillText('For tracking only. Past results do not predict future ones.', 72, 1030);
  return c;
}

/* Share the canvas with the Web Share API (phones), else download it. */
async function sharePNG(canvas, filename) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const file = typeof File !== 'undefined' ? new File([blob], filename, { type: 'image/png' }) : null;
  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Hoop Lab' });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;  // the person closed the share sheet
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

if (typeof module !== 'undefined') {
  module.exports = { toDecimal, toAmerican, parlayPrice, boostedPrice, makeParlay, validParlay, gradeParlay, gradeResult, pickKey, makePick, validPick, exportPicks, parseImport, mergePicks, payout, settle, gradePick, summarize, closeLine, clvPoints, pickText };
}
