/* Hoop Lab shared code: data loading, stat definitions, hit rates, team trends, formatting, header/footer.
   Pages load this file, then call lab([...extra data files]) and render from what it returns. */
'use strict';

// ---------------------------------------------------------------- stats

// Prop stats. `f` reads a game-log row (see playerRows). The first four have sportsbook lines (The Odds API).
const STATS = {
  pts: { label: 'Points', short: 'PTS', f: r => r.pts },
  reb: { label: 'Rebounds', short: 'REB', f: r => r.reb },
  ast: { label: 'Assists', short: 'AST', f: r => r.ast },
  fg3m: { label: 'Threes made', short: '3PM', f: r => r.fg3m },
  pra: { label: 'Pts + Reb + Ast', short: 'PRA', f: r => r.pts + r.reb + r.ast },
  pr: { label: 'Pts + Reb', short: 'P+R', f: r => r.pts + r.reb },
  pa: { label: 'Pts + Ast', short: 'P+A', f: r => r.pts + r.ast },
  ra: { label: 'Reb + Ast', short: 'R+A', f: r => r.reb + r.ast },
  stl: { label: 'Steals', short: 'STL', f: r => r.stl },
  blk: { label: 'Blocks', short: 'BLK', f: r => r.blk },
  sb: { label: 'Steals + Blocks', short: 'STL+BLK', f: r => r.stl + r.blk },
  tov: { label: 'Turnovers', short: 'TO', f: r => r.tov },
  fga: { label: 'FG attempts', short: 'FGA', f: r => r.fga },
  fg3a: { label: '3PT attempts', short: '3PA', f: r => r.fg3a },
  fta: { label: 'FT attempts', short: 'FTA', f: r => r.fta },
};
const STAT_ORDER = Object.keys(STATS);
// Stats shown under the main chart to explain it (role and volume).
const SUPPORT = {
  min: { label: 'Minutes', f: r => r.min },
  fga: { label: 'FGA', f: r => r.fga },
  fg3a: { label: '3PA', f: r => r.fg3a },
  fta: { label: 'FTA', f: r => r.fta },
  pf: { label: 'Fouls', f: r => r.pf },
};

// Windows a hit rate can be measured over. `pick` gets the rows (oldest first) after filters.
const WINDOWS = [
  { key: 'h2h', label: 'H2H', pick: (rows, o) => o.opp ? rows.filter(r => r.opp === o.opp) : [] },
  { key: 'l5', label: 'L5', pick: rows => rows.slice(-5) },
  { key: 'l10', label: 'L10', pick: rows => rows.slice(-10) },
  { key: 'l20', label: 'L20', pick: rows => rows.slice(-20) },
  { key: 'season', label: 'Season', pick: (rows, o) => rows.filter(r => r.g.s === o.season) },
  { key: 'last', label: 'Last season', pick: (rows, o) => rows.filter(r => r.g.s === o.season - 1) },
];

/* Result of one value against a line: 'hit' when it clears the line on the chosen side ('o' over, 'u' under). */
function outcome(value, line, side = 'o') {
  if (value === line) return 'push';
  return (side === 'o' ? value > line : value < line) ? 'hit' : 'miss';
}

/* {hits, misses, pushes, n, rate} for a list of outcomes. Pushes count in n, so a push lowers the rate. */
function tally(results) {
  const t = { hits: 0, misses: 0, pushes: 0, n: results.length, rate: null };
  for (const r of results) {
    if (r === 'hit') t.hits++;
    else if (r === 'miss') t.misses++;
    else t.pushes++;
  }
  if (t.n) t.rate = t.hits / t.n;
  return t;
}

function mean(vals) {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function median(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* When no sportsbook line exists: the half-point line just above the player's last-10 average floor,
   e.g. 24.3 -> 24.5, so it sits where a book would hang it and can't push. */
function typicalLine(rows, stat) {
  const vals = rows.slice(-10).map(STATS[stat].f);
  if (!vals.length) return 0.5;
  return Math.floor(mean(vals)) + 0.5;
}

// ---------------------------------------------------------------- data

const DATA = {};
function load(...names) {
  return Promise.all(names.map(n => DATA[n] || (DATA[n] = fetch(`data/${n}.json`).then(r => {
    if (!r.ok) throw new Error(`data/${n}.json: ${r.status}`);
    return r.json();
  }))));
}

/* Load meta, teams and games (plus any extra files) and index them. */
async function lab(extra = []) {
  const [meta, teams, games, ...rest] = await load('meta', 'teams', 'games', ...extra);
  const L = indexLab(meta, teams, games);
  extra.forEach((n, i) => { L[n] = rest[i]; });
  return L;
}

function indexLab(meta, teams, games) {
  const L = { meta, teams, games, byId: new Map(), teamGames: {}, rest: {} };
  for (const g of games) {
    L.byId.set(g.id, g);
    for (const t of [g.h, g.a]) (L.teamGames[t] = L.teamGames[t] || []).push(g);
  }
  // Days of rest before each game, per team (0 = second night of a back-to-back).
  for (const [team, list] of Object.entries(L.teamGames)) {
    list.sort((a, b) => a.t < b.t ? -1 : 1);
    list.forEach((g, i) => {
      const prev = list[i - 1];
      L.rest[`${g.id}|${team}`] = prev ? dayDiff(prev.d, g.d) - 1 : 9;
    });
  }
  return L;
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
}

const isFinal = g => g.state === 'post' && g.hs != null;

/* One player's game log as objects, oldest first: {g, gid, team, opp, home, starter, margin, win, rest, ...cols}. */
function playerRows(L, pid) {
  const cols = L.meta.cols;
  return ((L.logs || {})[pid] || []).map(r => {
    const g = L.byId.get(r[0]);
    if (!g || !isFinal(g)) return null;
    const o = { g, gid: r[0], team: r[1], starter: !!r[2] };
    cols.forEach((c, i) => { o[c] = r[3 + i]; });
    o.home = g.h === o.team;
    o.opp = o.home ? g.a : g.h;
    o.margin = o.home ? g.hs - g.as : g.as - g.hs;
    o.win = o.margin > 0;
    o.rest = L.rest[`${g.id}|${o.team}`];
    return o;
  }).filter(Boolean).sort((a, b) => a.g.t < b.g.t ? -1 : 1);
}

/* game id -> Set of player ids who played (for the with / without teammate filters). */
function playedIndex(L) {
  if (L.played) return L.played;
  L.played = new Map();
  for (const [pid, rows] of Object.entries(L.logs || {})) {
    for (const r of rows) {
      if (!L.played.has(r[0])) L.played.set(r[0], new Set());
      L.played.get(r[0]).add(pid);
    }
  }
  return L.played;
}

/* Filters on a player's rows. Every key is optional. */
function applyFilters(L, rows, f) {
  const played = (f.with && f.with.length) || (f.without && f.without.length) ? playedIndex(L) : null;
  return rows.filter(r => {
    if (f.loc === 'home' && !r.home) return false;
    if (f.loc === 'away' && r.home) return false;
    if (f.minMin && r.min < f.minMin) return false;
    if (f.role === 'starter' && !r.starter) return false;
    if (f.role === 'bench' && r.starter) return false;
    if (f.rest === '0' && r.rest !== 0) return false;
    if (f.rest === '1' && r.rest !== 1) return false;
    if (f.rest === '2' && r.rest < 2) return false;
    if (f.result === 'win' && !r.win) return false;
    if (f.result === 'loss' && r.win) return false;
    if (f.margin === 'close' && Math.abs(r.margin) > 5) return false;
    if (f.margin === 'ten' && Math.abs(r.margin) > 10) return false;
    if (f.margin === 'blowout' && Math.abs(r.margin) < 15) return false;
    if (f.playoffs === 'no' && r.g.st !== 2) return false;
    if (played) {
      const set = played.get(r.gid) || new Set();
      if ((f.with || []).some(id => !set.has(id))) return false;
      if ((f.without || []).some(id => set.has(id))) return false;
    }
    return true;
  });
}

/* Hit rates in every window for one stat / line / side. opts: {opp, season}. */
function windowRates(rows, stat, line, side, opts) {
  const f = STATS[stat].f;
  const out = {};
  for (const w of WINDOWS) {
    const picked = w.pick(rows, opts);
    out[w.key] = { rows: picked, ...tally(picked.map(r => outcome(f(r), line, side))) };
  }
  return out;
}

// ---------------------------------------------------------------- teams

/* A final game from one team's side. */
function teamSide(g, team) {
  const home = g.h === team;
  const pts = home ? g.hs : g.as, opp = home ? g.as : g.hs;
  const sp = g.line && g.line.sp != null ? (home ? g.line.sp : -g.line.sp) : null;
  return {
    g, home, opp: home ? g.a : g.h, pts, oppPts: opp, margin: pts - opp, win: pts > opp, total: pts + opp,
    q: (home ? g.hq : g.aq) || [], oq: (home ? g.aq : g.hq) || [], spread: sp,
    tot: g.line && g.line.tot != null ? g.line.tot : null,
  };
}

/* A team's final games before `before` (ISO time), oldest first. */
function teamFinals(L, team, before) {
  return (L.teamGames[team] || []).filter(g => isFinal(g) && (!before || g.t < before)).map(g => teamSide(g, team));
}

/* Trend results for a game line, against THIS game's number: how often the last n games would have cleared it.
   kind: 'ml' (won), 'spread' (margin + spread > 0), 'over' / 'under' (game total vs line). */
function lineResults(sides, kind, num) {
  return sides.map(s => {
    if (kind === 'ml') return s.win ? 'hit' : 'miss';
    if (kind === 'spread') return outcome(s.margin + num, 0, 'o');
    return outcome(s.total, num, kind === 'over' ? 'o' : 'u');
  });
}

function h2hSides(L, team, opp, before, n = 10) {
  return teamFinals(L, team, before).filter(s => s.opp === opp).slice(-n);
}

/* Records and splits for the Matchup tab: label -> value, for one team and season. */
function teamSplits(L, team, season) {
  const sides = teamFinals(L, team).filter(s => s.g.s === season && s.g.st === 2);
  const T = L.teams, me = T[team] || {};
  const rec = list => `${list.filter(s => s.win).length}-${list.filter(s => !s.win).length}`;
  const qrec = (list, pick) => {
    let w = 0, l = 0, t = 0;
    for (const s of list) {
      const a = pick(s.q), b = pick(s.oq);
      if (a == null || b == null) continue;
      if (a > b) w++; else if (a < b) l++; else t++;
    }
    return `${w}-${l}-${t}`;
  };
  const sum = (arr, from, to) => arr.length >= to ? arr.slice(from, to).reduce((x, y) => x + y, 0) : null;
  const ats = sides.filter(s => s.spread != null);
  const ou = sides.filter(s => s.tot != null);
  const atsT = tally(ats.map(s => outcome(s.margin + s.spread, 0)));
  const ouT = tally(ou.map(s => outcome(s.total, s.tot)));
  const avg = k => sides.length ? (mean(sides.map(s => s[k]))).toFixed(1) : '-';
  const out = [
    ['Overall', rec(sides)],
    ['Home', rec(sides.filter(s => s.home))],
    ['Away', rec(sides.filter(s => !s.home))],
    ['Last 10', rec(sides.slice(-10))],
    ['Conference', rec(sides.filter(s => (T[s.opp] || {}).conf === me.conf))],
    ['Division', rec(sides.filter(s => (T[s.opp] || {}).div === me.div))],
  ];
  for (const div of ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest']) {
    out.push([`vs ${div}`, rec(sides.filter(s => (T[s.opp] || {}).div === div))]);
  }
  out.push(
    ['Against the spread', `${atsT.hits}-${atsT.misses}-${atsT.pushes}`],
    ['Over / under', `${ouT.hits}-${ouT.misses}-${ouT.pushes}`],
    ['Points per game', avg('pts')],
    ['Allowed per game', avg('oppPts')],
    ['Avg margin', sides.length ? signed(+avg('margin')) : '-'],
    ['1Q', qrec(sides, q => q[0])],
    ['2Q', qrec(sides, q => q[1])],
    ['1H', qrec(sides, q => sum(q, 0, 2))],
    ['3Q', qrec(sides, q => q[2])],
    ['4Q', qrec(sides, q => q[3])],
    ['2H', qrec(sides, q => sum(q, 2, 4))],
  );
  return { rows: out, games: sides.length };
}

// ---------------------------------------------------------------- defense vs position

const POSITIONS = ['G', 'F', 'C'];
const POS_LABEL = { G: 'guards', F: 'forwards', C: 'centers', ALL: 'all players' };

/* ESPN position -> 'G', 'F' or 'C'. PG/SG -> G, SF/PF -> F; any combo with a C ("F-C") counts as C. */
function posBucket(pos) {
  const parts = String(pos || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.includes('C')) return 'C';
  const p = parts[0];
  return p.endsWith('G') ? 'G' : p.endsWith('F') ? 'F' : null;
}

/* What each defense allows per game to each position, ranked 1-30 (1 = allows the most, the best spot for an over).
   Uses final regular-season games of `season`; opts.last limits each team to its last N of them.
   Returns {TEAM: {G|F|C|ALL: {games, per: {stat: value}, rank: {stat: rank}}}}. Memoized on L. */
function defenseVsPosition(L, season, opts = {}) {
  const key = `${season}|${opts.last || 0}`;
  L.dvp = L.dvp || {};
  if (L.dvp[key]) return L.dvp[key];
  // Which games count for each defense.
  const windowGames = {};
  for (const team of Object.keys(L.teams)) {
    let list = (L.teamGames[team] || []).filter(g => isFinal(g) && g.s === season && g.st === 2);
    if (opts.last) list = list.slice(-opts.last);
    windowGames[team] = new Set(list.map(g => g.id));
  }
  const buckets = [...POSITIONS, 'ALL'];
  const sums = {};
  for (const team of Object.keys(L.teams)) {
    sums[team] = {};
    for (const b of buckets) sums[team][b] = Object.fromEntries(STAT_ORDER.map(s => [s, 0]));
  }
  const cols = L.meta.cols;
  for (const [pid, rows] of Object.entries(L.logs || {})) {
    const bucket = posBucket((L.players[pid] || {}).p);
    for (const r of rows) {
      const g = L.byId.get(r[0]);
      if (!g) continue;
      const def = r[1] === g.h ? g.a : g.h;
      if (!windowGames[def] || !windowGames[def].has(g.id)) continue;
      const row = {};
      cols.forEach((c, i) => { row[c] = r[3 + i]; });
      for (const s of STAT_ORDER) {
        const v = STATS[s].f(row);
        sums[def].ALL[s] += v;
        if (bucket) sums[def][bucket][s] += v;
      }
    }
  }
  const out = {};
  for (const team of Object.keys(L.teams)) {
    const n = windowGames[team].size;
    out[team] = {};
    for (const b of buckets) {
      out[team][b] = { games: n, rank: {}, per: Object.fromEntries(STAT_ORDER.map(s => [s, n ? sums[team][b][s] / n : null])) };
    }
  }
  // Rank within each bucket and stat; teams without games get no rank. Ties share the higher rank.
  for (const b of buckets) {
    for (const s of STAT_ORDER) {
      const vals = Object.keys(out).filter(t => out[t][b].games).map(t => [t, out[t][b].per[s]]).sort((x, y) => y[1] - x[1]);
      vals.forEach(([t, v], i) => {
        out[t][b].rank[s] = i && v === vals[i - 1][1] ? out[vals[i - 1][0]][b].rank[s] : i + 1;
      });
    }
  }
  L.dvp[key] = out;
  return out;
}

const DVP_MIN_GAMES = 5;

/* A defense's rank vs one position for one stat, from this season once the team has DVP_MIN_GAMES games,
   otherwise last season. {rank, per, games, season, of} or null. */
function oppRank(L, team, bucket, stat) {
  const b = bucket || 'ALL';
  for (const season of [L.meta.season, L.meta.season - 1]) {
    const table = defenseVsPosition(L, season), cell = (table[team] || {})[b];
    const enough = season === L.meta.season ? DVP_MIN_GAMES : 1;
    if (cell && cell.games >= enough) {
      return { rank: cell.rank[stat], per: cell.per[stat], games: cell.games, season, of: Object.values(table).filter(x => x[b].games).length };
    }
  }
  return null;
}

/* Green when the defense is among the 10 most generous for this stat and position, red among the 10 stingiest. */
function rankClass(rank, of = 30) {
  if (rank == null) return '';
  return rank <= 10 ? 'soft' : rank > of - 10 ? 'tough' : 'mid';
}

/* "OPP RANK 3 TOR" cell for prop rows. */
function oppRankCell(L, opp, pos, stat) {
  const bucket = posBucket(pos);
  const r = oppRank(L, opp, bucket, stat);
  if (!r || r.rank == null) return `<div><small>OPP RANK</small><span class="rate none">-</span></div>`;
  const who = POS_LABEL[bucket || 'ALL'];
  const yrs = r.season === L.meta.season ? 'this season' : `last season (${opp} has under ${DVP_MIN_GAMES} games this year)`;
  const tip = `${opp} allows ${fmt1(r.per)} ${STATS[stat].short} per game to ${who}, ${r.rank} of ${r.of}, ${yrs}. 1 = allows the most (best for an over).`;
  return `<div class="opprank ${rankClass(r.rank, r.of)}" title="${esc(tip)}"><small>OPP RANK</small><b>${r.rank}</b> ${esc(opp)}</div>`;
}

// ---------------------------------------------------------------- formatting

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = (n, d = 1) => n == null || isNaN(n) ? '-' : (n > 0 ? '+' : '') + (Number.isInteger(n) ? n : n.toFixed(d));
const odds = n => n == null ? '' : n > 0 ? `+${n}` : `${n}`;
const pct = r => r == null ? '-' : `${Math.round(r * 100)}%`;
const fmt1 = n => n == null || isNaN(n) ? '-' : (Math.round(n * 10) / 10).toString();
const BOOKS = { draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM', williamhill_us: 'CZR', espnbet: 'ESPN', betrivers: 'BR', fanatics: 'FAN', bovada: 'BOV', betonlineag: 'BOL', mybookieag: 'MYB', lowvig: 'LV', ballybet: 'BALLY', hardrockbet: 'HR' };
const bookName = k => BOOKS[k] || k || '';

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(isoDate, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(isoDate + 'T12:00:00').toLocaleDateString([], opts);
}
const shortDate = isoDate => { const [, m, d] = isoDate.split('-'); return `${+m}/${+d}`; };

/* Status line for a game card: tip time, live clock or Final. */
function gameStatus(g) {
  if (g.state === 'pre') return fmtTime(g.t);
  if (g.state === 'in') return `<span class="live">${esc(g.detail || 'Live')}</span>`;
  return esc(g.detail || 'Final');
}

function logo(L, abbr, size = 28) {
  const t = L.teams[abbr];
  return t ? `<img class="logo" src="${t.logo}" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.style.visibility='hidden'">` : '';
}

function headshot(pid, size = 40) {
  const src = `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${pid}.png&w=96&h=70&scale=crop`;
  return `<span class="hs" style="width:${size}px;height:${size}px"><img src="${src}" alt="" loading="lazy" onerror="this.remove()"></span>`;
}

/* Colored dashes for a list of outcomes, oldest on the left. */
function strip(results, titles = []) {
  return `<div class="strip">${results.map((r, i) => `<i class="${r}"${titles[i] ? ` title="${esc(titles[i])}"` : ''}></i>`).join('')}</div>`;
}

/* A hit-rate number colored by how strong it is. */
function rateTag(t, opts = {}) {
  if (!t || !t.n) return `<span class="rate none">-</span>`;
  const cls = t.rate >= 0.7 ? 'hot' : t.rate >= 0.55 ? 'warm' : t.rate <= 0.3 ? 'cold' : '';
  return `<span class="rate ${cls}">${pct(t.rate)}${opts.count ? ` <small>${t.hits}/${t.n}</small>` : ''}</span>`;
}

function injuryTag(inj) {
  if (!inj) return '';
  const s = String(inj.st || '').toLowerCase();
  const code = s.startsWith('out') ? 'O' : s.startsWith('doubt') ? 'D' : s.startsWith('quest') ? 'Q' : s.startsWith('prob') ? 'P' : s.startsWith('day') ? 'DTD' : 'INJ';
  return `<span class="inj inj-${code.toLowerCase()}" title="${esc(`${inj.st}: ${inj.det || ''}`)}">${code}</span>`;
}

function injuryMap(L) {
  return new Map((L.injuries || []).filter(i => i.id).map(i => [i.id, i]));
}

/* Moneyline / spread / total for one game, each side with its last-10 strip against this game's number
   and the head-to-head rate. Used on game cards and the game page. */
function gameLines(L, g) {
  const line = g.line || {};
  const A = teamFinals(L, g.a, g.t).slice(-10), H = teamFinals(L, g.h, g.t).slice(-10);
  const hA = h2hSides(L, g.a, g.h, g.t), hH = h2hSides(L, g.h, g.a, g.t);
  const titles = sides => sides.map(s => `${shortDate(s.g.d)} ${s.home ? 'vs' : '@'} ${s.opp}: ${s.pts}-${s.oppPts}`);
  const side = (abbr, label, price, sides, h2h, kind, num, right) => {
    const r = lineResults(sides, kind, num), t = tally(r), th = tally(lineResults(h2h, kind, num));
    const lab = `<b>${esc(label)}</b>`, pr = price != null ? `<span class="price">${odds(price)}</span>` : '';
    const trend = [`<span><span class="tag">L${t.n}</span> ${rateTag(t)}</span>`, th.n ? `<span><span class="tag">H2H</span> ${rateTag(th)}</span>` : ''];
    return `<div><div class="side">${lab}<span class="grow"></span>${pr}</div>${strip(right ? [...r].reverse() : r, right ? titles(sides).reverse() : titles(sides))}
      <div class="trend">${(right ? trend.reverse() : trend).join('')}</div></div>`;
  };
  const parts = [];
  if (line.mla != null || line.mlh != null) {
    parts.push(`<div class="mkt"><h4>Money line</h4><div class="pair">${side(g.a, g.a, line.mla, A, hA, 'ml')}${side(g.h, g.h, line.mlh, H, hH, 'ml', null, true)}</div></div>`);
  }
  if (line.sp != null) {
    parts.push(`<div class="mkt"><h4>Spread</h4><div class="pair">${side(g.a, `${g.a} ${signed(-line.sp)}`, line.spa, A, hA, 'spread', -line.sp)}${side(g.h, `${g.h} ${signed(line.sp)}`, line.sph, H, hH, 'spread', line.sp, true)}</div></div>`);
  }
  if (line.tot != null) {
    const ou = (abbr, sides, right) => {
      const o = tally(lineResults(sides, 'over', line.tot)), u = tally(lineResults(sides, 'under', line.tot));
      const r = lineResults(sides, 'over', line.tot);
      const txt = `<span><span class="tag">${abbr} L${o.n}</span> O ${pct(o.rate)} · U ${pct(u.rate)}</span>`;
      return `<div>${strip(right ? [...r].reverse() : r, right ? titles(sides).reverse() : titles(sides))}<div class="trend" style="justify-content:${right ? 'flex-end' : 'flex-start'}">${txt}</div></div>`;
    };
    parts.push(`<div class="mkt"><h4>Total</h4><div class="pair">
      <div><div class="side"><b>O ${line.tot}</b><span class="grow"></span>${line.ov != null ? `<span class="price">${odds(line.ov)}</span>` : ''}</div></div>
      <div><div class="side"><b>U ${line.tot}</b><span class="grow"></span>${line.un != null ? `<span class="price">${odds(line.un)}</span>` : ''}</div></div>
      ${ou(g.a, A)}${ou(g.h, H, true)}</div></div>`);
  }
  if (!parts.length) return `<p class="note" style="padding:0 14px 12px">No lines posted yet.</p>`;
  return parts.join('') + (line.bk ? `<p class="note" style="padding:0 14px 12px;margin:0">Lines: ${esc(line.bk)}. Strips: each team's last games against this number, oldest on the left.</p>` : '');
}

/* How a final game's lines came out: "PHI covered -4.5 · Over 237.5 (241)". */
function lineResult(g) {
  const l = g.line;
  if (!l || !isFinal(g)) return '';
  const out = [];
  if (l.sp != null) {
    const fav = l.sp <= 0 ? g.h : g.a, favSp = l.sp <= 0 ? l.sp : -l.sp;
    const m = (fav === g.h ? g.hs - g.as : g.as - g.hs) + favSp;
    out.push(m === 0 ? `Push ${fav} ${signed(favSp)}` : `${fav} ${m > 0 ? 'covered' : 'missed'} ${signed(favSp)}`);
  }
  if (l.tot != null) {
    const t = g.hs + g.as;
    out.push(t === l.tot ? `Push ${l.tot}` : `${t > l.tot ? 'Over' : 'Under'} ${l.tot} (${t})`);
  }
  return out.join(' · ');
}

const params = () => new URLSearchParams(location.search);

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(`hooplab.${key}`));
    localStorage.setItem(`hooplab.${key}`, JSON.stringify(val));
  } catch (e) { return null; }
  return val;
}

// ---------------------------------------------------------------- page shell

const NAV = [
  ['games', 'index.html', 'Games', '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18M3 12h18M5.6 5.6c3 2.4 3 10.4 0 12.8M18.4 5.6c-3 2.4-3 10.4 0 12.8"/>'],
  ['props', 'props.html', 'Props', '<path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/>'],
  ['players', 'players.html', 'Players', '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'],
];

function shell(active) {
  const links = NAV.map(([k, href, label, icon]) =>
    `<a href="${href}" class="${k === active ? 'on' : ''}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span></a>`).join('');
  const top = document.getElementById('top');
  if (top) {
    top.innerHTML = `<a class="brand" href="index.html"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="var(--accent)"/><path d="M3 16h26M16 3v26M7 7c5 4 5 14 0 18M25 7c-5 4-5 14 0 18" stroke="#1a0f05" stroke-width="1.6" fill="none"/></svg>Hoop Lab</a><nav class="topnav">${links}</nav>`;
  }
  const bottom = document.createElement('nav');
  bottom.className = 'bottomnav';
  bottom.innerHTML = links;
  document.body.appendChild(bottom);
}

function footer(L) {
  const el = document.getElementById('foot');
  if (!el) return;
  const built = L && L.meta ? new Date(L.meta.built).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  el.innerHTML = `<p>Data: ESPN (scores, box scores, game lines, injuries) and The Odds API (player props).${built ? ` Updated ${esc(built)}.` : ''}</p>
    <p>Hit rates describe the past, not the future. For research and fun; bet responsibly.</p>`;
}

function fail(err) {
  const main = document.querySelector('main');
  if (main) main.innerHTML = `<div class="card empty">Couldn't load the data (${esc(err.message)}). Try again in a minute.</div>`;
  console.error(err);
}

if (typeof module !== 'undefined') {
  module.exports = { STATS, WINDOWS, outcome, tally, mean, median, typicalLine, indexLab, playerRows, applyFilters, windowRates, teamSide, teamFinals, lineResults, h2hSides, teamSplits, signed, odds, pct, posBucket, defenseVsPosition, oppRank, rankClass };
}
