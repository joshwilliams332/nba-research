#!/usr/bin/env node
/* Hoop Lab daily picks digest: the model's best bets locked before tip-off, and a graded results recap the morning
   after, delivered to me as two automated emails a day. It's how the projection model gets tracked against real
   sportsbook lines in the open: every pick is timestamped before the game and graded from box scores, never edited.

   Runs in the data workflow after scripts/build_data.py (and the backtest), writing to the store, which is saved on the
   `data` branch. A scheduled task then emails the digest (see .claude/agents/pick-digest.md). Nothing is posted
   anywhere automatically.

   store/digest/YYYY-MM-DD.json         picks, locked once before tip-off (never rewritten, so the record is honest)
   store/digest/YYYY-MM-DD.png          a summary card image of the picks
   store/digest/YYYY-MM-DD-check.json   heads-up notes when injury news or prices change after the lock
   store/digest/YYYY-MM-DD-recap.json   graded results + season record, written once every pick's game is final
   store/digest/YYYY-MM-DD-recap.png    the recap card image
   store/digest/status.json             what the last run did (for the email task)

   Picks lock on the first run at 10 AM ET or later (the morning run that pulls the day's props, so the email goes out
   while the prices are still fresh), or once the first tip is within 3 hours. Later runs only write heads-up notes.

   Usage: node scripts/digest.js [--store store] [--data site/data] [--now ISO] [--force-lock] */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
Object.assign(globalThis, require('../site/assets/common.js'), require('../site/assets/context.js'));
const M = require('../site/assets/model.js');
const P = require('../site/assets/picks.js');

const RAW = 'https://raw.githubusercontent.com/joshwilliams332/nba-research/data/digest';
const SITE = 'https://joshwilliams332.github.io/nba-research';
const PICK = {
  max: 5,            // picks per night
  perGame: 2,        // at most this many from one game
  // The chance used for a pick blends the model with the market (the books' no-vig consensus): books price in news the
  // model can't see (a starter ruled out, a new role), so a pick needs the model to lean past a fair market, not to
  // shout over it. When they're far apart, the model is probably missing something and the prop is skipped.
  modelWeight: 0.3,  // share of the model in the blended chance
  maxGap: 0.2,       // skip when model and market chances differ by more than this
  minProb: 0.54,     // blended chance of the side
  minEdge: 0.03,     // blended chance x payout - 1 at the posted price
  minGames: 10,      // games of history for the player
  priceRange: [-200, 180],
  stats: ['pts', 'reb', 'ast', 'fg3m'],
};
const LOCK_HOUR = 10;          // ET: the morning props pull happens on the first run after 10:00 ET
// The public record starts here. Oct 28 locked by accident when the feature was merged mid-slate and was never
// posted, so it's kept on the data branch but not counted in "Season:".
const RECORD_START = '2026-10-29';
// Picks withdrawn before they were posted and before tip-off. The locked file keeps them (the data branch history
// shows they existed); they're left out of the post, recap and record. Only ever add a pick here before its game
// starts and before it has been posted anywhere.
const WITHDRAWN = {
  // Oct 29, 6:30 PM ET, before posting and before the 10 PM tip: Robert Williams (doubtful) changes Clingan's role;
  // the under went 0 of 10 in Clingan's last 10 without him. The new teammate rule would have skipped it.
  '401909895-5105565-reb': 'teammate news (Robert Williams doubtful)',
};
const counted = picks => (picks || []).filter(p => !WITHDRAWN[p.id]);
const POS_WORD = { G: 'guards', F: 'forwards', C: 'centers', ALL: 'all players' };
const LOCK_BEFORE_TIP_MIN = 180;

// ---------------------------------------------------------------- helpers

const etParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
  .formatToParts(d).map(p => [p.type, p.value]));
const etDate = d => { const p = etParts(d); return `${p.year}-${p.month}-${p.day}`; };
const etHour = d => +etParts(d).hour;
const dayLabel = iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const tipLabel = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(':00', '');
const ordinal = n => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const units = u => `${u >= 0 ? '+' : '-'}${Math.abs(u).toFixed(1)}u`;
const priceTxt = n => (n > 0 ? `+${n}` : `${n}`);
const read = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const htmlEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* X counts most emoji and symbols as 2 characters; close enough for keeping posts under 280. */
function postLength(text) {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0) > 0x2000 ? 2 : 1;
  return n;
}

function loadLab(dir) {
  const r = n => read(path.join(dir, `${n}.json`));
  const L = indexLab(r('meta'), r('teams'), r('games'));
  for (const n of ['players', 'logs', 'props', 'injuries', 'closelines']) L[n] = r(n) || (n === 'injuries' ? [] : {});
  return L;
}

const short = pick => `${pick.name} ${pick.side === 'o' ? 'O' : 'U'} ${pick.line} ${STATS[pick.stat].short}`;

// ---------------------------------------------------------------- choosing picks

/* Why a player can't be picked tonight: on the injury report at all (out, doubtful, questionable, day-to-day). */
function injured(L, pid) {
  return (L.injuries || []).some(i => i.id === pid && /^(out|doubt|quest|day)/i.test(i.st || ''));
}

// Teammates' news. A rotation teammate (ROTATION_MIN+ minutes over his last 10 games for the team) whose status is
// uncertain makes tonight's role a coin flip, so the pick is skipped. If he's out, the player's games without him
// (MATE_MIN_GAMES+) must not go against the pick: e.g. Clingan's rebound under hit 8 of 10 overall but 0 of 10
// without Robert Williams.
const ROTATION_MIN = 15;
const MATE_MIN_GAMES = 5;
const UNSURE = /^(doubt|quest|day|game)/i;

function keyMates(L, pid, team) {
  return (L.injuries || []).filter(i => i.id && i.id !== pid && i.t === team && L.players[i.id]).map(i => {
    const rows = playerRows(L, i.id).filter(r => r.team === team && r.g.s >= L.meta.season - 1).slice(-10);
    return { id: i.id, n: L.players[i.id].n, st: injuryStatus(i), min: mean(rows.map(r => r.min)) || 0, games: rows.length };
  }).filter(m => m.min >= ROTATION_MIN && m.games >= 3);
}

/* Why a side shouldn't be picked because of a teammate, or null. */
function mateProblem(L, pid, stat, line, side, rows, mates) {
  const unsure = mates.find(m => UNSURE.test(m.st));
  if (unsure) return `${unsure.n} is ${unsure.st.toLowerCase()}`;
  for (const m of mates.filter(x => /^out/i.test(x.st))) {
    const without = teammateBoost(L, pid, m.id, stat, rows).withoutRows;
    if (without.length < MATE_MIN_GAMES) continue;
    const hits = without.filter(r => outcome(STATS[stat].f(r), line, side) === 'hit').length;
    if (hits / without.length < 0.5) return `${side === 'o' ? 'over' : 'under'} hit ${hits} of ${without.length} without ${m.n}`;
  }
  return null;
}

/* Every side of every prop for games that haven't started, with the model's chance and edge at the posted price. */
function candidates(L, day, skipped = []) {
  const out = [];
  for (const [gid, props] of Object.entries((L.props || {}).games || {})) {
    const g = L.byId.get(gid);
    if (!g || g.d !== day || g.state !== 'pre') continue;
    for (const pr of props) {
      const p = L.players[pr.id];
      if (!p || !PICK.stats.includes(pr.s) || injured(L, pr.id)) continue;
      const rows = playerRows(L, pr.id).filter(r => r.g.t < g.t);
      if (rows.length < PICK.minGames) continue;
      const proj = M.project(L, pr.id, pr.s, g, { rows });
      if (!proj) continue;
      const opp = p.t === g.h ? g.a : g.h;
      const mates = keyMates(L, pr.id, p.t);
      const fair = fairPrice(pr);  // consensus no-vig chance of the over across books at this line
      if (!fair) continue;
      for (const side of ['o', 'u']) {
        const price = side === 'o' ? pr.o : pr.u;
        if (price == null || price < PICK.priceRange[0] || price > PICK.priceRange[1]) continue;
        const model = side === 'o' ? proj.over(pr.l) : proj.under(pr.l);
        const market = side === 'o' ? fair.fairO : fair.fairU;
        if (Math.abs(model - market) > PICK.maxGap) continue;
        const prob = PICK.modelWeight * model + (1 - PICK.modelWeight) * market;
        const edge = prob * decimalOdds(price) - 1;
        if (prob >= PICK.minProb && edge >= PICK.minEdge) {
          const why = mateProblem(L, pr.id, pr.s, pr.l, side, rows, mates);
          if (why) { skipped.push(`${p.n} ${side === 'o' ? 'O' : 'U'} ${pr.l} ${STATS[pr.s].short}: ${why}`); continue; }
        }
        const l10 = rows.slice(-10).map(r => outcome(STATS[pr.s].f(r), pr.l, side));
        out.push({ g, pr, p, opp, side, price, prob, model, market, edge, proj, l10, mates, rank: oppRank(L, opp, posBucket(p.p), pr.s) });
      }
    }
  }
  return out;
}

/* The night's best bets: biggest edge first, one side per player, at most PICK.perGame per game. */
function choosePicks(cands) {
  const chosen = [], players = new Set(), perGame = {};
  for (const c of cands.filter(x => x.prob >= PICK.minProb && x.edge >= PICK.minEdge).sort((a, b) => b.edge - a.edge)) {
    if (chosen.length >= PICK.max || players.has(c.pr.id) || (perGame[c.g.id] || 0) >= PICK.perGame) continue;
    chosen.push(c);
    players.add(c.pr.id);
    perGame[c.g.id] = (perGame[c.g.id] || 0) + 1;
  }
  return chosen;
}

/* One sentence of "why" for a pick: projection, recent form at this line and the matchup. */
function whyLine(L, c) {
  const st = STATS[c.pr.s], hits = c.l10.filter(r => r === 'hit').length;
  const parts = [`projected ${c.proj.mean.toFixed(1)} vs the ${c.pr.l} line`,
    `${c.side === 'o' ? 'cleared' : 'stayed under'} ${c.pr.l} in ${hits} of his last ${c.l10.length}`];
  if (c.rank && c.rank.rank != null) {
    const who = POS_WORD[posBucket(c.p.p) || 'ALL'];
    if (c.side === 'o' && c.rank.rank <= 10) parts.push(`${c.opp} allows the ${c.rank.rank === 1 ? '' : `${ordinal(c.rank.rank)} `}most ${st.label.toLowerCase()} to ${who}`);
    if (c.side === 'u' && c.rank.rank > c.rank.of - 10) parts.push(`${c.opp} allows the ${c.rank.of - c.rank.rank + 1 === 1 ? '' : `${ordinal(c.rank.of - c.rank.rank + 1)} `}fewest ${st.label.toLowerCase()} to ${who}`);
  }
  return `${parts[0][0].toUpperCase()}${parts.join(', ').slice(1)}.`;
}

/* Saved form of a pick: the picks tracker's fields (so gradePick works), plus what the card shows. */
function toPick(L, c) {
  return {
    ...P.makePick({ gid: c.g.id, pid: c.pr.id, name: c.p.n, stat: c.pr.s, side: c.side, line: c.pr.l, price: c.price, book: c.pr.bk }),
    id: `${c.g.id}-${c.pr.id}-${c.pr.s}`, savedAt: undefined,
    team: c.p.t, opp: c.opp, home: c.p.t === c.g.h, tip: c.g.t,
    proj: Math.round(c.proj.mean * 10) / 10, prob: Math.round(c.prob * 1000) / 1000,
    model: Math.round(c.model * 1000) / 1000, market: Math.round(c.market * 1000) / 1000, edge: Math.round(c.edge * 1000) / 1000,
    l10: c.l10, oppRank: c.rank && c.rank.rank != null ? { rank: c.rank.rank, of: c.rank.of } : null, why: whyLine(L, c),
    mates: Object.fromEntries((c.mates || []).map(m => [m.id, m.st])),  // rotation teammates' status at lock
  };
}

// ---------------------------------------------------------------- record

/* Every graded pick in the store before `day` (exclusive) plus that day's: {w, l, p, v, profit}. */
function seasonRecord(L, dir, through, season) {
  const graded = [];
  for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
    const day = f.slice(0, 10);
    if (day > through || day < RECORD_START) continue;
    const doc = read(path.join(dir, f));
    for (const pick of counted(doc.picks)) {
      const g = L.byId.get(pick.gid);
      if (!g || g.s !== season) continue;
      graded.push({ pick, grade: P.gradePick(L, pick) });
    }
  }
  return P.summarize(graded);
}

/* The opponent's defense vs his position, from the bet's side: an over against a top-10 most-generous defense is
   favorable, an under against a top-10 stingiest one too (the Props page's Favorable / Unfavorable filter). */
function matchup(p) {
  if (!p.oppRank) return 'neutral';
  const { rank, of } = p.oppRank, soft = rank <= 10, tough = rank > of - 10;
  if (p.side === 'o') return soft ? 'favorable' : tough ? 'unfavorable' : 'neutral';
  return tough ? 'favorable' : soft ? 'unfavorable' : 'neutral';
}

const recordTxt = s => `${s.w}-${s.l}${s.p ? `-${s.p}` : ''} (${units(s.profit)})`;

// ---------------------------------------------------------------- post text

function slatePost(day, nGames, picks, season) {
  const head = `🏀 Hoop Lab best bets · ${dayLabel(day).replace(',', '')}`;
  if (!picks.length) {
    return { main: `${head}\n\n${nGames}-game slate and the model doesn't love anything at tonight's prices. No plays is a play.${season && season.w + season.l ? `\n\nSeason: ${recordTxt(season)}` : ''}`, replies: [] };
  }
  const build = withPrices => [
    head, '',
    `${nGames} game${nGames === 1 ? '' : 's'} tonight. Our top ${picks.length}:`, '',
    ...picks.map(p => `${short(p)}${withPrices ? ` (${priceTxt(p.price)})` : ''}`), '',
    season && season.w + season.l ? `Season: ${recordTxt(season)} · why 👇` : 'Graded tomorrow, wins and losses. Why 👇',
  ].join('\n');
  let main = build(true);
  if (postLength(main) > 280) main = build(false);
  const replies = picks.map(p => `${short(p)}: ${p.why}`.slice(0, 280));
  return { main, replies };
}

function recapPost(day, rows, s, season) {
  const mark = st => (st === 'win' ? '✅' : st === 'loss' ? '❌' : '➖');
  const n = s.w + s.l;
  const opener = !n ? `No graded picks from ${dayLabel(day)} (every pick was voided).`
    : s.profit > 0 && s.w >= s.l ? `✅ ${s.w}-${s.l} last night (${units(s.profit)}).`
    : s.w === s.l ? `${s.w}-${s.l} last night (${units(s.profit)}). Even night.`
    : `❌ ${s.w}-${s.l} last night (${units(s.profit)}). Rough one. We'll bounce back.`;
  const lines = rows.map(r => `${mark(r.grade.status)} ${short(r.pick)}${r.grade.status === 'void' ? ' (DNP, void)' : r.grade.actual != null ? ` (${r.grade.actual})` : ''}`);
  const tail = [`Season: ${recordTxt(season)}`, 'Every pick posted before tip, wins and losses.'];
  let main = [opener, '', ...lines, '', ...tail].join('\n');
  if (postLength(main) > 280) main = [opener, '', ...lines, '', tail[0]].join('\n');
  return { main, replies: [] };
}

// ---------------------------------------------------------------- cards (HTML -> PNG with headless Chrome)

const CARD_CSS = `*{box-sizing:border-box;margin:0}body{width:1080px;background:#0b0d10;color:#f1f3f6;font-family:"Inter","Segoe UI",Roboto,"DejaVu Sans",Arial,sans-serif;padding:56px 60px}
.top{display:flex;align-items:center;gap:16px}.brand{font-size:34px;font-weight:800;letter-spacing:-.5px}.when{margin-left:auto;font-size:26px;color:#8d95a3;font-weight:600}
h1{font-size:60px;font-weight:850;letter-spacing:-1px;margin:34px 0 6px}.sub{font-size:26px;color:#8d95a3;margin-bottom:30px}
.pick{background:#15181d;border:1px solid #272c35;border-radius:24px;padding:26px 30px;margin-bottom:18px}
.row{display:flex;align-items:baseline;gap:14px}.name{font-size:34px;font-weight:800}.meta{font-size:22px;color:#8d95a3}
.bet{font-size:40px;font-weight:850;color:#ff8a3d;margin:10px 0 12px}.bet small{font-size:26px;color:#8d95a3;font-weight:700;margin-left:10px}
.facts{display:flex;gap:12px;flex-wrap:wrap}.fact{background:#1d2128;border-radius:12px;padding:8px 14px;font-size:22px;color:#c9ced6}.fact b{color:#f1f3f6}
.strip{display:flex;gap:6px;margin-top:14px}.strip i{flex:1;height:10px;border-radius:5px;background:#6d7684}.strip i.hit{background:#2ad38b}.strip i.miss{background:#ff5c6c}
.favorable{color:#2ad38b}.unfavorable{color:#ff5c6c}.res{margin-left:auto;font-size:30px;font-weight:850}.win{color:#2ad38b}.loss{color:#ff5c6c}.push,.void{color:#8d95a3}
.big{font-size:96px;font-weight:900;letter-spacing:-2px}.foot{margin-top:28px;font-size:19px;color:#5d6573;line-height:1.5}`;
const LOGO = `<svg width="54" height="54" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#ff8a3d"/><path d="M3 16h26M16 3v26M7 7c5 4 5 14 0 18M25 7c-5 4-5 14 0 18" stroke="#1a0f05" stroke-width="1.6" fill="none"/></svg>`;
const FOOT = `Model picks for entertainment, not advice. Every pick is logged before tip-off and graded from box scores. 21+ · Gamble responsibly · 1-800-GAMBLER`;

function slateCard(day, nGames, picks) {
  const body = picks.length ? picks.map(p => `<div class="pick">
      <div class="row"><span class="name">${htmlEsc(p.name)}</span><span class="meta">${htmlEsc(p.team)} ${p.home ? 'vs' : '@'} ${htmlEsc(p.opp)} · ${tipLabel(p.tip)}</span></div>
      <div class="bet">${p.side === 'o' ? 'OVER' : 'UNDER'} ${p.line} ${htmlEsc(STATS[p.stat].label.toUpperCase())}<small>${priceTxt(p.price)}</small></div>
      <div class="facts"><span class="fact">Projection <b>${p.proj}</b></span><span class="fact">Our chance <b>${Math.round(p.prob * 100)}%</b></span>
        <span class="fact">L10 <b>${p.l10.filter(r => r === 'hit').length}/${p.l10.length}</b></span>${p.oppRank ? `<span class="fact">Matchup <b class="${matchup(p)}">${matchup(p)}</b></span>` : ''}</div>
      <div class="strip">${p.l10.map(r => `<i class="${r}"></i>`).join('')}</div></div>`).join('')
    : `<div class="pick"><div class="name">No plays tonight</div><div class="meta" style="margin-top:8px">Nothing cleared the model's bar at tonight's prices.</div></div>`;
  return `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style><body>
    <div class="top">${LOGO}<span class="brand">Hoop Lab</span><span class="when">${dayLabel(day)}</span></div>
    <h1>Best bets</h1><div class="sub">${nGames}-game slate · projection model picks · L10 strip vs tonight's line</div>
    ${body}<div class="foot">${FOOT}</div></body>`;
}

function recapCard(day, rows, s, season) {
  return `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style><body>
    <div class="top">${LOGO}<span class="brand">Hoop Lab</span><span class="when">${dayLabel(day)}</span></div>
    <h1 style="margin-bottom:0">Results</h1>
    <div class="row" style="margin:6px 0 30px"><span class="big ${s.profit >= 0 ? 'win' : 'loss'}">${s.w}-${s.l}${s.p ? `-${s.p}` : ''}</span>
      <span style="font-size:40px;font-weight:800;color:#8d95a3">${units(s.profit)}</span></div>
    ${rows.map(r => `<div class="pick"><div class="row"><span class="name">${htmlEsc(r.pick.name)}</span>
      <span class="res ${r.grade.status}">${r.grade.status === 'void' ? 'VOID' : r.grade.status.toUpperCase()}</span></div>
      <div class="bet" style="margin-bottom:0">${r.pick.side === 'o' ? 'OVER' : 'UNDER'} ${r.pick.line} ${htmlEsc(STATS[r.pick.stat].short)}<small>${priceTxt(r.pick.price)} · ${r.grade.status === 'void' ? "didn't play" : `finished with ${r.grade.actual}`}</small></div></div>`).join('')}
    <div class="sub" style="margin-top:22px">Season: <b style="color:#f1f3f6">${recordTxt(season)}</b></div>
    <div class="foot">${FOOT}</div></body>`;
}

/* Headless Chrome (GitHub's runners ship google-chrome; set CHROME to use another). Returns false without one. */
function chromePath() {
  const cands = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  return cands.find(p => fs.existsSync(p)) || null;
}

function renderPng(html, out, height) {
  const chrome = chromePath();
  const src = out.replace(/\.png$/, '.html');
  fs.writeFileSync(src, html);
  if (!chrome) { console.log(`  no Chrome found, kept ${path.basename(src)} only`); return false; }
  execFileSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=1080,${height}`, `--screenshot=${out}`, `file://${path.resolve(src)}`], { stdio: 'ignore', timeout: 60000 });
  fs.unlinkSync(src);
  return fs.existsSync(out);
}

const cardHeight = n => Math.max(900, 330 + 250 * Math.max(1, n) + 130);   // slate card: ~250px per pick
const recapHeight = n => Math.max(900, 470 + 172 * n + 150);                // recap card: ~172px per pick

// ---------------------------------------------------------------- email (sent by the scheduled task)

function emailHTML(title, post, imgUrl, notes) {
  const box = t => `<pre style="white-space:pre-wrap;font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;border:1px solid #dde0e5;border-radius:10px;padding:12px 14px;margin:0 0 12px">${htmlEsc(t)}</pre>`;
  return `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:620px">
    <h2 style="margin:0 0 4px">${htmlEsc(title)}</h2>
    <p style="color:#555;margin:0 0 16px">Copy, paste, post. Long-press a box to copy it.</p>
    <h3 style="margin:0 0 6px">Post</h3>${box(post.main)}
    ${imgUrl ? `<p style="margin:0 0 16px"><a href="${imgUrl}" style="color:#e2600a;font-weight:700">Open the card image</a> (save it and attach it to the post)</p>` : ''}
    ${post.replies.length ? `<h3 style="margin:0 0 6px">Thread replies</h3>${post.replies.map(box).join('')}` : ''}
    ${notes.length ? `<h3 style="margin:16px 0 6px">For you, not for posting</h3><ul style="color:#444;padding-left:18px;margin:0">${notes.map(n => `<li>${htmlEsc(n)}</li>`).join('')}</ul>` : ''}
    <p style="color:#888;font-size:13px;margin-top:18px">From Hoop Lab's data job. <a href="${SITE}/model.html">How the model works</a> · <a href="${SITE}/props.html">Tonight's props</a></p></div>`;
}

function emailText(post, imgUrl, notes) {
  return [post.main, '', ...(imgUrl ? [`Card image: ${imgUrl}`, ''] : []), ...post.replies.flatMap(r => [r, '']), ...notes.map(n => `Note: ${n}`)].join('\n');
}

// ---------------------------------------------------------------- lock and recap

function lockPicks(L, dir, now, force) {
  const day = L.meta.today;
  const file = path.join(dir, `${day}.json`);
  const today = L.games.filter(g => g.d === day);
  const pre = today.filter(g => g.state === 'pre').sort((a, b) => (a.t < b.t ? -1 : 1));
  if (fs.existsSync(file)) return { day, state: 'locked', why: 'already locked' };
  if (!today.length) return { day, state: 'no-games', why: 'no games today' };
  if (!pre.length) return { day, state: 'missed', why: 'every game had started before picks locked' };
  const minsToTip = (Date.parse(pre[0].t) - now) / 60000;
  if (!force && etHour(new Date(now)) < LOCK_HOUR && minsToTip > LOCK_BEFORE_TIP_MIN) return { day, state: 'waiting', why: `locks at ${LOCK_HOUR}:00 ET or 3 hours before the first tip` };
  const hasProps = Object.keys((L.props || {}).games || {}).some(gid => (L.byId.get(gid) || {}).d === day);
  if (!hasProps) return { day, state: 'no-props', why: 'no sportsbook props pulled today' };

  const skipped = [];
  const cands = candidates(L, day, skipped);
  const picks = choosePicks(cands).map(c => toPick(L, c));
  const season = seasonRecord(L, dir, day, L.meta.season);
  const post = slatePost(day, today.length, picks, season);
  const png = renderPng(slateCard(day, today.length, picks), path.join(dir, `${day}.png`), cardHeight(picks.length));
  const img = png ? `${RAW}/${day}.png` : null;
  const clock = t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const pulled = (L.props || {}).fetched;
  const notes = [
    `Locked ${clock(now)} ET from ${cands.length} prop sides. Prices are from the ${pulled ? `${clock(pulled)} ET ` : ''}sportsbook pull and lines move, so check your book before posting; if the price got much worse, skip or say so.`,
    ...(skipped.length ? [`Skipped because of a teammate's news: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? ` (+${skipped.length - 4} more)` : ''}.`] : []),
    'Our chance = 30% model + 70% the books\' no-vig price, so a pick needs the model to lean past a fair market. Props where the two disagree by 20+ points were skipped (usually news the model can\'t see).',
    'Players on the injury report (even questionable) were skipped, and so were players whose rotation teammate is questionable/doubtful. If someone is ruled out after this, the pick is graded as a void.',
    'The model is backtested against typical lines, not yet against real sportsbook lines. This public record is the real test.',
  ];
  const title = picks.length ? `Tonight's post · ${dayLabel(day)} · ${picks.length} pick${picks.length === 1 ? '' : 's'}` : `Tonight's post · ${dayLabel(day)} · no plays`;
  write(file, { date: day, lockedAt: new Date(now).toISOString(), games: today.length, settings: PICK, picks, post, image: img,
    email: { subject: `🏀 ${title}`, html: emailHTML(title, post, img, notes), text: emailText(post, img, notes) } });
  return { day, state: 'locked', why: `${picks.length} picks locked`, new: true };
}

/* After the lock and before the picks tip: has news changed? A pick's player or a rotation teammate whose injury
   status moved since the lock, or a pre-tip close line that moved against the pick, goes into a "heads up" note.
   Writes YYYY-MM-DD-check.json (the locked picks file is never touched); the email task sends its email instead of
   the lock's when it exists. Removed again if the news goes back to how it was. */
function checkPicks(L, dir, now) {
  const day = L.meta.today;
  const doc = read(path.join(dir, `${day}.json`));
  const file = path.join(dir, `${day}-check.json`);
  if (!doc || !doc.picks || !doc.picks.length) return { state: 'none' };
  const live = doc.picks.filter(p => { const g = L.byId.get(p.gid); return g && g.state === 'pre'; });
  if (!live.length) return { state: 'started' };
  const status = id => { const i = (L.injuries || []).find(x => x.id === id); return i ? injuryStatus(i) : 'Active'; };
  const notes = [];
  for (const p of live) {
    const own = status(p.pid);
    if (own !== 'Active') notes.push(`${p.name} is now listed ${own.toLowerCase()} (pick stays on the record; it's a void if he sits).`);
    const before = p.mates || {};
    for (const m of keyMates(L, p.pid, p.team)) {
      if ((before[m.id] || 'Active') !== m.st) notes.push(`${m.n} (${p.team}) is now ${m.st.toLowerCase()}${before[m.id] ? ` (was ${before[m.id].toLowerCase()})` : ''}: this can change ${p.name}'s role.`);
    }
    for (const [id, was] of Object.entries(before)) {
      if (!(L.injuries || []).some(i => i.id === id)) notes.push(`${(L.players[id] || {}).n || id} is off the injury report (was ${was.toLowerCase()}): expect him to play.`);
    }
    const prop = (((L.props || {}).games || {})[p.gid] || []).find(x => x.id === p.pid && x.s === p.stat);
    const close = prop && prop.close;
    if (close && (close[0] !== p.line || (p.side === 'o' ? close[1] : close[2]) <= p.price - 15)) {
      const now_ = p.side === 'o' ? close[1] : close[2];
      notes.push(`${p.name} ${p.side === 'o' ? 'O' : 'U'} ${p.line}: the line is now ${close[0]} at ${now_ > 0 ? '+' : ''}${now_} (locked ${p.price > 0 ? '+' : ''}${p.price}).`);
    }
  }
  if (!notes.length) { if (fs.existsSync(file)) fs.unlinkSync(file); return { state: 'clear' }; }
  const box = `<div style="background:#fff4e5;border:1px solid #f5c58a;border-radius:8px;padding:10px 12px;margin:0 0 14px;font:14px -apple-system,Segoe UI,sans-serif;color:#7a4300"><b>Heads up before you post</b><ul style="margin:6px 0 0;padding-left:18px">${notes.map(n => `<li>${htmlEsc(n)}</li>`).join('')}</ul></div>`;
  write(file, { date: day, checked: new Date(now).toISOString(), notes,
    email: { subject: `${doc.email.subject} · heads up`, html: box + doc.email.html, text: `HEADS UP: ${notes.join(' ')}\n\n${doc.email.text}` } });
  return { state: 'heads-up', notes: notes.length };
}

/* Recap the latest locked day before today once all its games are final. Written once. */
function writeRecap(L, dir) {
  const days = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).filter(d => d < L.meta.today).sort();
  const day = days[days.length - 1];
  if (!day) return { state: 'none' };
  const file = path.join(dir, `${day}-recap.json`);
  if (fs.existsSync(file)) return { day, state: 'done' };
  const doc = read(path.join(dir, `${day}.json`));
  const picks = counted(doc.picks);
  if (!picks.length) return { day, state: 'no-picks' };
  const rows = picks.map(pick => ({ pick, grade: P.gradePick(L, pick) }));
  if (rows.some(r => r.grade.status === 'open' || r.grade.status === 'live')) return { day, state: 'pending' };
  const s = P.summarize(rows);
  const season = seasonRecord(L, dir, day, L.byId.get(picks[0].gid).s);
  const post = recapPost(day, rows, s, season);
  const png = renderPng(recapCard(day, rows, s, season), path.join(dir, `${day}-recap.png`), recapHeight(rows.length));
  const img = png ? `${RAW}/${day}-recap.png` : null;
  const notes = rows.filter(r => r.grade.clv != null).length
    ? [`Closing line value: ${rows.filter(r => r.grade.clv != null).map(r => `${short(r.pick)} ${r.grade.clv > 0 ? '+' : ''}${r.grade.clv}`).join(' · ')} (points vs the pre-tip line; positive = we beat the close).`] : [];
  const title = `Recap · ${dayLabel(day)} · ${s.w}-${s.l}${s.p ? `-${s.p}` : ''} (${units(s.profit)})`;
  write(file, { date: day, gradedAt: new Date().toISOString(), record: s, season, results: rows.map(r => ({ id: r.pick.id, status: r.grade.status, actual: r.grade.actual ?? null, profit: r.grade.profit, clv: r.grade.clv ?? null })),
    post, image: img, email: { subject: `🏀 ${title}`, html: emailHTML(title, post, img, notes), text: emailText(post, img, notes) } });
  return { day, state: 'done', new: true, record: recordTxt(s) };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const root = path.join(__dirname, '..');
  const store = path.resolve(arg('--store', path.join(root, 'store')));
  const dir = path.join(store, 'digest');
  // The folder used to be called social/; move its history over once so the record carries on.
  const old = path.join(store, 'social');
  if (fs.existsSync(old) && !fs.existsSync(dir)) fs.renameSync(old, dir);
  fs.mkdirSync(dir, { recursive: true });
  const L = loadLab(path.resolve(arg('--data', path.join(root, 'site', 'data'))));
  const now = Date.parse(arg('--now', new Date().toISOString()));
  const lock = lockPicks(L, dir, now, args.includes('--force-lock'));
  const check = checkPicks(L, dir, now);
  const recap = writeRecap(L, dir);
  write(path.join(dir, 'status.json'), { checked: new Date(now).toISOString(), today: L.meta.today, lock, check, recap });
  console.log(`Social: ${lock.day} ${lock.state} (${lock.why}); recap ${recap.day || '-'} ${recap.state}${recap.record ? ` ${recap.record}` : ''}`);
}

if (require.main === module) main();
module.exports = { PICK, RECORD_START, WITHDRAWN, keyMates, mateProblem, checkPicks, matchup, postLength, candidates, choosePicks, whyLine, toPick, slatePost, recapPost, lockPicks, writeRecap, seasonRecord, etDate, etHour };
