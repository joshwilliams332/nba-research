# Hoop Lab: notes for Claude

NBA research site for Josh (joshwilliams332): trends, hit rates, matchups. Live at
https://joshwilliams332.github.io/nba-research/. Also a resume project, so keep the code clean, tested and
documented (README), and work through PRs with clear descriptions.
Josh mostly checks the site on his phone, so every change gets checked at ~390px wide as well as desktop.
The look is inspired by Outlier, but it uses its own name and branding; never copy another product's logos or marks.

## How work ships
- Branch, PR into `main`, merge. Merging deploys via `.github/workflows/update-and-deploy.yml` (also runs 5x/day
  around NBA games and on "Run workflow"). Runs on other branches build data but skip the deploy.
- `tests.yml` runs `python3 -m unittest discover -s tests` and `node --test tests/*.test.js` on PRs.
- `site/data/` is generated and git-ignored. `store/` is the cache, kept on the `data` branch (box scores by game,
  scoreboard days, prop snapshots, injuries, `samples/` of raw ESPN JSON for checking field shapes).
  Local dev: clone the `data` branch into `store/`, then `python3 scripts/build_data.py --offline`.
- This cloud sandbox can't reach ESPN or The Odds API; GitHub Actions can. Check real runs via the Actions logs.

## Data
- ESPN site API (no key): scoreboard per ET day (games, records, quarter scores, DraftKings game lines),
  summary per final game (box score; `pickcenter` as a line fallback), injuries. Our abbreviations are the
  standard ones (GSW, NYK, NOP, SAS, UTA, WAS); `ALIASES` maps ESPN's.
- The Odds API (`ODDS_API_KEY` repo secret, free tier 500 credits/month): props only. Two pulls per ET day:
  the morning "open" pull after 10:00 ET (`store/odds/props/YYYY-MM-DD.json`) and a points-only "close" pull for
  games tipping within 100 minutes (`YYYY-MM-DD-close.json`; `close_due` skips games already captured, so extra
  cron runs are free). 1 credit per game per market. `daily_budget()` spreads what's left (minus a reserve) over the
  days left in the month; `plan_markets()` sets aside 1 credit/game for the close pull when the share allows,
  `plan_close()` caps the close pull at the share. Busy days can borrow from later days but never overspend.
  The key is shared with the Mingus football site: `OTHER_SPORTS_CREDITS` (200/month, repo variable
  `ODDS_OTHER_SPORTS_CREDITS`, 0 in the NFL off-season) is held back pro rata for the days left in the month, so
  basketball can't eat football's share. Whatever football spends shows up in the remaining count automatically.
  Limiting to one sportsbook doesn't save credits (up to 10 books = 1 region), so all US books are pulled and
  DraftKings is shown first.
- Seasons are named by their ending year like ESPN (2026-27 = 2027). Last season + this season are loaded.

## Conventions
- All hit-rate math lives in `site/assets/common.js` (`outcome`, `tally`, `windowRates`, `applyFilters`,
  `lineResults`, `teamSplits`) and is unit tested in `tests/common.test.js`.
- Game-line trends are judged against the current game's number (team's last 10 vs tonight's spread / total),
  matching how Outlier shows them. ATS / O/U records on the Matchup tab use each game's own closing line.
- With no sportsbook line, a player gets a "typical" line: floor(L10 average) + 0.5, always labeled as such.
- Insights (`site/assets/insights.js`, tested in `tests/insights.test.js`): kept when a side hits >= 75% over >= 5 games,
  ranked by Wilson lower bound, best 2 per player stat / team market (one per split family). Player splits reuse
  `applyFilters` + windows, and each card links to player.html with the same filters as URL params (loc, rest, role,
  without, win) so the numbers match. Typical lines are only used when no props were pulled at all, and are marked.
- Installable app: `site/manifest.webmanifest`, icons in `site/assets/icons/`, service worker `site/sw.js`
  (pages and data network-first with cached fallback + "Offline · data from …" banner; assets cache-first by
  their ?v= URL; the deploy stamps sw.js's VERSION with the commit). When adding a page or a script, add it to
  `PAGES` / `ASSETS` in sw.js so it works offline from the first visit.
- Projection model (`site/assets/model.js`, tested in `tests/model.test.js`): minutes x per-minute rate x opponent
  (DvP, half strength, capped) x pace, teammate-out adjustment weighted by the share of recent games the teammate
  played (avoids double counting), negative binomial for the chances. `scripts/backtest.js` (workflow step) writes
  `site/data/model.json` for `model.html`. Node loads the helpers via `Object.assign(globalThis, require(...))`;
  never declare common.js names with `var`/`const` in other asset files (they share one global scope in the browser).
- Line movement / CLV (`site/assets/lines.js`, tested in `tests/lines.test.js`): props.json props carry `open` and
  `close` as `[line, over, under, book]` (shown line = close once it exists); `closelines.json` is the close history
  (player -> game -> stat). Games keep `open` (first line seen) next to `line`. CLV = your line vs the close, in
  points and in no-vig probability (`clv()`); movement tags only show when the line or no-vig price moved.
- Picks tracker (`site/assets/picks.js`, `site/picks.html`, tested in `tests/picks.test.js`): localStorage key
  `hooplab.picks`, graded from logs.json box scores (`gradePick`), units/ROI from American odds, CLV from
  closelines when present, JSON export/import, canvas share cards. Parlays (`type: 'parlay'`, `makeParlay`,
  `gradeParlay`): built on My picks from 2+ open saved picks, legs copied, price from the legs or what the book shows,
  optional profit boost %; graded like a book (any losing leg loses it; void/push legs drop out and the price is rebuilt;
  all drop out = push). "Hoop Lab model picks" card (collapsible): the model's record since `RECORD_START`, today's
  picks with one-tap add, and "See all picks" with every past day graded (`site/data/digest.json` = today + history,
  written by `digest.js` each run before the deploy). Your graded picks are grouped into one drop-down per day; open /
  closed state is kept in `hooplab.picksOpen`. "My picks" is the 5th bottom-nav item;
  Standings lives behind the trophy button in the header.
- Teammate-out splits ("+2.3 PTS without him") stay off list views (Props cards, game-page rows) and don't move
  typical lines: Josh found them noisy (bench players, few games). They live collapsed under the player page's
  "Lineup & injuries" section, with numbers only at 5+ games without him; the Without filter covers the rest.
  The projection model's own teammate-out adjustment is separate and stays (it's backtested).
- Daily picks digest (`scripts/digest.js`, tested in `tests/digest.test.js`; called "social posts" before Oct 30; workflow step after the backtest, never blocks
  the deploy): best bets lock once per day on the first run at 10 AM ET+ (the morning props run, so prices are fresh; was 4 PM
  until Oct 31) or 3h before the first tip, into
  `store/digest/YYYY-MM-DD.json` + `.png` (moved from `social/` once, automatically) (card drawn by the runner's Chrome); the recap (`-recap.json/.png`) is
  written once every pick's game is final, with `modelCheck()` (season win rate vs claimed chance, ROI, CLV, side/stat splits,
  observations) in its for-Josh notes; `status.json` says what the last run did. Locked files are never rewritten
  (honest public record); the counted record starts at `RECORD_START` (2026-10-29; 10/28 was an unposted test night). `WITHDRAWN` lists picks pulled before posting and before tip (with the reason); they stay in the locked file but leave the post, recap and record. Never add one after a pick was posted or its game started. Pick chance = 30% model + 70% books' no-vig consensus (`fairPrice`), skip when they differ
  by 20+ points (model missing news), skip anyone on the injury report; >= 54% and >= 3% edge at the posted price,
  max 5, one per player, two per game; prices -200 to +180. Grading reuses picks.js (`gradePick`, `summarize`).
  Delivery: scheduled Claude tasks email Josh (12:23 PM ET picks, 5:53 PM ET heads-up only if a -check.json exists,
  4:41 AM ET recap, after the 3:47 AM EDT / 2:47 AM EST data run grades the late games) following
  `.claude/agents/pick-digest.md`. Public wording (README, workflow, PRs) describes it as automated emails to Josh, not
  social media posting (recruiters read this repo). Nothing auto-posts.
- Live scores (`site/assets/live.js`, tested in `tests/live.test.js`): while a game is on (or tipping within 10 min),
  index / game / picks pages poll ESPN's public scoreboard (and the summary box score for games on screen) from the
  browser every 25 s; pauses when the tab is hidden, stops when nothing's live, gives up after 3 failed checks and keeps
  the data job's snapshot. No Odds API credits, no server. Game page: live header, "Now 19 / 24.5" on prop rows, live
  Box score tab (mid-game only already-cleared stats are green). My picks: "Now" stat, and a pick whose game ended
  before the data job saved the box score is settled from the live final instead of reading as void.
- Teammates and injuries: `injuryStatus()` (common.js) reads ESPN's note for "Day-To-Day" entries ("is doubtful for
  Thursday's game" -> Doubtful); `outMates`, `injuryTag` and the picks use it. Player page: a "Without" chip row under
  the stat tabs lists teammates on today's injury report; one tap = only games he missed (same `without` filter, kept in
  the URL), with the game count and an amber note under 8 games. Picks (`digest.js`): skip a side when a rotation
  teammate (15+ min) is questionable / doubtful / day-to-day, or is out and the side hit under 50% in 5+ games without
  him. After the lock, `checkPicks` writes `YYYY-MM-DD-check.json` (heads-up notes: status changes since the lock, a
  close line that moved against the pick) and the 5:53 PM heads-up task emails it when it exists.
- Green = hit, red = miss, grey = push. Ruled-out players are tagged (O/Q/D/P/DTD) and sink on the Props page.

## Agents (`.claude/agents/`)
- `data-checker`: runs `scripts/check_data.py` (also a workflow step; report on each run's summary page) and
  traces warnings to their cause.
- `mobile-reviewer`: screenshots pages at 390px and 1280px and reports layout problems. Run it before merging UI work.
- `trend-finder`: proposes and tests new Insight rules for `site/assets/insights.js` against real data.
- `pick-digest`: the playbook the scheduled email tasks follow (fetch the day's post from the `data` branch, send it
  to Josh as written, poll if the run is late). Cheap by design: no data rebuild, no rewriting.
- Josh asked to stop using subagents for now because of token cost (Phase 4's last three pieces were finished
  one at a time in the main session). Don't spawn agents unless he asks again.
- Phase 2 was built by parallel agents, each in its own git worktree and PR (dvp, insights, teams/polish), merged
  one at a time. Keep that pattern for independent features; give each agent its own CSS section and new files.

## Roadmap (agreed phases)
- Phase 1 (done): games, game, player, props, players pages; data pipeline + `data` branch store.
- Phase 2 (done): Insights + Trends page, defense vs position / OPP RANK, team pages, standings, visual pass,
  the three agents and `scripts/check_data.py`.
- Phase 3 "Context" (done): ESPN play-by-play kept in the store -> shot charts with zone-vs-defense, 1Q/1H stats,
  win probability, first basket (`pbp.js`); teammate-out boost + sample-adjusted hit rates; pace, implied team
  totals, no-vig fair price / best line / EV+ (`context.js`).
- Open checks from Phase 3: confirm real props drive EV+ / fair price / insights; verify shot-chart left vs right
  corner orientation; demote money-line insights on heavy favorites; shot-zone ranks include playoffs while DvP is
  regular season only.
- Phase 4 "Prove it" (done: installable app, picks tracker, pre-tip pull / CLV, projection model):
  1. Projection model (minutes x per-minute rate, adjusted for DvP and pace) with a backtest on last season, a
     calibration chart and a methodology page; projections and gap to the line on prop rows.
  2. Second, small pre-tip props pull (budgeted in `plan_markets`) for closing line value and line movement.
  3. Saved picks tracker (localStorage, no backend): auto-graded from box scores, record / units / CLV, share cards.
  4. PWA: manifest, icons, offline shell; later opt-in push alerts (needs VAPID keys in Actions secrets).
- **Update 1 (done): line breakdown page** (`site/line.html`, logic in `site/assets/gameline.js`, tests in
  `tests/gameline.test.js`). Game-line sides on the Games list and game page carry `data-go` (followed by a capture
  click handler in `shell()`, so they work inside the game card's link). Data: games keep `lh` (line history before
  tip, one entry per change) and shots.json has team offense zones under `off`. The team estimate (each side =
  average of its scoring and the opponent's allowing, last 20 games, +/-0.8 home edge) was backtested on 2025-26:
  win chances calibrated well, but spread / total leans hit only ~49% / 47% vs closing lines, so the page shows win %
  and the estimated score only, never a cover / over %, and says so. Original plan: Tapping a game line
  (money line, spread or total side) on the Games list / game page opens a breakdown for that bet, inspired by
  Outlier but with our own layout and branding (ideas are fine to borrow; never their name, logo, look-alike design,
  text, or licensed data such as RotoWire lineups). Sections:
  1. Statistics: H2H / L5 / L10 / L20 / this season / last season hit rates for that bet, for each side (tap a team to
     switch), game-by-game list (date, opponent, W/L and score, or cover / over result), same filters as player pages.
  2. Insights: the trend finder's team insights for that market.
  3. Shot chart, offense vs defense: team-level zones (where this team scores vs where the opponent allows), built
     from the play-by-play store.
  4. Lineup: "probable starters (last game)" from box-score starter flags plus the ESPN injury report (no RotoWire).
  5. Line movement: save an ESPN game-line snapshot on every workflow run (~8/day, free) and chart open -> now.
  6. Our extra: the model's win / cover / over chance next to the line.
  Cost: no new data or credits. Build directly, no subagents.
- **Update 2 (done): layered player props.** Less on screen, more on tap.
  1. Game page Player props: compact rows only ("Aaron Nesmith - Points"), stat chips kept as they are; no strips,
     chips or rates until tapped.
  Also: tapping a player's headshot or name anywhere in a prop list must open their player page (today on the game
  page the only way in is the "Full breakdown" link at the bottom of an expanded row, which Josh couldn't find).
  2. Tap a row: it expands to a line ladder for that stat (Over 4.5, 5.5, ...), each with an L10 strip, hit % and
     price (prices only where we have that line; alt lines aren't pulled because they cost credits).
  3. Open the deep page from a line with our OWN control, not Outlier's bar-chart icon: each ladder line ends in a
     "›" arrow / "Breakdown" pill (tapping the line's hit % works too). player.html opens on that stat and line. Keep
     OUR stat tabs (no FGA/FTM/etc.). Add a bottom section bar to jump between: Statistics (windows + chart),
     Supporting stats, "{Stat} vs {OPP}": (a) how this defense does against his position (allowed per game + rank,
     season and last 10, from defenseVsPosition; G/F/C buckets since ESPN rarely gives PG/SG/SF/PF, with All / G / F
     / C tabs), and (b) a list of recent players at that position who faced this opponent with just their stat that
     night (player, matchup, date, result) - no lines, odds or hit/miss marks; then "Key {OPP} {Stat} defense": team
     points / rebounds / assists allowed per game with ranks for the stats in the selected market. Shot chart vs
     defense, Key defense ranks, Probable starters + injuries, and line movement as one simple line of text
     ("Opened 10.5 -> now 11.5 ↑", morning vs pre-tip pull), no chart.
  4. Model projection: keep it off the compact list (it can be mistaken for the book line). On the deep page show it in
     its own clearly labeled box next to the real line, e.g. "Sportsbook line 10.5 (DK) · Hoop Lab projection 12.8 ·
     58% over", with a "what's this?" link to model.html.
  Build directly, no subagents. Pairs with Update 1 (same "tap the bar for the deep page" pattern for game lines).
- **Update 3 (done): Props page sorting and filters.** Sort and filters persist in localStorage (`hooplab.props.filters`, saved setups in `hooplab.props.setups`). Own design, not a clone.
  1. Sticky sort bar above the bottom nav: Opp Rank · L5 · L10 · L20 · H2H · This season · Last season. Picking one
     re-sorts the list by that hit rate (best first) and switches the chips under each card to match.
  2. Cards: player, line, price, strip, OPP RANK, IP (implied % from the odds), and (since removed, see Conventions) a
     teammate-out note ("Embiid OUT · +3.4 PTS without him").
     Tapping a card opens player.html on that stat and line.
  3. Filters sheet: stat types (multi-select), only EV+, players, games, minimum hit rate (slider, chosen window),
     odds range (slider, e.g. at least -300), opponent matchup Favorable / Neutral / Unfavorable (OPP RANK top 10 /
     middle / bottom 10), over / under, and saved filter setups (localStorage). No alt lines (they cost credits).
- Later ideas: correlation finder for same-game parlays, expected starters from ESPN depth charts, a `model-auditor`
  agent that reruns the backtest weekly, re-running the research agent monthly.
- Out of reach for now: NBA.com stats (play types, tracking) are blocked from cloud servers; The Odds API historical
  odds are paid-only, so our own daily prop snapshots on `data` are the line history.
