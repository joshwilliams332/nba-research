/* Hoop Lab game-line breakdown (line.html): one bet (money line, spread or total, one side) explained with hit
   rates by window, the game-by-game list, a team-level estimate, insights, a team shot chart, the lineup and line
   movement. Loads after common.js (and pbp.js / insights.js on line.html); pure parts are tested in
   tests/gameline.test.js. */
'use strict';

if (typeof module !== 'undefined' && typeof teamFinals === 'undefined') {
  Object.assign(globalThis, require('./common.js'));
}

// Team estimate settings, chosen on the 2025-26 regular season (see the "estimate" note on line.html).
const GL = {
  games: 20,        // recent finals each team's scoring and allowing averages use
  minGames: 8,      // below this, last season's games fill in
  homeEdge: 1.6,    // points
  marginSd: 13.0,   // spread of the final margin around the estimate
  totalSd: 19.0,    // spread of the final total around the estimate
};

const LINE_FIELDS = ['sp', 'tot', 'mlh', 'mla'];
const MARKETS_GL = { ml: 'Money line', spread: 'Spread', total: 'Total' };

/* Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1e-7). */
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/* A team's recent scoring and allowing per game before time t (regular season and playoffs). */
function teamForm(L, team, t) {
  let sides = teamFinals(L, team, t).filter(s => s.g.st !== 1);
  sides = sides.slice(-GL.games);
  if (sides.length < GL.minGames) return null;
  return { off: mean(sides.map(s => s.pts)), def: mean(sides.map(s => s.oppPts)), n: sides.length };
}

/* Estimated score for game g from both teams' recent form: each side's points = average of what it scores and what
   the other team allows, plus home edge. Returns chances for the home side's money line and spread, and the over. */
function gameEstimate(L, g) {
  const H = teamForm(L, g.h, g.t), A = teamForm(L, g.a, g.t);
  if (!H || !A) return null;
  const edge = g.n ? 0 : GL.homeEdge / 2;
  const home = (H.off + A.def) / 2 + edge, away = (A.off + H.def) / 2 - edge;
  const margin = home - away, total = home + away;
  return {
    home, away, margin, total,
    winH: normCdf(margin / GL.marginSd),
    coverH: sp => normCdf((margin + sp) / GL.marginSd),       // sp = home spread (e.g. -4.5)
    over: tot => 1 - normCdf((tot - total) / GL.totalSd),
  };
}

/* Chance for one side of one market from an estimate. side: 'h' / 'a' for ml and spread, 'o' / 'u' for total. */
function sideChance(est, line, m, side) {
  if (!est || !line) return null;
  if (m === 'ml') return side === 'h' ? est.winH : 1 - est.winH;
  if (m === 'spread' && line.sp != null) { const c = est.coverH(line.sp); return side === 'h' ? c : 1 - c; }
  if (m === 'total' && line.tot != null) { const o = est.over(line.tot); return side === 'o' ? o : 1 - o; }
  return null;
}

/* Which team's history a side is judged on (for totals, both teams are shown; `team` picks one). */
function sideTeam(g, m, side, team) {
  if (m === 'total') return team || g.a;
  return side === 'h' ? g.h : g.a;
}

/* The number this side is judged against, from the team's point of view: spread for that team, or the total. */
function sideNumber(g, m, side) {
  const l = g.line || {};
  if (m === 'spread') return l.sp == null ? null : (side === 'h' ? l.sp : -l.sp);
  if (m === 'total') return l.tot == null ? null : l.tot;
  return null;
}

/* Results of a team's past games against tonight's number for this market side. */
function sideResults(sides, m, side, num) {
  if (m === 'ml') return lineResults(sides, 'ml');
  if (m === 'spread') return lineResults(sides, 'spread', num);
  return lineResults(sides, side === 'u' ? 'under' : 'over', num);
}

const GL_WINDOWS = [['h2h', 'H2H'], ['l5', 'L5'], ['l10', 'L10'], ['l20', 'L20'], ['season', 'Season'], ['last', 'Last season']];

/* The team's past games in each window (oldest first), before game g. filter: optional {loc: 'home'|'away'}. */
function sideWindows(L, g, team, filter = {}) {
  const opp = team === g.h ? g.a : g.h;
  let all = teamFinals(L, team, g.t).filter(s => s.g.st !== 1);
  if (filter.loc === 'home') all = all.filter(s => s.home);
  if (filter.loc === 'away') all = all.filter(s => !s.home);
  return {
    h2h: all.filter(s => s.opp === opp).slice(-10), l5: all.slice(-5), l10: all.slice(-10), l20: all.slice(-20),
    season: all.filter(s => s.g.s === g.s), last: all.filter(s => s.g.s === g.s - 1),
  };
}

/* Line movement from the stored history: [{t, sp, tot, mlh, mla}] plus what changed between the first and last. */
function lineMoves(g) {
  const pts = (g.lh || []).map(([t, sp, tot, mlh, mla]) => ({ t, sp, tot, mlh, mla }));
  if (!pts.length && g.line) {
    // No history saved yet (older games): the first line we saw, then the current one if it differs.
    if (g.open) pts.push({ t: null, ...pick(g.open) });
    const now = { t: null, ...pick(g.line) };
    if (!pts.length || LINE_FIELDS.some(k => pts[0][k] !== now[k])) pts.push(now);
  }
  return pts;
  function pick(l) { return { sp: l.sp, tot: l.tot, mlh: l.mlh, mla: l.mla }; }
}

// ---------------------------------------------------------------- rendering (browser)

/* Probable starters (who started each team's last game) and the injury report, for game g. */
function lineupHTML(L, g) {
  const injAll = injuryMap(L);
  const started = new Map();
  for (const [pid, list] of Object.entries(L.logs || {})) for (const r of list) if (r[2]) {
    if (!started.has(r[0])) started.set(r[0], []);
    started.get(r[0]).push({ pid, team: r[1] });
  }
  const col = team => {
    const last = teamFinals(L, team).slice(-1)[0];
    const starters = last ? (started.get(last.g.id) || []).filter(r => r.team === team) : [];
    const injs = (L.injuries || []).filter(i => i.t === team);
    return `<div><div class="row" style="margin-bottom:4px">${logo(L, team, 20)}<b>${esc(team)}</b></div>
      ${starters.map(r => `<a href="player.html?id=${r.pid}">${headshot(r.pid, 26)}<span>${esc((L.players[r.pid] || {}).n || r.pid)}</span>${injuryTag(injAll.get(r.pid))}</a>`).join('') || '<p class="muted">No games yet.</p>'}
      ${injs.length ? `<p class="note" style="margin-top:8px"><b>Injuries:</b> ${injs.map(i => `${esc(i.n)} <span class="inj ${String(i.st).toLowerCase().startsWith('out') ? 'inj-o' : ''}">${esc(i.st)}</span>`).join(' · ')}</p>` : '<p class="note">No injuries reported.</p>'}</div>`;
  };
  return `<h2>Lineup</h2><p class="muted" style="margin:0 0 8px;font-size:13px">Probable starters = who started each team's last game.</p>
    <div class="starters">${col(g.a)}${col(g.h)}</div>`;
}

/* Team shot chart: where `team` scores, colored by its FG% vs league, next to the opponent's defense in that zone. */
function teamShotCard(L, g, team, state) {
  const S = L.shots;
  if (!S || !S.off || !S.off[team]) return '';
  const opp = team === g.h ? g.a : g.h;
  const seasons = [g.s, g.s - 1].filter(s => S.off[team][s]);
  if (!seasons.length) return '';
  if (!seasons.includes(state.season)) state.season = S.off[team][g.s] && S.off[team][g.s][12] >= 5 ? g.s : seasons[seasons.length - 1];
  const season = state.season, lg = S.league[season];
  const zones = zoneRows(S.off[team][season], lg);
  if (!state.zone) state.zone = zones.slice().sort((a, b) => b.ptsPerGame - a.ptsPerGame)[0].zone;
  const z = zones.find(x => x.zone === state.zone);
  const d = S.def[opp] && S.def[opp][season] ? zoneRows(S.def[opp][season], lg).find(x => x.zone === state.zone) : null;
  const yy = s => `${s - 1}-${String(s).slice(2)}`;
  return `<div class="row"><h2 class="grow">Shot chart: ${esc(team)} offense vs ${esc(opp)} defense</h2><div class="pills">${seasons.map(s =>
      `<button class="pill ${s === season ? 'on' : ''}" data-shotseason="${s}">${yy(s)}</button>`).join('')}</div></div>
    <div class="shotwrap">${courtSVG(zones, state.zone)}</div>
    <p class="note" style="margin-top:4px">Color: ${esc(team)}'s FG% vs league average in that zone; stronger color = more shots. Tap a zone.</p>
    <div class="zonecard"><h3 style="text-align:center;margin-bottom:8px">${esc(ZONE_INFO[z.zone].label)}</h3>
      <div class="zgrid">
        <div><div class="muted">${esc(team)} points / game</div><div class="big">${fmt1(z.ptsPerGame)} <small class="muted">#${z.rank ?? '-'} of 30</small></div>
          <div class="kv"><span>Attempts / game</span><b>${fmt1(z.perGame)}</b></div>
          <div class="kv"><span>FG%</span><b>${pct(z.pct)}</b></div><small class="muted">league ${pct(z.lgPct)}</small></div>
        ${d && d.games ? `<div><div class="muted">${esc(opp)} allows / game</div><div class="big">${fmt1(d.ptsPerGame)} ${rankChip(d.rank)}</div>
          <div class="kv"><span>Attempts allowed</span><b>${fmt1(d.perGame)}</b></div>
          <div class="kv"><span>Opp FG%</span><b>${pct(d.pct)}</b></div><small class="muted">rank: 1 = allows the most</small></div>`
          : `<div class="muted">No ${esc(opp)} defense data for ${yy(season)}.</div>`}
      </div></div>`;
}

if (typeof module !== 'undefined') {
  module.exports = { GL, normCdf, teamForm, gameEstimate, sideChance, sideTeam, sideNumber, sideResults, sideWindows, lineMoves };
}
