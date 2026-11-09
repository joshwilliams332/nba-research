/* NFL Lab: the football side of Mingus Lab. scripts/build_nfl.py writes site/data/nfl/ on every data run (ESPN and
   nflverse games, lines, box scores and injuries; Mingus Football's projections; Mingus Picks' props and picks). This file turns them into the shapes Hoop Lab's shared helpers already understand
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
    g.state = g.final ? 'post' : raw.state || 'pre';
    N.games.push(g);
    N.byId.set(g.id, g);
    if (g.eid) (N.byEid = N.byEid || new Map()).set(String(g.eid), g);
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

/* "was 53.5 (-111 DraftKings)" when DraftKings moved off the line Mingus Picks priced (the row's `was`), else ''. */
function nflWasText(r, side = 'o') {
  const w = r && r.was;
  if (!w || w.line == null) return '';
  const price = side === 'u' ? w.under : w.over, book = side === 'u' ? w.book_u : w.book_o;
  return `was ${w.line}${price != null ? ` (${odds(price)}${book ? ` ${book}` : ''})` : ''}`;
}

/* Alternate lines around the main line, the way sportsbooks list them: yardage every 5 yards on the .5 (44.5, 49.5, ...)
   out to `span` yards each side, counting stats every 1, with the player's real (or typical) line always included.
   Never below 0.5. Only the real line has a price; the others are for research and saving picks. */
const NFL_LADDER = { yds: [5, 20], pass: [5, 30], count: [1, 3], big: [1, 4], td: [1, 2] };
function nflLadder(line, stat) {
  const kind = /^pass(_rush)?_yds$/.test(stat) ? 'pass' : /yds$/.test(stat) ? 'yds' : /td$|^int$/.test(stat) ? 'td'
    : stat === 'cmp' || stat === 'att' ? 'big' : 'count';
  const [step, span] = NFL_LADDER[kind];
  const out = new Set([line]);
  const first = Math.ceil((line - span + 0.5) / step) * step - 0.5;
  for (let l = first; l <= line + span; l += step) if (l >= 0.5) out.add(Math.round(l * 10) / 10);
  return [...out].filter(l => l >= 0.5).sort((a, b) => a - b);
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

// ---------------------------------------------------------------- insights
// Same rule as Hoop Lab's insights.js: a side is kept when it hits 75%+ over 5+ games, ranked by the Wilson lower
// bound, best two per player stat / team market (one per window family). Player trends use this game's sportsbook
// lines (typical lines, marked, only when no props were pulled at all); team trends use this game's numbers.
const NFL_INSIGHT_RATE = 0.75, NFL_INSIGHT_N = 5;
const NFL_WINDOWS = [['l5', 'recent', n => `last ${n} games`], ['l10', 'recent', n => `last ${n} games`],
  ['season', 'season', n => `${n} games this season`], ['h2h', 'h2h', (n, opp) => `${n} games vs ${opp}`]];

function nflWilson(hits, n, z = 1.28) {
  if (!n) return 0;
  const p = hits / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/* {side: 'o'|'u', results, ...tally} when one side of these results clears the bar, else null. Pushes count as
   not hitting; `both` false only allows the 'o' (yes) side. */
function nflStrongSide(results, both = true) {
  const yes = tally(results);
  if (yes.n < NFL_INSIGHT_N) return null;
  if (yes.rate >= NFL_INSIGHT_RATE) return { side: 'o', results, ...yes };
  if (!both) return null;
  const flipped = results.map(r => (r === 'hit' ? 'miss' : r === 'miss' ? 'hit' : 'push')), no = tally(flipped);
  return no.rate >= NFL_INSIGHT_RATE ? { side: 'u', results: flipped, ...no } : null;
}

function nflKeepBest(list, per = 2) {
  const groups = new Map();
  for (const x of list) (groups.get(x.group) || groups.set(x.group, []).get(x.group)).push(x);
  const out = [];
  for (const items of groups.values()) {
    items.sort((a, b) => b.strength - a.strength || b.n - a.n);
    const fams = new Set();
    for (const x of items) {
      if (fams.has(x.family) || fams.size >= per) continue;
      fams.add(x.family);
      out.push(x);
    }
  }
  return out;
}

/* Trends for one game: [{type: 'player'|'team', text, label, results, dates, rate, n, strength, ...}]. */
function nflGameInsights(N, g) {
  const out = [];
  const book = Object.values(N.props[g.id] || {});
  let rows = book.map(r => ({ pid: r.pid, stat: r.stat, line: r.line, price: r.over, uprice: r.under, typical: false }));
  if (!rows.length) {
    // Typical lines for each team's main players (QB pass yds, top RB rush yds, top 2 WR/TE rec yds).
    for (const team of [g.away, g.home]) {
      const mine = Object.entries(N.players).filter(([, p]) => p.t === team && !/^IR|Out|Inactive|Released|Retired|Suspended/.test(p.st || ''))
        .map(([pid, p]) => ({ pid, p, r: nflPlayerRows(N, pid, g.t).filter(x => x.team === team).slice(-3) })).filter(x => x.r.length);
      const vol = (x, k) => x.r.reduce((a, y) => a + (y[k] || 0), 0);
      const top = (pos, k, n, stat) => mine.filter(x => pos.includes(x.p.pos)).sort((a, b) => vol(b, k) - vol(a, k)).slice(0, n)
        .forEach(x => rows.push({ pid: x.pid, stat, line: nflTypical(nflPlayerRows(N, x.pid, g.t), stat), typical: true }));
      top(['QB'], 'att', 1, 'pass_yds'); top(['RB', 'FB'], 'car', 1, 'rush_yds'); top(['WR', 'TE'], 'tgt', 2, 'rec_yds');
    }
  }
  for (const r of rows) {
    const p = N.players[r.pid];
    if (!p || !NFL_STATS[r.stat]) continue;
    const team = p.t, opp = team === g.home ? g.away : g.home;
    const w = nflPlayerWindows(nflPlayerRows(N, r.pid, g.t), r.stat, r.line, 'o', opp, g.season);
    for (const [k, family, words] of NFL_WINDOWS) {
      const win = w[k], s = nflStrongSide(win.rows.map(x => outcome(NFL_STATS[r.stat].f(x), r.line, 'o')));
      if (!s) continue;
      const side = s.side === 'o' ? 'over' : 'under', label = NFL_STATS[r.stat].label.toLowerCase();
      out.push({ type: 'player', pid: r.pid, name: p.n, team, img: p.img, stat: r.stat, line: r.line, side: s.side, typical: r.typical,
        price: s.side === 'o' ? r.price : r.uprice, group: `${r.pid}|${r.stat}`, family, strength: nflWilson(s.hits, s.n),
        text: `${p.n} has gone ${side} ${r.line} ${label} in ${s.hits} of his ${words(s.n, opp)}.`,
        label: `${p.n} ${side} ${r.line} ${label}`, results: s.results, dates: win.rows.map(x => x.g.date),
        rate: s.rate, n: s.n, hits: s.hits });
    }
  }
  const markets = [['ml', false], ['spread', false], ['total', true]];
  for (const team of [g.away, g.home]) {
    const opp = team === g.home ? g.away : g.home;
    for (const [m, both] of markets) {
      if (m === 'ml' ? nflLines(g, team).ml == null : m === 'spread' ? g.home_spread == null : g.total == null) continue;
      const w = nflWindows(N, g, team, m === 'total' ? 'over' : m);
      const pick = { l5: w.rows.slice(-5), l10: w.rows.slice(-10), season: w.cur, h2h: w.rows.filter(x => x.opp === opp) };
      for (const [k, family, words] of NFL_WINDOWS) {
        const list = pick[k], s = nflStrongSide(lineResults(list, m === 'total' ? 'over' : m, w.num), both);
        if (!s) continue;
        const num = m === 'spread' ? signed(w.num) : '';
        const what = m === 'ml' ? `won ${s.hits} of their ${words(s.n, opp)}`
          : m === 'spread' ? `covered ${num} in ${s.hits} of their ${words(s.n, opp)}`
          : `gone ${s.side === 'o' ? 'over' : 'under'} ${w.num} in ${s.hits} of their ${words(s.n, opp)}`;
        const L = nflLines(g, team);
        out.push({ type: 'team', team, market: m === 'total' ? (s.side === 'o' ? 'over' : 'under') : m, group: `${team}|${m}`, family,
          strength: nflWilson(s.hits, s.n), text: `The ${nflTeamName(N, team)} have ${what}.`,
          label: m === 'ml' ? `${team} money line` : m === 'spread' ? `${team} ${num}` : `${s.side === 'o' ? 'Over' : 'Under'} ${w.num}`,
          price: m === 'ml' ? L.ml : m === 'spread' ? (team === g.home ? g.home_spread_odds : g.away_spread_odds) : s.side === 'o' ? g.over_odds : g.under_odds,
          results: s.results, dates: list.map(x => x.g.date), rate: s.rate, n: s.n, hits: s.hits });
      }
    }
  }
  for (const x of out) { x.gid = g.id; x.t = g.t; if (x.type === 'player') x.market = x.stat; }
  return nflKeepBest(out);
}

/* One insight as a card (game page Insights tab and the NFL Trends page). */
function nflInsightCard(N, x, showGame) {
  const g = N.byId.get(x.gid) || {};
  const who = x.type === 'player'
    ? `${x.img ? `<img class="nflmug" src="${esc(x.img)}" alt="" width="44" height="44" loading="lazy" onerror="this.remove()">` : ''}<div class="grow"><b>${esc(x.name)}</b> <small>(${esc(x.team)})</small></div>`
    : `${nflLogo(N, x.team, 40)}<div class="grow"><b>${esc(nflTeamName(N, x.team))}</b></div>`;
  const game = showGame && g.id ? `<span class="tag">${esc(g.away)} @ ${esc(g.home)}</span>` : '';
  const price = x.price != null ? `<span class="price">${odds(x.price)}</span>` : x.typical ? '<span class="tag">typical line</span>' : '';
  const href = x.type === 'player' ? `nfl-player.html?id=${encodeURIComponent(x.pid)}&stat=${x.stat}&line=${x.line}${x.side === 'u' ? '&side=u' : ''}&g=${encodeURIComponent(x.gid)}`
    : `nfl-game.html?id=${encodeURIComponent(x.gid)}&m=${x.market}&s=${x.team === g.away ? 'a' : 'h'}#lines`;
  return `<a class="card insight" href="${href}"><div class="row">${who}${game}</div>
    <p class="itext">${esc(x.text)}</p>
    <div class="ibet"><span class="grow">${esc(x.label)}</span>${price}</div>
    ${strip(x.results, x.dates.map((d, i) => `${shortDate(d)}: ${x.results[i]}`))}
    <div class="irate"><b class="rate ${x.rate >= 0.75 ? 'hot' : ''}">${pct(x.rate)}</b> in the last ${x.n} games</div></a>`;
}

// ---------------------------------------------------------------- live scores
// While a game is on (or kicking off within 10 minutes), NFL pages ask ESPN's public scoreboard for fresh scores every
// 25 s straight from the browser, like Hoop Lab's live.js (whose parseLiveScoreboard / liveTag / liveNote this reuses),
// and the game page also reads the live box score for "Now 54 / 64.5" on prop rows. No server, no Odds API credits;
// the data job's snapshot is the fallback.
const NFL_LIVE_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const NFL_LIVE_CATS = {
  passing: { 'C/ATT': ['cmp', 'att'], YDS: 'pass_yds', TD: 'pass_td', INT: 'int' },
  rushing: { CAR: 'car', YDS: 'rush_yds', TD: 'rush_td' },
  receiving: { REC: 'rec', YDS: 'rec_yds', TD: 'rec_td', TGTS: 'tgt' },
};
const NFL_LOG_ZERO = { cmp: 0, att: 0, pass_yds: 0, pass_td: 0, int: 0, car: 0, rush_yds: 0, rush_td: 0, tgt: 0, rec: 0, rec_yds: 0, rec_td: 0 };

/* Copy scoreboard results (parseLiveScoreboard's {id, state, hs, as, detail}, keyed by ESPN event id) onto the games.
   A live game gets `live` and `detail`; a final one gets its scores and `final`. Never goes backwards. Returns how
   many games changed. */
function nflApplyLive(N, list) {
  const rank = { pre: 0, in: 1, post: 2 };
  let changed = 0;
  for (const x of list) {
    const g = N.byEid && N.byEid.get(String(x.id));
    if (!g || (rank[x.state] ?? 0) < (rank[g.state] ?? 0)) continue;
    const before = JSON.stringify([g.state, g.live, g.detail, g.home_score]);
    g.state = x.state;
    g.detail = x.detail || g.detail;
    if (x.state === 'in') g.live = { away: x.as, home: x.hs };
    if (x.state === 'post') Object.assign(g, { away_score: x.as, home_score: x.hs, final: true, live: null });
    if (JSON.stringify([g.state, g.live, g.detail, g.home_score]) !== before) changed++;
  }
  return changed;
}

/* ESPN game summary -> {espn athlete id: log row} (passing, rushing and receiving columns). */
const NFL_ESPN_TEAM = { WSH: 'WAS', LAR: 'LA' };   // ESPN abbreviation -> ours (nflverse)
function nflParseLiveBox(summary) {
  const out = {};
  for (const side of ((summary || {}).boxscore || {}).players || []) {
    const ab = String(((side.team || {}).abbreviation) || '').toUpperCase();
    const team = NFL_ESPN_TEAM[ab] || ab || null;
    for (const cat of side.statistics || []) {
      const cols = NFL_LIVE_CATS[cat.name];
      if (!cols) continue;
      const labels = (cat.labels || []).map(x => String(x).toUpperCase());
      for (const a of cat.athletes || []) {
        const id = String(((a.athlete || {}).id) || '');
        if (!id) continue;
        const row = out[id] = out[id] || { ...NFL_LOG_ZERO, team, n: (a.athlete || {}).displayName || null };
        labels.forEach((label, i) => {
          const c = cols[label];
          if (Array.isArray(c)) String((a.stats || [])[i] || '').split('/').forEach((v, k) => { row[c[k]] = parseFloat(v) || 0; });
          else if (c) row[c] = parseFloat(String((a.stats || [])[i] || '').replace(',', '')) || 0;
        });
      }
    }
  }
  return out;
}

/* A player's live value for a stat (null without a live box score for him). Players carry `eid` (ESPN id). */
function nflLiveValue(N, gid, pid, stat) {
  const box = (N.liveBox || {})[gid], p = N.players && N.players[pid];
  const row = box && p && p.eid && box[p.eid];
  return row && NFL_STATS[stat] ? NFL_STATS[stat].f(row) : null;
}

/* A game's box score by team: {live, teams: {TEAM: [{pid, n, pos, r}]}}. Saved box scores (logs) first; while the game
   is on, or right after it ends before the data job saves it, the live ESPN box score (N.liveBox) fills in. */
function nflBoxScore(N, g) {
  const teams = { [g.away]: [], [g.home]: [] };
  for (const [pid, list] of Object.entries(N.logs || {})) {
    const r = list.find(x => x.g && x.g.id === g.id);
    if (r && teams[r.team]) teams[r.team].push({ pid, n: (N.players[pid] || {}).n || pid, pos: (N.players[pid] || {}).pos || '', r });
  }
  let live = false;
  const box = (N.liveBox || {})[g.id];
  if (!teams[g.away].length && !teams[g.home].length && box) {
    const byEid = new Map(Object.entries(N.players || {}).filter(([, p]) => p.eid).map(([pid, p]) => [String(p.eid), pid]));
    for (const [eid, r] of Object.entries(box)) {
      if (!r || typeof r !== 'object' || !teams[r.team]) continue;
      const pid = byEid.get(eid) || null, p = (pid && N.players[pid]) || {};
      teams[r.team].push({ pid, n: p.n || r.n || eid, pos: p.pos || '', r });
    }
    live = true;
  }
  return { live, teams };
}

/* The live score a card or header shows: {away, home, detail} for a game in progress, else null. */
function nflLiveScore(g) {
  return g.state === 'in' && g.live ? { away: g.live.away, home: g.live.home, detail: g.detail || 'Live' } : null;
}

/* ms until checking is worth it for these games (0 = now), or null for never: any game in progress, or one kicking
   off within 10 minutes (or past kickoff but not final, up to 5 hours). */
function nflLiveWait(games, now) {
  let wait = null;
  for (const g of games) {
    if (g.state === 'in') return 0;
    if (g.state !== 'pre' || !g.eid) continue;
    const kick = Date.parse(nflIso(g)), until = kick - 10 * 60000 - now;
    if (until <= 0 && now - kick < 5 * 3600e3) return 0;
    if (until > 0 && (wait == null || until < wait)) wait = until;
  }
  return wait;
}

/* Poll while needed. opts: games (the ones on screen), gids (games to keep a live box score for), onUpdate(). Sets
   N.liveAt / N.liveFailed like live.js so liveNote(N) works. */
function nflStartLive(N, opts) {
  N.liveBox = N.liveBox || {};
  let timer = null, fails = 0, stopped = false;
  const getJSON = url => fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const games = () => opts.games;
  async function check() {
    timer = null;
    if (stopped || document.hidden) return;
    try {
      const weeks = [...new Set(games().map(g => `${g.season}|${g.type === 'POST' ? 3 : 2}|${g.week}`))];
      for (const w of weeks) {
        const [season, type, week] = w.split('|');
        const url = type === '2' ? `${NFL_LIVE_API}/scoreboard?dates=${season}&seasontype=2&week=${week}` : `${NFL_LIVE_API}/scoreboard`;
        nflApplyLive(N, parseLiveScoreboard(await getJSON(url)));
      }
      for (const gid of opts.gids || []) {
        const g = N.byId.get(gid);
        if (g && g.eid && (g.state === 'in' || (g.state === 'post' && N.liveBox[gid] && !N.liveBox[gid].final))) {
          N.liveBox[gid] = nflParseLiveBox(await getJSON(`${NFL_LIVE_API}/summary?event=${g.eid}`));
          if (g.state === 'post') N.liveBox[gid].final = true;
        }
      }
      fails = 0;
      N.liveAt = Date.now();
      opts.onUpdate && opts.onUpdate();
    } catch (e) {
      if (++fails >= 3) { N.liveFailed = true; stopped = true; opts.onUpdate && opts.onUpdate(); return; }
    }
    schedule();
  }
  function schedule() {
    if (stopped || timer) return;
    const wait = nflLiveWait(games(), Date.now());
    if (wait != null) timer = setTimeout(check, wait === 0 ? 25000 : wait);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !stopped && !timer) { if (nflLiveWait(games(), Date.now()) === 0) check(); else schedule(); }
  });
  if (nflLiveWait(games(), Date.now()) === 0) check(); else schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

if (typeof module !== 'undefined') {
  module.exports = { nflWasText, nflBoxScore, nflGameInsights, nflInsightCard, nflStrongSide, nflWilson, nflApplyLive, nflParseLiveBox, nflLiveValue, nflLiveScore, nflLiveWait, nflIso, nflGameView, gradeNflPick, NFL_STATS, NFL_POS_STATS, nflPosGroup, nflAddPlayers, nflPlayerRows, nflNextGame, nflTypical, nflPlayerWindows, nflDefVsPos, nflVsOpponent, nflGameProps, nflLadder, NFL_RANK_STATS, nflLab, nflSide, nflFinals, nflRecord, nflCurrentWeek, nflWeeks, nflLines, nflWindows, nflTeamTotals, nflRanks, nflCommonOpponents, nflKick };
}
