/* Hoop Lab trend finder: turns game logs and lines into short, Outlier-style sentences ("insights").
   Load after common.js. Every split is built from the same filters and windows as the player page
   (applyFilters + windowRates), so an insight's link reproduces its numbers exactly. */
'use strict';

// common.js helpers: globals in the browser, required in Node (tests).
const HL = typeof module !== 'undefined' ? require('./common.js')
  : { STATS, outcome, tally, mean, typicalLine, playerRows, applyFilters, windowRates, teamFinals, signed };

const INSIGHT_MIN_N = 5;        // smallest sample worth a sentence
const INSIGHT_MIN_RATE = 0.75;  // a side has to hit at least this often
const PER_MARKET = 2;           // insights kept per player stat / team market
const TYPICAL_STATS = ['pts', 'reb', 'ast', 'fg3m'];  // used when no sportsbook props exist at all

// How each stat reads in a sentence.
const NOUNS = {
  pts: 'points', reb: 'rebounds', ast: 'assists', fg3m: 'three pointers', pra: 'points + rebounds + assists',
  pr: 'points + rebounds', pa: 'points + assists', ra: 'rebounds + assists', stl: 'steals', blk: 'blocks',
  sb: 'steals + blocks', tov: 'turnovers', fga: 'field goal attempts', fg3a: 'three point attempts', fta: 'free throw attempts',
};

/* Lower bound of the Wilson score interval: ranks 9/10 above 5/5, so bigger samples win near-ties. */
function wilson(hits, n, z = 1.28) {
  if (!n) return 0;
  const p = hits / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

const pct1 = r => `${(r * 100).toFixed(1)}%`;
const fullName = (L, t) => `${L.teams[t].city} ${L.teams[t].name}`;
const record = t => `${t.hits}-${t.misses}${t.pushes ? `-${t.pushes}` : ''}`;
const nGames = n => `${n} game${n === 1 ? '' : 's'}`;
const flip = r => r === 'hit' ? 'miss' : r === 'miss' ? 'hit' : 'push';

/* Picks the side of a set of outcomes that clears the bar: {side: 'yes'|'no', results, ...tally} or null. */
function strongSide(results) {
  const yes = HL.tally(results);
  if (yes.n < INSIGHT_MIN_N) return null;
  if (yes.rate >= INSIGHT_MIN_RATE) return { side: 'yes', results, ...yes };
  const flipped = results.map(flip), no = HL.tally(flipped);
  if (no.rate >= INSIGHT_MIN_RATE) return { side: 'no', results: flipped, ...no };
  return null;
}

/* Best few per group key, ranked by strength; `family` keeps L5 / L10 / L20 from crowding out situational splits. */
function keepBest(list) {
  const groups = new Map();
  for (const x of list) {
    const k = x.group;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const out = [];
  for (const items of groups.values()) {
    items.sort((a, b) => b.strength - a.strength || b.n - a.n);
    const families = new Set();
    for (const x of items) {
      if (families.has(x.family)) continue;
      families.add(x.family);
      out.push(x);
      if (families.size >= PER_MARKET) break;
    }
  }
  return out.sort((a, b) => b.strength - a.strength || b.n - a.n);
}

// ---------------------------------------------------------------- players

/* The player splits that apply to today's game. Each is a filter set + window, like the player page. */
function playerSplits(L, ctx) {
  const s = [
    { key: 'l5', family: 'recent', f: {}, win: 'l5', ctx: '' },
    { key: 'l10', family: 'recent', f: {}, win: 'l10', ctx: '' },
    { key: 'l20', family: 'recent', f: {}, win: 'l20', ctx: '' },
    { key: 'loc', family: 'loc', f: { loc: ctx.home ? 'home' : 'away' }, win: 'l10', ctx: ctx.home ? ' at home' : ' on the road' },
    { key: 'h2h', family: 'h2h', f: {}, win: 'h2h', ctx: ` against the ${L.teams[ctx.opp].name}` },
  ];
  if (ctx.rest === 0) s.push({ key: 'b2b', family: 'rest', f: { rest: '0' }, win: 'l10', ctx: ' on the second night of a back-to-back' });
  if (ctx.rest >= 2 && ctx.rest < 9) s.push({ key: 'rest', family: 'rest', f: { rest: '2' }, win: 'l10', ctx: ' with 2+ days of rest' });
  for (const m of ctx.outMates || []) {
    s.push({ key: `without-${m.id}`, family: `without-${m.id}`, f: { without: [m.id] }, win: 'l10', ctx: ` without ${m.n}`, mate: m });
  }
  if (ctx.starterSwing) s.push({ key: 'starter', family: 'role', f: { role: 'starter' }, win: 'l10', ctx: ' as a starter' });
  return s;
}

function playerSentence(name, stat, line, t, split, avg) {
  const verb = t.side === 'o' ? 'exceeded' : 'failed to exceed';
  const count = t.hits === t.n ? `in each of his last ${nGames(t.n)}` : `in ${t.hits} of his last ${nGames(t.n)}`;
  return `${name} has ${verb} ${line} ${NOUNS[stat]} ${count}${split.ctx} (${avg.toFixed(1)} ${NOUNS[stat]}/game average).`;
}

/* Insights for one player and one line. rows: the player's games before tip-off (oldest first). */
function playerInsights(L, p, rows, prop, ctx) {
  const stat = prop.s, line = prop.l, f = HL.STATS[stat].f;
  const out = [];
  for (const split of playerSplits(L, ctx)) {
    // A typical line comes from the last-10 average, so recent windows against it say nothing new.
    if (prop.typical && split.family === 'recent') continue;
    const filtered = Object.keys(split.f).length ? HL.applyFilters(L, rows, split.f) : rows;
    const w = HL.windowRates(filtered, stat, line, 'o', { opp: ctx.opp, season: L.meta.season })[split.win];
    if (split.mate) {  // only teammates he has actually played with
      if (HL.applyFilters(L, rows, { with: [split.mate.id] }).length < INSIGHT_MIN_N) continue;
    }
    const strong = strongSide(w.rows.map(r => HL.outcome(f(r), line, 'o')));
    if (!strong) continue;
    const side = strong.side === 'yes' ? 'o' : 'u';
    const t = { ...strong, side };
    const avg = HL.mean(w.rows.map(f));
    const params = { id: prop.id, stat, line, opp: ctx.opp, win: split.win, ...split.f };
    if (side === 'u') params.side = 'u';
    if (params.without) params.without = params.without.join(',');
    out.push({
      type: 'player', gid: ctx.gid, t: ctx.t, team: p.t, opp: ctx.opp, pid: prop.id, name: p.n, stat, market: stat,
      line, side, typical: !!prop.typical, price: side === 'o' ? prop.o : prop.u, book: prop.bk,
      label: `${side === 'o' ? 'Over' : 'Under'} ${line} ${HL.STATS[stat].label}`,
      hits: t.hits, n: t.n, rate: t.rate, results: t.results, dates: w.rows.map(r => r.g.d),
      text: playerSentence(p.n, stat, line, t, split, avg), split: split.key, family: split.family,
      group: `${prop.id}|${stat}`, strength: wilson(t.hits, t.n), params,
    });
  }
  return out;
}

// ---------------------------------------------------------------- teams

/* A team's splits for today: each picks past games (oldest first) and says whether today's number or
   each game's own closing line is used. */
function teamInsightSplits(L, team, g) {
  const home = g.h === team, sp = g.line && g.line.sp != null ? (home ? g.line.sp : -g.line.sp) : null;
  const all = HL.teamFinals(L, team, g.t);
  const s = [
    { key: 'l10', family: 'recent', sides: all.slice(-10), today: true, ctx: '' },
    { key: 'l20', family: 'recent', sides: all.slice(-20), today: true, ctx: '' },
    { key: 'loc', family: 'loc', sides: all.filter(x => x.home === home).slice(-10), ctx: home ? ' at home' : ' on the road' },
  ];
  if (sp != null && sp > 0) s.push({ key: 'dog', family: 'role', sides: all.filter(x => x.spread != null && x.spread > 0).slice(-12), ctx: ' as an underdog' });
  if (sp != null && sp < 0) s.push({ key: 'fav', family: 'role', sides: all.filter(x => x.spread != null && x.spread < 0).slice(-12), ctx: ' as a favorite' });
  const last = all[all.length - 1];
  if (last && !last.win) s.push({ key: 'afterL', family: 'form', sides: all.filter((x, i) => i > 0 && !all[i - 1].win).slice(-10), ctx: ' after a loss' });
  if (L.rest[`${g.id}|${team}`] === 0) {
    s.push({ key: 'b2b', family: 'rest', sides: all.filter(x => L.rest[`${x.g.id}|${team}`] === 0).slice(-10), ctx: ' on the second night of a back-to-back' });
  }
  return { sp, splits: s };
}

function teamInsights(L, g, team) {
  const line = g.line || {}, home = g.h === team, opp = home ? g.a : g.h;
  const T = L.teams[team], name = fullName(L, team), nick = T.name;
  const { sp, splits } = teamInsightSplits(L, team, g);
  const out = [];
  const add = (market, split, strong, extra) => {
    out.push({
      type: 'team', gid: g.id, t: g.t, team, opp, market, hits: strong.hits, n: strong.n, rate: strong.rate,
      results: strong.results, dates: split.sides.map(x => x.g.d), split: split.key, family: split.family,
      group: `${team}|${market}`, strength: wilson(strong.hits, strong.n), book: line.bk, ...extra,
    });
  };
  for (const split of splits) {
    const sides = split.sides;
    // Money line: wins.
    let s = strongSide(sides.map(x => x.win ? 'hit' : 'miss'));
    if (s) {
      const yes = s.side === 'yes';
      add('ml', split, s, {
        side: yes ? team : opp, price: yes ? (home ? line.mlh : line.mla) : (home ? line.mla : line.mlh),
        label: `${yes ? team : opp} Money line`,
        text: `The ${name} have ${yes ? 'won' : 'lost'} ${s.hits === s.n ? `each of their last ${nGames(s.n)}` : `${s.hits} of their last ${nGames(s.n)}`}${split.ctx}.`,
      });
    }
    // Spread: today's number on the recent splits, each game's own closing line on the situational ones.
    if (sp != null) {
      const withLine = split.today ? sides : sides.filter(x => x.spread != null);
      s = strongSide(withLine.map(x => HL.outcome(x.margin + (split.today ? sp : x.spread), 0)));
      if (s) {
        const yes = s.side === 'yes', rec = HL.tally(withLine.map(x => HL.outcome(x.margin + (split.today ? sp : x.spread), 0)));
        const text = split.today
          ? `The ${name} have ${yes ? 'covered' : 'failed to cover'} a ${HL.signed(sp)} spread in ${s.hits} of their last ${nGames(s.n)}.`
          : `The ${name} are ${record(rec)} (${pct1(rec.rate)}) against the spread in their last ${nGames(rec.n)}${split.ctx}.`;
        add('spread', { ...split, sides: withLine }, s, {
          side: yes ? team : opp, line: yes ? sp : -sp, price: yes ? (home ? line.sph : line.spa) : (home ? line.spa : line.sph),
          label: `${yes ? team : opp} ${HL.signed(yes ? sp : -sp)} Spread`, text,
        });
      }
    }
    // Total: game totals for this team's games.
    if (line.tot != null && split.key !== 'dog' && split.key !== 'fav') {
      const withLine = split.today ? sides : sides.filter(x => x.tot != null);
      const res = withLine.map(x => HL.outcome(x.total, split.today ? line.tot : x.tot));
      s = strongSide(res);
      if (s) {
        const over = s.side === 'yes', rec = HL.tally(over ? res : res.map(flip));
        const text = split.today
          ? `The ${over ? 'over' : 'under'} ${line.tot} has hit in ${s.hits} of the ${nick}' last ${nGames(s.n)}.`
          : `The ${over ? 'over' : 'under'} is ${record(rec)} in the ${nick}' last ${nGames(rec.n)}${split.ctx}.`;
        add('total', { ...split, sides: withLine }, s, {
          side: over ? 'o' : 'u', line: line.tot, price: over ? line.ov : line.un, label: `${over ? 'Over' : 'Under'} ${line.tot}`, text,
        });
      }
    }
    // First quarter and first half (no market line; ties count against the side).
    if (split.key === 'l10') {
      for (const [market, pick, won, lost, label] of [
        ['q1', q => q[0], 'won the first quarter', 'lost the first quarter', '1st quarter'],
        ['h1', q => (q.length >= 2 ? q[0] + q[1] : null), 'led at halftime', 'trailed at halftime', '1st half']]) {
        const usable = sides.filter(x => pick(x.q) != null && pick(x.oq) != null);
        s = strongSide(usable.map(x => HL.outcome(pick(x.q) - pick(x.oq), 0)));
        if (s) {
          const yes = s.side === 'yes';
          add(market, { ...split, sides: usable }, s, {
            side: yes ? team : opp, label: `${yes ? team : opp} ${label}`,
            text: `The ${name} have ${yes ? won : lost} in ${s.hits} of their last ${nGames(s.n)}.`,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- one game

/* Everything worth saying about one game. Needs L with players, logs, props and injuries loaded. */
function gameInsights(L, g) {
  const out = [];
  const injuries = L.injuries || [];
  const isOut = id => injuries.some(i => i.id === id && String(i.st || '').toLowerCase().startsWith('out'));
  const anyProps = Object.values((L.props && L.props.games) || {}).some(list => list.length);
  const gameProps = ((L.props && L.props.games) || {})[g.id] || [];

  // Teammates ruled out today who matter: 20+ minutes a game over their last 10 for this team.
  const outByTeam = {};
  const keyOut = team => outByTeam[team] || (outByTeam[team] = injuries
    .filter(i => i.t === team && i.id && isOut(i.id) && L.players[i.id])
    .filter(i => (HL.mean(HL.playerRows(L, i.id).filter(r => r.team === team).slice(-10).map(r => r.min)) || 0) >= 20)
    .map(i => ({ id: i.id, n: L.players[i.id].n })));

  // Lines to test: the book's props, or (only when no props were pulled at all) typical lines, marked.
  const byPlayer = new Map();
  if (anyProps) {
    for (const pr of gameProps) if (pr.id && L.players[pr.id] && HL.STATS[pr.s]) {
      if (!byPlayer.has(pr.id)) byPlayer.set(pr.id, []);
      byPlayer.get(pr.id).push(pr);
    }
  } else {
    for (const [pid, p] of Object.entries(L.players)) {
      if (p.t !== g.h && p.t !== g.a) continue;
      const rows = HL.playerRows(L, pid).filter(r => r.g.t < g.t);
      const recent = rows.slice(-10);
      const teamLast3 = new Set(HL.teamFinals(L, p.t, g.t).slice(-3).map(s => s.g.id));
      if (!recent.length || HL.mean(recent.map(r => r.min)) < 20 || !recent.some(r => teamLast3.has(r.gid))) continue;
      byPlayer.set(pid, TYPICAL_STATS.map(s => ({ id: pid, s, l: HL.typicalLine(rows, s), typical: true })));
    }
  }

  for (const [pid, props] of byPlayer) {
    const p = L.players[pid];
    if (isOut(pid)) continue;
    const home = p.t === g.h, opp = home ? g.a : g.h;
    const rows = HL.playerRows(L, pid).filter(r => r.g.t < g.t);
    if (rows.length < INSIGHT_MIN_N) continue;
    const outMates = keyOut(p.t).filter(m => m.id !== pid);
    const recent20 = rows.slice(-20);
    const ctx = {
      gid: g.id, t: g.t, home, opp, rest: L.rest[`${g.id}|${p.t}`], outMates,
      // "as a starter" only says something for players who move between the bench and the lineup
      starterSwing: recent20.filter(r => !r.starter).length >= 3 && recent20.filter(r => r.starter).length >= 3,
    };
    for (const prop of props) out.push(...playerInsights(L, p, rows, prop, ctx));
  }
  for (const team of [g.a, g.h]) out.push(...teamInsights(L, g, team));
  return keepBest(out);
}

// ---------------------------------------------------------------- rendering (browser)

const INSIGHT_MARKETS = { spread: 'Spread', ml: 'Money line', total: 'Total', q1: '1st quarter', h1: '1st half' };
const marketLabel = m => (HL.STATS[m] ? HL.STATS[m].label : INSIGHT_MARKETS[m] || m);

function insightHref(x) {
  if (x.type === 'team') return `game.html?id=${x.gid}&tab=matchup`;
  const q = new URLSearchParams(Object.entries(x.params).filter(([, v]) => v !== '' && v != null));
  return `player.html?${q}`;
}

function insightCard(L, x, opts = {}) {
  const who = x.type === 'player'
    ? `${headshot(x.pid, 44)}<div class="grow"><b>${esc(x.name)}</b> <small>(${esc(x.team)})</small></div>`
    : `${logo(L, x.team, 40)}<div class="grow"><b>${esc(fullName(L, x.team))}</b></div>`;
  const g = L.byId.get(x.gid);
  const game = opts.showGame && g ? `<span class="tag">${esc(g.a)} @ ${esc(g.h)}</span>` : '';
  const price = x.price != null ? `<span class="price">${odds(x.price)}${x.book ? ` <small>${esc(bookName(x.book) || x.book)}</small>` : ''}</span>`
    : x.typical ? '<span class="tag">typical line</span>' : '';
  const titles = x.dates.map((d, i) => `${shortDate(d)}: ${x.results[i]}`);
  return `<a class="card insight" href="${insightHref(x)}">
    <div class="row">${who}${game}</div>
    <p class="itext">${esc(x.text)}</p>
    <div class="ibet"><span class="grow">${esc(x.label)}</span>${price}</div>
    ${strip(x.results, titles)}
    <div class="irate"><b class="rate ${x.rate >= 0.75 ? 'hot' : ''}">${pct1(x.rate)}</b> in the last ${nGames(x.n)}</div></a>`;
}

/* Sort helpers shared by the game page and the Trends page. */
const INSIGHT_SORTS = {
  date: (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) || b.strength - a.strength,
  rate: (a, b) => b.rate - a.rate || b.n - a.n,
  n: (a, b) => b.n - a.n || b.rate - a.rate,
  best: (a, b) => b.strength - a.strength,
};

if (typeof module !== 'undefined') {
  module.exports = { wilson, strongSide, keepBest, playerInsights, teamInsights, gameInsights, INSIGHT_SORTS, NOUNS };
}
