/* Hoop Lab play-by-play features: 1st-quarter / 1st-half stats, shot zones, win probability and first basket.
   Built from ESPN play-by-play by scripts/build_data.py (periods.json, shots.json, wp/<game id>.json,
   games[].fb). Loads after common.js; every file is optional, so pages still work before it exists. */
'use strict';

// 1Q / 1H stats join the player page's stat tabs. Their values come from periods.json, attached to each
// game-log row as r.per by attachPeriods(); rows without play-by-play are left out of those stats.
const PERIOD_STATS = {
  q1pts: { label: '1st quarter points', short: '1Q PTS', i: 0 },
  q1reb: { label: '1st quarter rebounds', short: '1Q REB', i: 1 },
  q1ast: { label: '1st quarter assists', short: '1Q AST', i: 2 },
  h1pts: { label: '1st half points', short: '1H PTS', i: 4 },
  h1reb: { label: '1st half rebounds', short: '1H REB', i: 5 },
  h1ast: { label: '1st half assists', short: '1H AST', i: 6 },
  h1fg3m: { label: '1st half threes', short: '1H 3PM', i: 7 },
};
for (const [k, s] of Object.entries(PERIOD_STATS)) {
  STATS[k] = { label: s.label, short: s.short, period: true, f: r => (r.per ? r.per[s.i] : 0) };
  STAT_ORDER.push(k);
}

// Shot zones, in shots.json order. `at` is where the zone's label sits on the court drawing (feet).
const ZONE_INFO = {
  ra: { label: 'Restricted area', short: 'RA', value: 2, at: [25, 9.6] },
  paint: { label: 'Paint (non-RA)', short: 'Paint', value: 2, at: [25, 16.2] },
  mid: { label: 'Mid-range', short: 'Mid', value: 2, at: [25, 24.5] },
  lc3: { label: 'Left corner 3', short: 'L corner', value: 3, at: [1.5, 7] },
  rc3: { label: 'Right corner 3', short: 'R corner', value: 3, at: [48.5, 7] },
  atb3: { label: 'Above the break 3', short: 'Above break', value: 3, at: [25, 36] },
};

/* Fetch data files that may not exist yet; a missing file becomes null instead of failing the page. */
function loadOptional(L, names) {
  return Promise.all(names.map(n => fetch(`data/${n}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null)
    .then(v => { L[n] = v; })));
}

function attachPeriods(L, pid, rows) {
  const by = L.periods && L.periods.games ? L.periods.games[pid] : null;
  for (const r of rows) r.per = by ? by[r.gid] : undefined;
  return rows;
}

/* Zone numbers for one player or team-defense season row: [{zone, att, made, pct, perGame, ptsPerGame, rank}]. */
function zoneRows(row, league) {
  if (!row) return null;
  const zones = Object.keys(ZONE_INFO), games = row[12] || 0;
  return zones.map((z, k) => {
    const att = row[2 * k], made = row[2 * k + 1];
    const la = league ? league[2 * k] : 0, lm = league ? league[2 * k + 1] : 0;
    return {
      zone: z, att, made, games, pct: att ? made / att : null, lgPct: la ? lm / la : null,
      perGame: games ? att / games : 0, ptsPerGame: games ? made * ZONE_INFO[z].value / games : 0,
      rank: row.length > 13 ? row[13 + k] : null,
    };
  });
}

/* Fill color for a zone: FG% against the league in that zone (green = better, red = worse). */
function zoneColor(z) {
  if (z.pct == null || z.att < 3) return 'rgba(255,255,255,.04)';
  const d = z.pct - (z.lgPct || 0);
  const a = Math.min(0.75, 0.25 + z.perGame / 8);
  if (d > 0.03) return `rgba(42,211,139,${a})`;
  if (d < -0.03) return `rgba(255,92,108,${a})`;
  return `rgba(242,193,78,${a})`;
}

/* Half-court SVG (feet; baseline at the top, hoop at (25, 5.25)) with each zone shaded and tappable. */
function courtSVG(zones, selected) {
  const by = Object.fromEntries(zones.map(z => [z.zone, z]));
  const sel = z => (z === selected ? ' stroke="#fff" stroke-width=".5"' : ' stroke="rgba(255,255,255,.25)" stroke-width=".15"');
  const label = z => {
    const d = by[z], [x, y] = ZONE_INFO[z].at;
    if (!d || !d.att) return '';
    const corner = z === 'lc3' || z === 'rc3';
    const txt = `${Math.round((d.pct || 0) * 100)}%`;
    return corner
      ? `<text x="${x}" y="${y}" font-size="1.7" text-anchor="middle" transform="rotate(-90 ${x} ${y})">${txt}</text>`
      : `<text x="${x}" y="${y}" font-size="2.2" text-anchor="middle" font-weight="700">${txt}</text>
         <text x="${x}" y="${y + 2.3}" font-size="1.5" text-anchor="middle" opacity=".8">${fmt1(d.perGame)}/g</text>`;
  };
  return `<svg class="court" viewBox="0 0 50 41" role="img" aria-label="Shot zones">
    <rect data-zone="atb3" x="0" y="0" width="50" height="41" fill="${zoneColor(by.atb3)}"${sel('atb3')}/>
    <rect data-zone="lc3" x="0" y="0" width="3" height="14" fill="${zoneColor(by.lc3)}"${sel('lc3')}/>
    <rect data-zone="rc3" x="47" y="0" width="3" height="14" fill="${zoneColor(by.rc3)}"${sel('rc3')}/>
    <path data-zone="mid" d="M3 0 V14 A23.75 23.75 0 0 0 47 14 V0 Z" fill="${zoneColor(by.mid)}"${sel('mid')}/>
    <rect data-zone="paint" x="17" y="0" width="16" height="19" fill="${zoneColor(by.paint)}"${sel('paint')}/>
    <circle data-zone="ra" cx="25" cy="5.25" r="4" fill="${zoneColor(by.ra)}"${sel('ra')}/>
    <g fill="none" stroke="rgba(255,255,255,.35)" stroke-width=".2" pointer-events="none">
      <circle cx="25" cy="5.25" r=".75"/><line x1="22" y1="4" x2="28" y2="4"/><circle cx="25" cy="19" r="6"/>
    </g>
    <g fill="#fff" pointer-events="none">${Object.keys(ZONE_INFO).map(label).join('')}</g></svg>`;
}

/* Player page shot chart card. state: {season, zone}. opp: tonight's opponent (or null). */
function shotCard(L, pid, opp, state) {
  const S = L.shots;
  if (!S || !S.players) return '';
  const mine = S.players[pid] || {};
  const seasons = [L.meta.season, L.meta.season - 1].filter(s => mine[s]);
  if (!seasons.length) return `<h2>Shot chart</h2><p class="muted">No shot locations on record yet.</p>`;
  if (!seasons.includes(state.season)) state.season = (mine[L.meta.season] && mine[L.meta.season][12] >= 5) ? L.meta.season : seasons[seasons.length - 1];
  const season = state.season;
  const zones = zoneRows(mine[season], S.league[season]);
  if (!state.zone) state.zone = zones.slice().sort((a, b) => b.att - a.att)[0].zone;
  const z = zones.find(x => x.zone === state.zone);
  const defRow = opp && S.def[opp] ? S.def[opp][season] : null;
  const dz = defRow ? zoneRows(defRow, S.league[season]).find(x => x.zone === state.zone) : null;
  const yy = s => `${s - 1}-${String(s).slice(2)}`;
  const pctDot = (p, lg) => p == null ? '' : `<i class="dot" style="background:${zoneColor({ pct: p, lgPct: lg, att: 9, perGame: 8 })}"></i>`;
  const defSide = dz && dz.games ? `
    <div><div class="muted">${esc(opp)} rank by pts allowed</div>
      <div class="big">${rankChip(dz.rank)} <small>of 30</small></div>
      <div class="kv"><span>Pts allowed / game</span><b>${fmt1(dz.ptsPerGame)}</b></div>
      <div class="kv"><span>Opp FG%</span><b>${pctDot(dz.pct, dz.lgPct)}${pct(dz.pct)}</b></div>
      <small class="muted">${dz.made} / ${dz.att} allowed · ${dz.games} games</small></div>`
    : `<div class="muted">${opp ? `No ${esc(opp)} defense data for ${yy(season)}.` : 'No upcoming opponent.'}</div>`;
  return `<div class="row"><h2 class="grow">Shot chart</h2><div class="pills">${seasons.map(s =>
      `<button class="pill ${s === season ? 'on' : ''}" data-shotseason="${s}">${yy(s)}</button>`).join('')}</div></div>
    <div class="shotwrap">${courtSVG(zones, state.zone)}</div>
    <p class="note" style="margin-top:4px">Color: FG% vs league average in that zone (green better, red worse); stronger color = more shots. Tap a zone.</p>
    <div class="zonecard">
      <h3 style="text-align:center;margin-bottom:8px">${esc(ZONE_INFO[z.zone].label)}</h3>
      <div class="zgrid">
        <div><div class="muted">Points / game</div><div class="big">${fmt1(z.ptsPerGame)}</div>
          <div class="kv"><span>Attempts / game</span><b>${fmt1(z.perGame)}</b></div>
          <div class="kv"><span>FG%</span><b>${pctDot(z.pct, z.lgPct)}${pct(z.pct)}</b></div>
          <small class="muted">${z.made} / ${z.att} · league ${pct(z.lgPct)}</small></div>
        ${defSide}
      </div></div>`;
}

function rankChip(rank) {
  if (rank == null) return '-';
  const cls = rank <= 10 ? 'hit' : rank >= 21 ? 'miss' : 'mid';
  return `<span class="zrank ${cls}">#${rank}</span>`;
}

/* Box score tab: win probability line (home team on top) and the season series line. */
async function winProbCard(L, g) {
  const el = document.getElementById('wpcard');
  if (!el) return;
  const d = await fetch(`data/wp/${g.id}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!d || !d.wp || d.wp.length < 2) { el.remove(); return; }
  const end = Math.max(2880, d.wp[d.wp.length - 1][0]);
  const W = 300, H = 110;
  const pts = d.wp.map(([t, p]) => `${(t / end * W).toFixed(1)},${((1 - p) * H).toFixed(1)}`).join(' ');
  const quarters = [720, 1440, 2160, 2880].filter(t => t < end).map(t => `<line x1="${t / end * W}" y1="0" x2="${t / end * W}" y2="${H}"/>`).join('');
  const H_ = L.teams[g.h] || {}, A_ = L.teams[g.a] || {};
  el.className = 'card';
  el.innerHTML = `<div class="row"><h3 class="grow">Win probability</h3>${d.ss ? `<small class="muted">${esc(d.ss)}</small>` : ''}</div>
    <div class="wp"><span class="wpteam top">${esc(g.h)}</span><span class="wpteam bot">${esc(g.a)}</span>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Win probability chart">
      <g stroke="rgba(255,255,255,.12)" stroke-width="1">${quarters}<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke-dasharray="4 4"/></g>
      <polyline points="${pts}" fill="none" stroke="${H_.color || '#ff8a3d'}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    </svg></div>
    <p class="note">Chance the ${esc(H_.name || g.h)} win (top = ${esc(g.h)}, bottom = ${esc(A_.name || g.a)}), from ESPN. Lines mark the quarters.</p>`;
}

/* Team page: who scores the first basket (first made field goal) and how often this team does. */
function firstBasketCard(L, team, season) {
  const games = (L.teamGames[team] || []).filter(g => g.fb && g.s === season && g.st === 2);
  if (!games.length) return '';
  const ours = games.filter(g => g.fb[1] === team);
  const by = {};
  for (const g of ours) by[g.fb[0]] = (by[g.fb[0]] || 0) + 1;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return `<div class="card"><h3>First basket</h3>
    <p style="margin:0 0 8px"><b>${ours.length} of ${games.length}</b> games (${pct(ours.length / games.length)}) the ${esc((L.teams[team] || {}).name || team)} scored first.</p>
    <table class="data">${top.map(([pid, n]) => `<tr><td class="l"><a href="player.html?id=${pid}">${esc(((L.players || {})[pid] || {}).n || pid)}</a></td><td><b>${n}</b></td><td>${pct(n / games.length)} of games</td></tr>`).join('')}</table>
    <p class="note">First made field goal of the game (how most books settle first basket). Regular season.</p></div>`;
}

if (typeof module !== 'undefined') {
  module.exports = { PERIOD_STATS, ZONE_INFO, zoneRows, zoneColor, attachPeriods };
}
