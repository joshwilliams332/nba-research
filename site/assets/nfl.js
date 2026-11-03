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

/* Index the data: games sorted by kickoff, each with `t` (sortable "YYYY-MM-DDTHH:MM" in ET), plus each team's
   games and box rows by season and week. Last season and this one are loaded; `meta.season` is this one. */
function nflLab(meta, games, teams, teamstats) {
  const N = { meta, teams, teamstats: teamstats || {}, games: [], byId: new Map(), teamGames: {}, box: {}, byTeamWeek: new Map() };
  for (const raw of games) {
    const g = { ...raw, season: raw.season || meta.season, t: `${raw.date}T${raw.time || '13:00'}`, final: NFL_FINAL(raw) };
    N.games.push(g);
    N.byId.set(g.id, g);
    for (const team of [g.home, g.away]) {
      (N.teamGames[team] = N.teamGames[team] || []).push(g);
      N.byTeamWeek.set(`${g.season}-${g.week}-${team}`, g);
    }
  }
  N.games.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  for (const list of Object.values(N.teamGames)) list.sort((a, b) => (a.t < b.t ? -1 : 1));
  for (const [team, rows] of Object.entries(N.teamstats)) {
    N.box[team] = Object.fromEntries((rows || []).map(r => [`${r.season || meta.season}-${r.week}`, r]));
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

/* "5-2" (or "5-2-1"): this season's regular-season finals before t. */
function nflRecord(N, team, before) {
  const s = nflFinals(N, team, before).filter(x => x.g.season === N.meta.season && x.g.type === 'REG');
  const w = s.filter(x => x.win).length, t = s.filter(x => x.tie).length;
  return `${w}-${s.length - w - t}${t ? `-${t}` : ''}`;
}

/* The week on screen by default: the first week with a game not yet final (else the last week). */
function nflCurrentWeek(N) {
  const open = N.games.find(g => !g.final && g.type === 'REG' && g.season === N.meta.season);
  return open ? open.week : Math.max(...N.games.filter(g => g.season === N.meta.season).map(g => g.week));
}

/* This season's regular-season weeks. */
function nflWeeks(N) {
  return [...new Set(N.games.filter(g => g.type === 'REG' && g.season === N.meta.season).map(g => g.week))].sort((a, b) => a - b);
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
  const cur = all.filter(s => s.g.season === g.season), last = all.filter(s => s.g.season === g.season - 1);
  return {
    num, rows: all, cur, last,
    l5: tally(res(all.slice(-5))), l10: tally(res(all.slice(-10))), season: tally(res(cur)), lastSeason: tally(res(last)),
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
    for (const s of nflFinals(N, team).filter(x => x.g.season === N.meta.season)) {
      const key = `${s.g.season}-${s.g.week}`;
      const mine = (N.box[team] || {})[key], theirs = (N.box[s.opp] || {})[key];
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
  const cur = x => x.g.season === N.meta.season;
  const A = nflFinals(N, a, before).filter(cur), B = nflFinals(N, b, before).filter(cur);
  const opps = [...new Set(A.map(s => s.opp))].filter(o => o !== b && B.some(s => s.opp === o));
  return opps.map(o => ({ opp: o, a: A.filter(s => s.opp === o), b: B.filter(s => s.opp === o) }));
}

// ---------------------------------------------------------------- players and props

/* Player stats NFL Lab tracks. f reads a log row; step is how far apart ladder lines sit. */
const NFL_STATS = {
  pass_yds: { label: 'Passing yards', short: 'PASS YDS', f: r => r.pass_yds, step: 15 },
  cmp: { label: 'Completions', short: 'CMP', f: r => r.cmp, step: 2 },
  att: { label: 'Pass attempts', short: 'ATT', f: r => r.att, step: 2 },
  pass_td: { label: 'Passing TDs', short: 'PASS TD', f: r => r.pass_td, step: 1 },
  int: { label: 'Interceptions', short: 'INT', f: r => r.int, step: 1 },
  rush_yds: { label: 'Rushing yards', short: 'RUSH YDS', f: r => r.rush_yds, step: 10 },
  car: { label: 'Carries', short: 'CAR', f: r => r.car, step: 2 },
  rush_td: { label: 'Rushing TDs', short: 'RUSH TD', f: r => r.rush_td, step: 1 },
  rec_yds: { label: 'Receiving yards', short: 'REC YDS', f: r => r.rec_yds, step: 10 },
  rec: { label: 'Receptions', short: 'REC', f: r => r.rec, step: 1 },
  tgt: { label: 'Targets', short: 'TGT', f: r => r.tgt, step: 1 },
  rec_td: { label: 'Receiving TDs', short: 'REC TD', f: r => r.rec_td, step: 1 },
  rush_rec_yds: { label: 'Rush + rec yards', short: 'RUSH+REC', f: r => r.rush_yds + r.rec_yds, step: 10 },
  pass_rush_yds: { label: 'Pass + rush yards', short: 'PASS+RUSH', f: r => r.pass_yds + r.rush_yds, step: 15 },
};
const NFL_POS_STATS = {
  QB: ['pass_yds', 'cmp', 'att', 'pass_td', 'int', 'rush_yds', 'pass_rush_yds'],
  RB: ['rush_yds', 'car', 'rush_rec_yds', 'rec_yds', 'rec', 'tgt', 'rush_td'],
  WR: ['rec_yds', 'rec', 'tgt', 'rec_td', 'rush_rec_yds'],
  TE: ['rec_yds', 'rec', 'tgt', 'rec_td'],
  FB: ['rush_yds', 'car', 'rec_yds', 'rec'],
};
const nflPosGroup = pos => (pos === 'FB' ? 'RB' : pos || 'WR');

/* Add players, logs, props and projections. Each log row becomes {season, week, team, opp, ...stats, g, home}. */
function nflAddPlayers(N, players, logsDoc, props, proj) {
  N.players = players || {};
  N.props = (props && props.games) || {};
  N.propsPulled = (props && props.pulled) || {};
  N.proj = proj || {};
  N.logs = {};
  const cols = (logsDoc && logsDoc.cols) || [];
  for (const [pid, list] of Object.entries((logsDoc && logsDoc.logs) || {})) {
    N.logs[pid] = list.map(a => {
      const r = { season: a[0], week: a[1], team: a[2], opp: a[3] };
      cols.forEach((c, i) => { r[c] = a[4 + i] == null ? 0 : a[4 + i]; });
      r.g = N.byTeamWeek.get(`${r.season}-${r.week}-${r.team}`) || null;
      r.home = r.g ? r.g.home === r.team : false;
      return r;
    }).filter(r => r.g);
  }
  // Weeks whose player stats are in (nflverse publishes them the day after the games).
  N.statWeeks = new Set(Object.values(N.logs).flatMap(list => list.map(r => `${r.season}-${r.week}`)));
  return N;
}

/* A player's game rows, oldest first, optionally only games before kickoff time t. */
function nflPlayerRows(N, pid, before) {
  return (N.logs[pid] || []).filter(r => !before || r.g.t < before);
}

/* The team's next game that isn't final (or null). */
function nflNextGame(N, team) {
  return (N.teamGames[team] || []).find(g => !g.final) || null;
}

/* No sportsbook line: the half point above the floor of his last-10 average, always labeled "typical". */
function nflTypical(rows, stat) {
  const v = rows.slice(-10).map(NFL_STATS[stat].f);
  return v.length ? Math.floor(v.reduce((a, b) => a + b, 0) / v.length) + 0.5 : 0.5;
}

/* Hit rates by window for one line and side: L5 / L10 / L20, this season, last season and vs this opponent. */
function nflPlayerWindows(rows, stat, line, side, opp, season) {
  const f = NFL_STATS[stat].f;
  const t = list => ({ ...tally(list.map(r => outcome(f(r), line, side))), rows: list });
  return {
    l5: t(rows.slice(-5)), l10: t(rows.slice(-10)), l20: t(rows.slice(-20)),
    season: t(rows.filter(r => r.season === season)), last: t(rows.filter(r => r.season === season - 1)),
    h2h: t(opp ? rows.filter(r => r.opp === opp) : []),
  };
}

/* What each defense allowed per game this season to one position for one stat, with ranks (1 = allows the most,
   the friendliest matchup for an over). Returns {team: {avg, rank, games}, of}. */
function nflDefVsPos(N, pos, stat) {
  const key = `${pos}|${stat}`;
  N._dvp = N._dvp || {};
  if (N._dvp[key]) return N._dvp[key];
  const f = NFL_STATS[stat].f, group = nflPosGroup(pos), per = {};
  for (const [pid, rows] of Object.entries(N.logs)) {
    if (nflPosGroup((N.players[pid] || {}).pos) !== group) continue;
    for (const r of rows) {
      if (r.season !== N.meta.season || !r.g.final) continue;
      const d = per[r.opp] = per[r.opp] || {};
      d[r.g.id] = (d[r.g.id] || 0) + f(r);
    }
  }
  const avg = Object.fromEntries(Object.entries(per).map(([t, games]) => {
    const v = Object.values(games);
    return [t, { avg: v.reduce((a, b) => a + b, 0) / v.length, games: v.length }];
  }));
  const vals = Object.values(avg).map(x => x.avg);
  for (const x of Object.values(avg)) x.rank = 1 + vals.filter(v => v > x.avg).length;
  return (N._dvp[key] = { teams: avg, of: vals.length });
}

/* Players at this position who faced the opponent this season, with their stat that game (newest first). */
function nflVsOpponent(N, opp, pos, stat, limit = 12) {
  const f = NFL_STATS[stat].f, group = nflPosGroup(pos), out = [];
  for (const [pid, rows] of Object.entries(N.logs)) {
    if (nflPosGroup((N.players[pid] || {}).pos) !== group) continue;
    for (const r of rows) if (r.opp === opp && r.season === N.meta.season && r.g.final && f(r) > 0) out.push({ pid, r, v: f(r) });
  }
  return out.sort((a, b) => (a.r.g.t < b.r.g.t ? 1 : a.r.g.t > b.r.g.t ? -1 : b.v - a.v)).slice(0, limit);
}

/* Sportsbook props for a game: player id -> stat -> prop row. */
function nflGameProps(N, gid) {
  const out = {};
  for (const r of N.props[gid] || []) (out[r.pid] = out[r.pid] || {})[r.stat] = r;
  return out;
}

/* Ladder of lines around a main line: two steps below and above (never below 0.5). */
function nflLadder(line, stat) {
  const step = NFL_STATS[stat].step;
  return [-2, -1, 0, 1, 2].map(k => line + k * step).filter(l => l >= 0.5);
}

// ---------------------------------------------------------------- grading saved picks

/* Kickoff as an ISO time with the Eastern offset (EDT from the second Sunday of March to the first Sunday of
   November, else EST), so it sorts and formats alongside NBA tip times. */
function nflIso(g) {
  const [y, m, d] = g.date.split('-').map(Number);
  const nthSunday = (month, n) => { const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay(); return 1 + ((7 - first) % 7) + 7 * (n - 1); };
  const dst = (m > 3 && m < 11) || (m === 3 && d >= nthSunday(3, 2)) || (m === 11 && d < nthSunday(11, 1));
  return `${g.date}T${g.time || '13:00'}:00${dst ? '-04:00' : '-05:00'}`;
}

/* The game as My picks shows it (same fields as an NBA game: t, d, a, h, s, state). */
function nflGameView(g) {
  return { id: g.id, t: nflIso(g), d: g.date, a: g.away, h: g.home, s: g.season, state: g.final ? 'post' : 'pre', detail: g.final ? 'Final' : '', nfl: true };
}

/* Grade a saved NFL pick from nflverse's player stats: open until the game is final and its week's stats are in;
   void if the stats are in and he has no row (didn't play). Same result shape as picks.js gradePick. */
function gradeNflPick(N, pick) {
  const raw = N.byId.get(pick.gid);
  if (!raw) return { status: 'void', profit: 0, why: 'game not found' };
  const g = nflGameView(raw);
  if (!raw.final) return { status: 'open', g, profit: 0 };
  const row = (N.logs[pick.pid] || []).find(r => r.g.id === raw.id);
  if (!row) {
    if (!N.statWeeks.has(`${raw.season}-${raw.week}`)) return { status: 'open', g, profit: 0, why: 'final; stats come the next morning' };
    return { status: 'void', g, profit: 0, why: "didn't play" };
  }
  const actual = NFL_STATS[pick.stat] ? NFL_STATS[pick.stat].f(row) : null;
  if (actual == null) return { status: 'void', g, profit: 0, why: 'stat unavailable' };
  const result = settle(actual, pick.line, pick.side);
  return { status: result, g, actual, profit: payout(result, pick.price, pick.units || 1) };
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
  const titles = sides => sides.map(s => `${s.g.season} wk ${s.g.week} ${s.home ? 'vs' : '@'} ${s.opp}: ${s.pts}-${s.oppPts}`);
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
    parts.push(`<div class="mkt"><h4>Spread</h4><div class="pair">${side(g.away, `${g.away} ${signed(sa)}`, g.away_spread_odds, A, hA, 'spread', sa)}${side(g.home, `${g.home} ${signed(sh)}`, g.home_spread_odds, H, hH, 'spread', sh, true)}</div></div>`);
  }
  if (g.total != null) {
    const ou = (team, sides, right) => {
      const r = lineResults(sides, 'over', g.total), o = tally(r), u = tally(lineResults(sides, 'under', g.total));
      return `<div>${strip(right ? [...r].reverse() : r, right ? titles(sides).reverse() : titles(sides))}<div class="trend" style="justify-content:${right ? 'flex-end' : 'flex-start'}"><span><span class="tag">${team} L${o.n}</span> O ${pct(o.rate)} · U ${pct(u.rate)}</span></div></div>`;
    };
    parts.push(`<div class="mkt"><h4>Total</h4><div class="pair">
      <div class="golink" ${go('over', 'o')}><div class="side"><b>O ${g.total}</b><span class="grow"></span>${g.over_odds != null ? `<span class="price">${odds(g.over_odds)}</span>` : ''}<span class="gochev">›</span></div></div>
      <div class="golink" ${go('under', 'u')}><div class="side"><b>U ${g.total}</b><span class="grow"></span>${g.under_odds != null ? `<span class="price">${odds(g.under_odds)}</span>` : ''}<span class="gochev">›</span></div></div>
      ${ou(g.away, A)}${ou(g.home, H, true)}</div></div>`);
  }
  if (!parts.length) return `<p class="note" style="padding:0 14px 12px">No lines posted yet.</p>`;
  return parts.join('');
}

if (typeof module !== 'undefined') {
  module.exports = { nflIso, nflGameView, gradeNflPick, NFL_STATS, NFL_POS_STATS, nflPosGroup, nflAddPlayers, nflPlayerRows, nflNextGame, nflTypical, nflPlayerWindows, nflDefVsPos, nflVsOpponent, nflGameProps, nflLadder, NFL_RANK_STATS, nflLab, nflSide, nflFinals, nflRecord, nflCurrentWeek, nflWeeks, nflLines, nflWindows, nflTeamTotals, nflRanks, nflCommonOpponents, nflKick };
}
