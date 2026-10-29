/* Hoop Lab live scores: while a game is on, the page asks ESPN's public scoreboard (and, for games on screen, the
   game summary's box score) for fresh numbers every LIVE_EVERY ms, straight from the browser. No API key, no Odds API
   credits, no server: the data job's snapshot stays the fallback, and if ESPN can't be reached the page simply keeps
   showing it. Polling pauses while the tab is hidden and stops once nothing is live or about to tip.

   Loaded after common.js. Parsing is pure and unit tested in tests/live.test.js. */
'use strict';

if (typeof module !== 'undefined' && typeof STATS === 'undefined') {
  Object.assign(globalThis, require('./common.js'));
}

const LIVE_EVERY = 25000;                 // ms between checks while a game is live
const LIVE_SOON = 10 * 60000;             // start checking this long before a tip
const LIVE_MAX_FAILS = 3;                 // give up (keep the snapshot) after this many failed checks in a row
const LIVE_API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
// ESPN abbreviations -> ours (the data script's ALIASES, for the ones that differ).
const LIVE_ALIASES = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', PHO: 'PHX', BRK: 'BKN' };
// Box score label -> game-log column(s); "8-17" labels fill made and attempted.
const LIVE_LABELS = {
  MIN: ['min'], PTS: ['pts'], REB: ['reb'], AST: ['ast'], FG: ['fgm', 'fga'], '3PT': ['fg3m', 'fg3a'], FT: ['ftm', 'fta'],
  OREB: ['oreb'], DREB: ['dreb'], STL: ['stl'], BLK: ['blk'], TO: ['tov'], PF: ['pf'], '+/-': ['pm'],
};

const liveAbbr = t => { const a = String((t || {}).abbreviation || '').toUpperCase(); return LIVE_ALIASES[a] || a; };
const liveNum = v => { const n = parseFloat(String(v == null ? '' : v).replace('+', '')); return isNaN(n) ? 0 : n; };

/* ESPN scoreboard -> [{id, state, hs, as, detail, hq, aq}] for every game on it. */
function parseLiveScoreboard(data) {
  const out = [];
  for (const ev of (data && data.events) || []) {
    const comp = (ev.competitions || [])[0] || {};
    const status = comp.status || ev.status || {};
    const side = {};
    for (const c of comp.competitors || []) side[c.homeAway] = c;
    if (!side.home || !side.away) continue;
    const state = ((status.type || {}).state) || 'pre';
    const g = { id: String(ev.id), state, detail: (status.type || {}).shortDetail || '' };
    if (state !== 'pre') {
      g.hs = liveNum(side.home.score);
      g.as = liveNum(side.away.score);
      g.hq = (side.home.linescores || []).map(x => liveNum(x.value != null ? x.value : x.displayValue));
      g.aq = (side.away.linescores || []).map(x => liveNum(x.value != null ? x.value : x.displayValue));
    }
    out.push(g);
  }
  return out;
}

/* Copy fresh scores onto the loaded games. A game never goes backwards (a final stays final).
   Returns how many games changed. */
function applyLiveScores(L, list) {
  const rank = { pre: 0, in: 1, post: 2 };
  let changed = 0;
  for (const x of list) {
    const g = L.byId.get(x.id);
    if (!g || (rank[x.state] ?? 0) < (rank[g.state] ?? 0)) continue;
    const before = `${g.state}|${g.hs}|${g.as}|${g.detail}`;
    g.state = x.state;
    g.detail = x.detail || g.detail;
    if (x.state !== 'pre') Object.assign(g, { hs: x.hs, as: x.as, hq: x.hq, aq: x.aq });
    if (`${g.state}|${g.hs}|${g.as}|${g.detail}` !== before) changed++;
  }
  return changed;
}

/* ESPN game summary -> {pid: row} where row has the game-log columns plus team and starter, for everyone who has
   played. Players marked did-not-play (or with nothing yet) are left out. */
function parseLiveBox(summary) {
  const out = {};
  for (const side of ((summary || {}).boxscore || {}).players || []) {
    const team = liveAbbr(side.team);
    for (const block of side.statistics || []) {
      const labels = (block.labels || []).map(x => String(x).toUpperCase());
      for (const a of block.athletes || []) {
        const pid = String(((a.athlete || {}).id) || '');
        if (!pid || a.didNotPlay || !(a.stats || []).length) continue;
        const row = { team, starter: !!a.starter };
        labels.forEach((label, i) => {
          const cols = LIVE_LABELS[label];
          if (!cols) return;
          const parts = cols.length === 2 ? String(a.stats[i]).split('-') : [a.stats[i]];
          cols.forEach((c, k) => { row[c] = liveNum(parts[k]); });
        });
        for (const c of ['min', 'pts', 'reb', 'ast', 'fg3m', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf', 'pm']) row[c] = row[c] || 0;
        if (!row.min && !row.pts && !row.reb && !row.ast) continue;
        out[pid] = row;
      }
    }
  }
  return out;
}

/* A player's live value for a stat in a game, or null when we have no live box score for him. */
function liveValue(L, gid, pid, stat) {
  const box = (L.liveBox || {})[gid];
  const row = box && box[pid];
  return row && STATS[stat] ? STATS[stat].f(row) : null;
}

/* "Now 19 / 24.5" for a prop during a game: green once an over is already cleared (or an under is already lost: red). */
function liveTag(value, line, side = 'o') {
  if (value == null) return '';
  const cls = side === 'o' ? (value > line ? 'hit' : '') : (value > line ? 'miss' : '');
  return `<span class="livenow ${cls}" title="Live: ${value} so far vs the ${line} line"><i></i>${Math.round(value * 10) / 10} <small>/ ${line}</small></span>`;
}

/* Should we be checking for live numbers? Any game in progress, or one tipping within LIVE_SOON (or past its tip
   time but still marked pre-game in the snapshot). Returns ms until the next check is worth doing, or null for never. */
function liveWait(games, now) {
  let wait = null;
  for (const g of games) {
    if (g.state === 'in') return 0;
    if (g.state !== 'pre' || !g.t) continue;
    const until = Date.parse(g.t) - LIVE_SOON - now;
    if (until <= 0 && now - Date.parse(g.t) < 4 * 3600e3) return 0;
    if (until > 0 && (wait == null || until < wait)) wait = until;
  }
  return wait;
}

const liveDate = iso => iso.replace(/-/g, '');

/* Start polling. opts: day (ET date of the games on screen), gids (games to keep a live box score for),
   onUpdate() called after each successful check. Returns {stop}. Sets L.liveAt (time of the last good check)
   and L.liveFailed (true once ESPN can't be reached). */
function startLive(L, opts) {
  L.liveBox = L.liveBox || {};
  let timer = null, fails = 0, stopped = false;
  const games = () => L.games.filter(g => g.d === opts.day || (opts.gids || []).includes(g.id));
  const getJSON = url => fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

  async function check() {
    timer = null;
    if (stopped) return;
    if (document.hidden) return;  // resumes on visibilitychange
    try {
      const days = [...new Set(games().map(g => g.d))];
      for (const d of days) applyLiveScores(L, parseLiveScoreboard(await getJSON(`${LIVE_API}/scoreboard?dates=${liveDate(d)}`)));
      for (const gid of opts.gids || []) {
        const g = L.byId.get(gid);
        // Keep the box score coming while it's on and once more after it ends (the snapshot won't have it yet).
        if (g && (g.state === 'in' || (g.state === 'post' && !(L.liveBox[gid] || {}).final))) {
          L.liveBox[gid] = parseLiveBox(await getJSON(`${LIVE_API}/summary?event=${gid}`));
          if (g.state === 'post') L.liveBox[gid].final = true;
        }
      }
      fails = 0;
      L.liveAt = Date.now();
      opts.onUpdate && opts.onUpdate();
    } catch (e) {
      fails++;
      if (fails >= LIVE_MAX_FAILS) { L.liveFailed = true; stopped = true; opts.onUpdate && opts.onUpdate(); return; }
    }
    schedule();
  }

  function schedule() {
    if (stopped || timer) return;
    const wait = liveWait(games(), Date.now());
    if (wait == null) return;
    timer = setTimeout(check, Math.max(wait, wait === 0 ? LIVE_EVERY : 0));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !stopped && !timer) {
      if (liveWait(games(), Date.now()) === 0) check(); else schedule();
    }
  });
  if (liveWait(games(), Date.now()) === 0) check(); else schedule();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

/* Fill in a saved pick's grade from the live box score (needs picks.js loaded): while the game is on, `now` is the
   stat so far; once it's final but before the data job has saved its box score (which would otherwise read as
   "didn't play"), the pick is settled from the live final box score. */
function liveGradePick(L, pick, grade) {
  const g = grade.g;
  if (!g || !pick.pid) return grade;
  const now = liveValue(L, g.id, pick.pid, pick.stat);
  if (grade.status === 'live' && now != null) return { ...grade, now };
  const box = (L.liveBox || {})[g.id];
  if (grade.status === 'void' && g.state === 'post' && box && box.final && now != null) {
    const result = settle(now, pick.line, pick.side);
    return { ...grade, status: result, actual: now, why: undefined, profit: payout(result, pick.price, pick.units || 1) };
  }
  return grade;
}

/* "Live · 10:41:05 PM" (or why not) for a page's status line. */
function liveNote(L) {
  if (L.liveFailed) return 'live scores unavailable, showing the last update';
  if (!L.liveAt) return '';
  return `live · ${new Date(L.liveAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

if (typeof module !== 'undefined') {
  module.exports = { LIVE_EVERY, LIVE_SOON, parseLiveScoreboard, applyLiveScores, parseLiveBox, liveValue, liveTag, liveGradePick, liveWait, liveNote };
}
