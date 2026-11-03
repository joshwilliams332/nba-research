/* NFL Lab: the football side of Mingus Lab. Data comes from Mingus Football's published files (copied into
   site/data/nfl/ by scripts/build_nfl.py on every data run): the schedule with lines and scores, teams, and each team's
   week-by-week box totals. This file turns them into the shapes Hoop Lab's shared helpers already understand
   (lineResults, tally, strip, rateTag), plus team rankings for the Matchup tab.

   Loaded after common.js. Names start with nfl / NFL so they never clash with common.js in the shared browser scope.
   Pure logic is unit tested in tests/nfl.test.js. */
'use strict';

if (typeof module !== 'undefined' && typeof tally === 'undefined') {
  Object.assign(globalThis, require('./common.js'));
}

const NFL_FINAL = g => g.home_score != null && g.away_score != null;

/* Index the season: games sorted by kickoff, each with `t` (sortable "YYYY-MM-DDTHH:MM" in ET), plus each team's
   games and box rows by week. */
function nflLab(meta, games, teams, teamstats) {
  const N = { meta, teams, teamstats: teamstats || {}, games: [], byId: new Map(), teamGames: {}, box: {} };
  for (const raw of games) {
    const g = { ...raw, t: `${raw.date}T${raw.time || '13:00'}`, final: NFL_FINAL(raw) };
    N.games.push(g);
    N.byId.set(g.id, g);
    for (const team of [g.home, g.away]) (N.teamGames[team] = N.teamGames[team] || []).push(g);
  }
  N.games.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const list of Object.values(N.teamGames)) list.sort((a, b) => (a.t < b.t ? -1 : 1));
  for (const [team, rows] of Object.entries(N.teamstats)) {
    N.box[team] = Object.fromEntries((rows || []).map(r => [r.week, r]));
  }
  return N;
}

/* One team's view of a final game, in the shape lineResults() expects. */
function nflSide(g, team) {
  const home = g.home === team;
  const pts = home ? g.home_score : g.away_score, oppPts = home ? g.away_score : g.home_score;
  return {
    g, home, team, opp: home ? g.away : g.home, pts, oppPts,
    margin: pts - oppPts, total: pts + oppPts, win: pts > oppPts, tie: pts === oppPts,
    spread: g.home_spread == null ? null : home ? g.home_spread : -g.home_spread,   // his number that day
    totalLine: g.total,
  };
}

/* A team's finals before kickoff time t (all season when t is omitted), oldest first. */
function nflFinals(N, team, before) {
  return (N.teamGames[team] || []).filter(g => g.final && (!before || g.t < before)).map(g => nflSide(g, team));
}

/* "5-2" (or "5-2-1") from finals before t. */
function nflRecord(N, team, before) {
  const s = nflFinals(N, team, before);
  const w = s.filter(x => x.win).length, t = s.filter(x => x.tie).length;
  return `${w}-${s.length - w - t}${t ? `-${t}` : ''}`;
}

/* The week on screen by default: the first week with a game not yet final (else the last week). */
function nflCurrentWeek(N) {
  const open = N.games.find(g => !g.final && g.type === 'REG');
  return open ? open.week : Math.max(...N.games.map(g => g.week));
}

function nflWeeks(N) {
  return [...new Set(N.games.filter(g => g.type === 'REG').map(g => g.week))].sort((a, b) => a - b);
}

/* A game's numbers from one team's side: money line, spread (his number) and total. */
function nflLines(g, team) {
  const home = g.home === team;
  return {
    ml: home ? g.home_ml : g.away_ml,
    spread: g.home_spread == null ? null : home ? g.home_spread : -g.home_spread,
    total: g.total,
    implied: home ? g.home_implied : g.away_implied,
  };
}

/* Windows for one bet, judged against THIS game's number: L5, L10, this season and head-to-head.
   kind: 'ml' | 'spread' | 'over' | 'under'. Returns {l5, l10, season, h2h, rows} with tally() results. */
function nflWindows(N, g, team, kind) {
  const num = kind === 'ml' ? null : kind === 'spread' ? nflLines(g, team).spread : g.total;
  const all = nflFinals(N, team, g.t);
  const opp = g.home === team ? g.away : g.home;
  const res = list => lineResults(list, kind, num);
  // Only this season's games are published so far, so "season" is every final before kickoff.
  return {
    num, rows: all,
    l5: tally(res(all.slice(-5))), l10: tally(res(all.slice(-10))), season: tally(res(all)),
    h2h: tally(res(all.filter(s => s.opp === opp))),
  };
}

// ---------------------------------------------------------------- team rankings

/* Per-game stats for every team: offense (what it did) and defense (what its opponents did against it).
   Stats: points, yards, yards per play, passing yards, rushing yards, first downs, turnovers, sacks. */
const NFL_RANK_STATS = [
  ['pts', 'Scoring', 1], ['yds', 'Total yards', 1], ['ypp', 'Yards per play', 1], ['pass', 'Passing yards', 1],
  ['rush', 'Rushing yards', 1], ['fd', 'First downs', 1], ['to', 'Turnovers', -1], ['sk', 'Sacks', -1],
];
// The third value: 1 = more is better for an offense (and worse for a defense allowing it); -1 = the reverse
// (turnovers and sacks taken hurt an offense, and a defense that forces them ranks higher).

function nflTeamTotals(N) {
  const out = {};
  for (const team of Object.keys(N.teams)) {
    const off = [], def = [];
    for (const s of nflFinals(N, team)) {
      const mine = (N.box[team] || {})[s.g.week], theirs = (N.box[s.opp] || {})[s.g.week];
      const line = (r, pts) => {
        if (!r) return null;
        const plays = (r.att || 0) + (r.sk || 0) + (r.car || 0);
        const yds = (r.pass_yds || 0) + (r.rush_yds || 0);
        return { pts, yds, ypp: plays ? yds / plays : null, pass: r.pass_yds || 0, rush: r.rush_yds || 0, fd: r.fd || 0,
          to: (r.int || 0) + (r.fl || 0), sk: r.sk || 0 };
      };
      const o = line(mine, s.pts), d = line(theirs, s.oppPts);
      if (o) off.push(o);
      if (d) def.push(d);
    }
    const avg = (list, k) => { const v = list.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    out[team] = {
      games: off.length,
      off: Object.fromEntries(NFL_RANK_STATS.map(([k]) => [k, avg(off, k)])),
      def: Object.fromEntries(NFL_RANK_STATS.map(([k]) => [k, avg(def, k)])),
    };
  }
  return out;
}

/* Ranks 1..32 for each stat: offense 1 = best offense, defense 1 = best defense. Ties share the better rank. */
function nflRanks(N) {
  const totals = nflTeamTotals(N);
  const teams = Object.keys(totals).filter(t => totals[t].games);
  const ranks = Object.fromEntries(teams.map(t => [t, { off: {}, def: {} }]));
  for (const [k, , dir] of NFL_RANK_STATS) {
    for (const side of ['off', 'def']) {
      // Offense: higher is better when dir = 1. Defense allowing it: lower is better when dir = 1.
      const better = side === 'off' ? dir : -dir;
      const vals = teams.map(t => totals[t][side][k]).filter(v => v != null);
      for (const t of teams) {
        const v = totals[t][side][k];
        if (v == null) continue;
        ranks[t][side][k] = 1 + vals.filter(x => (better > 0 ? x > v : x < v)).length;
      }
    }
  }
  return { totals, ranks, of: teams.length };
}

/* Common opponents this season: for each team both have finished a game against, each side's results. */
function nflCommonOpponents(N, a, b, before) {
  const A = nflFinals(N, a, before), B = nflFinals(N, b, before);
  const opps = [...new Set(A.map(s => s.opp))].filter(o => o !== b && B.some(s => s.opp === o));
  return opps.map(o => ({ opp: o, a: A.filter(s => s.opp === o), b: B.filter(s => s.opp === o) }));
}

// ---------------------------------------------------------------- display helpers (browser)

function nflLogo(N, team, size = 28) {
  const t = N.teams[team];
  return t && t.logo ? `<img class="logo" src="${t.logo}" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
}

/* "Thu, Nov 5 · 8:15 PM" (times are Eastern, as published). */
function nflKick(g) {
  const [h, m] = (g.time || '13:00').split(':').map(Number);
  const time = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const day = new Date(`${g.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} · ${time}`;
}

const nflTeamName = (N, t) => ((N.teams[t] || {}).nickname || t);

/* The three game-line markets for a game card or game page: each side with its price, an L10 strip against tonight's
   number and L10 / H2H rates (the same layout as Hoop Lab's NBA cards). */
function nflGameLines(N, g) {
  const A = nflFinals(N, g.away, g.t).slice(-10), H = nflFinals(N, g.home, g.t).slice(-10);
  const hA = A.filter(s => s.opp === g.home), hH = H.filter(s => s.opp === g.away);
  const titles = sides => sides.map(s => `Wk ${s.g.week} ${s.home ? 'vs' : '@'} ${s.opp}: ${s.pts}-${s.oppPts}`);
  const go = (m, s) => `data-go="nfl-game.html?id=${encodeURIComponent(g.id)}&m=${m}&s=${s}#lines" role="link" tabindex="0"`;
  const side = (team, label, price, sides, h2h, kind, num, right) => {
    const r = lineResults(sides, kind, num), t = tally(r), th = tally(lineResults(h2h, kind, num));
    const pr = price != null ? `<span class="price">${odds(price)}</span>` : '';
    const trend = [`<span><span class="tag">L${t.n}</span> ${rateTag(t)}</span>`, th.n ? `<span><span class="tag">H2H</span> ${rateTag(th)}</span>` : ''];
    return `<div class="golink" ${go(kind, team === g.home ? 'h' : 'a')}><div class="side"><b>${esc(label)}</b><span class="grow"></span>${pr}<span class="gochev">›</span></div>${strip(right ? [...r].reverse() : r, right ? titles(sides).reverse() : titles(sides))}
      <div class="trend">${(right ? trend.reverse() : trend).join('')}</div></div>`;
  };
  const parts = [];
  if (g.away_ml != null || g.home_ml != null) {
    parts.push(`<div class="mkt"><h4>Money line</h4><div class="pair">${side(g.away, g.away, g.away_ml, A, hA, 'ml')}${side(g.home, g.home, g.home_ml, H, hH, 'ml', null, true)}</div></div>`);
  }
  if (g.home_spread != null) {
    const sa = -g.home_spread, sh = g.home_spread;
    parts.push(`<div class="mkt"><h4>Spread</h4><div class="pair">${side(g.away, `${g.away} ${signed(sa)}`, null, A, hA, 'spread', sa)}${side(g.home, `${g.home} ${signed(sh)}`, null, H, hH, 'spread', sh, true)}</div></div>`);
  }
  if (g.total != null) {
    const ou = (team, sides, right) => {
      const r = lineResults(sides, 'over', g.total), o = tally(r), u = tally(lineResults(sides, 'under', g.total));
      return `<div>${strip(right ? [...r].reverse() : r, right ? titles(sides).reverse() : titles(sides))}<div class="trend" style="justify-content:${right ? 'flex-end' : 'flex-start'}"><span><span class="tag">${team} L${o.n}</span> O ${pct(o.rate)} · U ${pct(u.rate)}</span></div></div>`;
    };
    parts.push(`<div class="mkt"><h4>Total</h4><div class="pair">
      <div class="golink" ${go('over', 'o')}><div class="side"><b>O ${g.total}</b><span class="grow"></span><span class="gochev">›</span></div></div>
      <div class="golink" ${go('under', 'u')}><div class="side"><b>U ${g.total}</b><span class="grow"></span><span class="gochev">›</span></div></div>
      ${ou(g.away, A)}${ou(g.home, H, true)}</div></div>`);
  }
  if (!parts.length) return `<p class="note" style="padding:0 14px 12px">No lines posted yet.</p>`;
  return parts.join('');
}

if (typeof module !== 'undefined') {
  module.exports = { NFL_RANK_STATS, nflLab, nflSide, nflFinals, nflRecord, nflCurrentWeek, nflWeeks, nflLines, nflWindows, nflTeamTotals, nflRanks, nflCommonOpponents, nflKick };
}
