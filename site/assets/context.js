/* Hoop Lab game context: pace, implied team totals and no-vig fair prices for props.
   Loaded after common.js. The math functions are pure and unit tested in tests/context.test.js. */
'use strict';

if (typeof module !== 'undefined' && typeof teamFinals === 'undefined') {
  // In Node (tests), pull the helpers common.js defines as browser globals.
  var { teamFinals, mean } = require('./common.js');  // eslint-disable-line no-var
}

// ---------------------------------------------------------------- pace

/* Possessions for one team in one game from box totals (the standard estimate). */
function possessions(t) {
  return t.fga - t.oreb + t.tov + 0.44 * t.fta;
}

/* game id -> team -> {fga, oreb, tov, fta, min, poss, pace}, summed from the player game logs.
   Pace = possessions per 48 minutes, averaging both teams' possession counts. */
function teamBoxTotals(L) {
  if (L._boxTotals) return L._boxTotals;
  const cols = L.meta.cols, at = k => 3 + cols.indexOf(k);
  const iF = at('fga'), iO = at('oreb'), iT = at('tov'), iFt = at('fta'), iM = at('min');
  const out = new Map();
  for (const rows of Object.values(L.logs || {})) {
    for (const r of rows) {
      if (!out.has(r[0])) out.set(r[0], {});
      const g = out.get(r[0]);
      const t = g[r[1]] || (g[r[1]] = { fga: 0, oreb: 0, tov: 0, fta: 0, min: 0 });
      t.fga += r[iF]; t.oreb += r[iO]; t.tov += r[iT]; t.fta += r[iFt]; t.min += r[iM];
    }
  }
  for (const g of out.values()) {
    const teams = Object.values(g);
    if (teams.length !== 2) continue;
    const poss = (possessions(teams[0]) + possessions(teams[1])) / 2;
    // Box minutes are rounded per player, so snap the team's minutes / 5 to 48 plus whole 5-minute overtimes.
    const played = Math.max(teams[0].min, teams[1].min) / 5;
    const minutes = 48 + 5 * Math.max(0, Math.round((played - 48) / 5));
    for (const t of teams) { t.poss = poss; t.pace = poss * 48 / minutes; }
  }
  L._boxTotals = out;
  return out;
}

/* Every team's pace over a window, ranked (1 = fastest).
   opts.season: games of that season (default: current, falling back to last season under minGames);
   opts.last: only the last N games. Returns {team: {pace, games, rank, season}}. */
function teamPace(L, opts = {}) {
  const key = `pace|${opts.season || ''}|${opts.last || ''}`;
  L._pace = L._pace || {};
  if (L._pace[key]) return L._pace[key];
  const box = teamBoxTotals(L);
  const minGames = opts.minGames || 5;
  const out = {};
  for (const team of Object.keys(L.teams)) {
    const paceIn = season => {
      let list = teamFinals(L, team).filter(s => !season || s.g.s === season);
      if (opts.last) list = list.slice(-opts.last);
      const vals = list.map(s => (box.get(s.g.id) || {})[team]).filter(t => t && t.pace).map(t => t.pace);
      return { pace: mean(vals), games: vals.length, season };
    };
    let r = paceIn(opts.last ? null : (opts.season || L.meta.season));
    if (!opts.last && !opts.season && r.games < minGames) {
      const prev = paceIn(L.meta.season - 1);
      if (prev.games) r = prev;
    }
    out[team] = r;
  }
  const order = Object.keys(out).filter(t => out[t].pace != null).sort((a, b) => out[b].pace - out[a].pace);
  order.forEach((t, i) => { out[t].rank = i + 1; });
  L._pace[key] = out;
  return out;
}

/* Expected pace for a game: the average of both teams' recent pace (last 10 games across seasons). */
function gamePace(L, g) {
  const p = teamPace(L, { last: 10 });
  const a = p[g.a], h = p[g.h];
  if (!a || !h || a.pace == null || h.pace == null) return null;
  return (a.pace + h.pace) / 2;
}

// ---------------------------------------------------------------- implied totals

/* Implied points for each side from a game line: home = total/2 - spread/2, away = total/2 + spread/2
   (spread is the home team's, negative when home is favored). */
function impliedTotals(line) {
  if (!line || line.tot == null || line.sp == null) return null;
  return { h: line.tot / 2 - line.sp / 2, a: line.tot / 2 + line.sp / 2 };
}

/* Implied totals for every team playing on a day, ranked highest first: team -> {pts, rank, of}. */
function slateImplied(L, day) {
  L._implied = L._implied || {};
  if (L._implied[day]) return L._implied[day];
  const list = [];
  for (const g of L.games) {
    if (g.d !== day) continue;
    const it = impliedTotals(g.line);
    if (!it) continue;
    list.push({ team: g.h, pts: it.h, gid: g.id }, { team: g.a, pts: it.a, gid: g.id });
  }
  list.sort((x, y) => y.pts - x.pts);
  const out = {};
  list.forEach((x, i) => { out[x.team] = { pts: x.pts, rank: i + 1, of: list.length, gid: x.gid }; });
  L._implied[day] = out;
  return out;
}

// ---------------------------------------------------------------- prices

/* American odds -> implied probability (with the vig) and decimal odds. */
function impliedProb(american) {
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}
function decimalOdds(american) {
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}
/* Probability -> fair American odds, rounded to a whole number. */
function americanFrom(p) {
  if (!(p > 0 && p < 1)) return null;
  return Math.round(p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p);
}

/* No-vig fair prices for one prop from its books ({book: [line, over, under]}).
   Only books hanging the main line with both sides count. Each book is devigged multiplicatively
   (over share of the two implied probabilities), then averaged into a consensus.
   Returns {line, books, fairO, fairU, fairOddsO, fairOddsU, bestO: {book, price, ev}, bestU, ev: 'o'|'u'|null}. */
function fairPrice(prop, minEdge = 0.02) {
  const line = prop.l;
  const at = Object.entries(prop.books || {}).filter(([, b]) => b && b[0] === line && b[1] != null && b[2] != null);
  if (!at.length) return null;
  const fairOs = at.map(([, b]) => {
    const o = impliedProb(b[1]), u = impliedProb(b[2]);
    return o / (o + u);
  });
  const fairO = mean(fairOs), fairU = 1 - fairO;
  const best = side => {
    const i = side === 'o' ? 1 : 2, p = side === 'o' ? fairO : fairU;
    const [book, b] = at.reduce((x, y) => (decimalOdds(y[1][i]) > decimalOdds(x[1][i]) ? y : x));
    return { book, price: b[i], ev: p * decimalOdds(b[i]) - 1 };
  };
  const bestO = best('o'), bestU = best('u');
  const ev = bestO.ev >= minEdge && bestO.ev >= bestU.ev ? 'o' : bestU.ev >= minEdge ? 'u' : null;
  return { line, books: at.length, fairO, fairU, fairOddsO: americanFrom(fairO), fairOddsU: americanFrom(fairU), bestO, bestU, ev };
}

// ---------------------------------------------------------------- display (browser only)

const rankWord = n => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

/* One-line context for a team in a game: "Team total 117.5 (3rd of 24) · Pace 101.8 (4th)". */
function teamContext(L, g, team) {
  const parts = [];
  const imp = slateImplied(L, g.d)[team];
  if (imp && imp.gid === g.id) parts.push(`<span title="Implied points from the spread and total, ranked among today's teams">Team total <b>${fmt1(imp.pts)}</b> <small>(${rankWord(imp.rank)} of ${imp.of})</small></span>`);
  const p = teamPace(L, { last: 10 })[team];
  if (p && p.pace != null) parts.push(`<span title="Possessions per 48 minutes over the last 10 games; 1st = fastest">Pace <b>${fmt1(p.pace)}</b> <small>(${rankWord(p.rank)})</small></span>`);
  return parts.length ? `<div class="ctxline">${parts.join('<i>·</i>')}</div>` : '';
}

/* "MIA 117.3 (8th) · Team totals · ATL 122.5 (2nd)" under a game's teams, plus projected pace when logs are loaded. */
function impliedRow(L, g) {
  const s = slateImplied(L, g.d), a = s[g.a], h = s[g.h];
  if (!a || !h || a.gid !== g.id) return '';
  const pace = L.logs ? gamePace(L, g) : null;
  const side = (abbr, x) => `<span><b>${fmt1(x.pts)}</b> <small>${rankWord(x.rank)}</small></span>`;
  return `<div class="implied" title="Implied points from the spread and total; rank among today's ${a.of} teams">
    ${side(g.a, a)}<span class="muted">Team totals${pace ? ` · pace ${fmt1(pace)}` : ''}</span>${side(g.h, h)}</div>`;
}

/* Small "EV+" tag for a prop when the best price beats the no-vig consensus by 2%+. */
function evTag(prop, side) {
  const f = prop && fairPrice(prop);
  if (!f || !f.ev || (side && f.ev !== side)) return '';
  const b = f.ev === 'o' ? f.bestO : f.bestU;
  return `<span class="evtag" title="${f.ev === 'o' ? 'Over' : 'Under'} ${odds(b.price)} at ${esc(bookName(b.book))} vs a no-vig fair price of ${odds(f.ev === 'o' ? f.fairOddsO : f.fairOddsU)} (${f.books} books): about ${(b.ev * 100).toFixed(1)}% above fair">EV+ ${f.ev === 'o' ? 'O' : 'U'}</span>`;
}

/* Fair price box for the player page line card. */
function fairPriceHTML(prop) {
  const f = prop && fairPrice(prop);
  if (!f) return '';
  const side = (label, fair, fairOdds, b) => `<div><small>${label} ${f.line}</small>
    <div><b>${pct(fair)}</b> <span class="muted">fair ${odds(fairOdds)}</span></div>
    <div class="muted">Best ${odds(b.price)} ${esc(bookName(b.book))} <span class="${b.ev >= 0.02 ? 'evpos' : b.ev < 0 ? 'evneg' : ''}">${signed(Math.round(b.ev * 1000) / 10)}%</span></div></div>`;
  return `<div class="fairbox">${side('Over', f.fairO, f.fairOddsO, f.bestO)}${side('Under', f.fairU, f.fairOddsU, f.bestU)}</div>
    <p class="note">No-vig fair price from ${f.books} book${f.books > 1 ? 's' : ''} at ${f.line} (each book's margin removed, then averaged). Percent = expected return of the best price against fair. Informational only.</p>`;
}

if (typeof module !== 'undefined') {
  module.exports = { possessions, teamBoxTotals, teamPace, gamePace, impliedTotals, slateImplied, impliedProb, decimalOdds, americanFrom, fairPrice };
}
