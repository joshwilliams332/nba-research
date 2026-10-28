/* Line movement and closing line value (CLV).
   Props carry `open` (morning pull) and `close` (pre-tip pull) as [line, over, under, book]; games carry `open`
   (first line seen) next to `line` (latest, ESPN's closing number once the game starts). Loaded after common.js. */
'use strict';

/* American odds -> implied probability (with the book's margin). */
function oddsProb(american) {
  if (american == null || isNaN(american)) return null;
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

/* No-vig probability of the over from an over / under price pair (multiplicative: each side / their sum). */
function noVigOver(over, under) {
  const o = oddsProb(over), u = oddsProb(under);
  return o == null || u == null ? null : o / (o + u);
}

/* How a prop moved from the morning pull to the pre-tip pull, or null when there's nothing to compare.
   dl = line change; dp = change in the no-vig over probability (positive = money on the over). */
function propMove(prop) {
  if (!prop || !prop.open || !prop.close) return null;
  const [ol, oo, ou, obk] = prop.open, [cl, co, cu, cbk] = prop.close;
  const po = noVigOver(oo, ou), pc = noVigOver(co, cu);
  const dp = po != null && pc != null ? pc - po : 0;
  return { from: ol, to: cl, dl: cl - ol, dp, openO: oo, closeO: co, openU: ou, closeU: cu,
    sameBook: obk === cbk, book: cbk, size: Math.abs(cl - ol) + Math.abs(dp) * 20 };
}

/* "24.5 → 25.5 ↑" (or "O -110 → -125" when only the price moved); empty when it didn't move. */
function moveTag(prop) {
  const m = propMove(prop);
  if (!m || (m.dl === 0 && Math.abs(m.dp) < 0.015)) return '';
  const toward = m.dl > 0 || (m.dl === 0 && m.dp > 0) ? 'up' : 'down';
  const text = m.dl !== 0 ? `${m.from} → ${m.to}` : `O ${odds(m.openO)} → ${odds(m.closeO)}`;
  const title = `Morning ${m.from} (O ${odds(m.openO)} / U ${odds(m.openU)}), before tip ${m.to} (O ${odds(m.closeO)} / U ${odds(m.closeU)})`
    + `${m.sameBook ? '' : ', different books'}. ${toward === 'up' ? 'Moved toward the over.' : 'Moved toward the under.'}`;
  return `<span class="move ${toward}" title="${esc(title)}">${esc(text)} ${toward === 'up' ? '↑' : '↓'}</span>`;
}

/* Game line movement for the game page: "Spread opened PHI -3.5 · Total opened 235.5", only what changed. */
function gameMove(g) {
  const o = g.open, l = g.line;
  if (!o || !l) return '';
  const fav = sp => sp <= 0 ? `${g.h} ${signed(sp)}` : `${g.a} ${signed(-sp)}`;
  const out = [];
  if (o.sp != null && l.sp != null && o.sp !== l.sp) out.push(`Spread opened ${fav(o.sp)}, now ${fav(l.sp)}`);
  if (o.tot != null && l.tot != null && o.tot !== l.tot) out.push(`Total opened ${o.tot}, now ${l.tot} ${l.tot > o.tot ? '↑' : '↓'}`);
  if (o.mlh != null && l.mlh != null && o.mlh !== l.mlh) out.push(`${g.h} money line ${odds(o.mlh)} → ${odds(l.mlh)}`);
  return out.length ? `<p class="note movenote">${out.map(esc).join(' · ')}</p>` : '';
}

/* Closing line value of a pick against the closing line.
   pick: {line, price, side: 'o' | 'u'}; close: [line, over, under, book].
   points: how many points better your line was (over at 24.5 vs close 25.5 = +1).
   prob: closing no-vig probability of your side minus the probability your price implied; only when the lines
   match, since probabilities at different lines aren't comparable. Positive = you beat the close. */
function clv(pick, close) {
  if (!pick || !close || close[0] == null) return null;
  const [cl, co, cu] = close;
  const points = pick.side === 'u' ? pick.line - cl : cl - pick.line;
  let prob = null;
  if (cl === pick.line) {
    const pOver = noVigOver(co, cu), paid = oddsProb(pick.price);
    if (pOver != null && paid != null) prob = (pick.side === 'u' ? 1 - pOver : pOver) - paid;
  }
  return { points, prob };
}

if (typeof module !== 'undefined') {
  module.exports = { oddsProb, noVigOver, propMove, moveTag, gameMove, clv };
}
