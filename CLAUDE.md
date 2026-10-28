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
  closelines when present, JSON export/import, canvas share cards. "My picks" is the 5th bottom-nav item;
  Standings lives behind the trophy button in the header.
- Green = hit, red = miss, grey = push. Ruled-out players are tagged (O/Q/D/P/DTD) and sink on the Props page.

## Agents (`.claude/agents/`)
- `data-checker`: runs `scripts/check_data.py` (also a workflow step; report on each run's summary page) and
  traces warnings to their cause.
- `mobile-reviewer`: screenshots pages at 390px and 1280px and reports layout problems. Run it before merging UI work.
- `trend-finder`: proposes and tests new Insight rules for `site/assets/insights.js` against real data.
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
- **Update 1 (planned, Josh approved the plan; build when he says so): line breakdown page.** Tapping a game line
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
- **Update 2 (planned, Josh approved; build when he says so): layered player props.** Less on screen, more on tap.
  1. Game page Player props: compact rows only ("Aaron Nesmith - Points"), stat chips kept as they are; no strips,
     chips or rates until tapped.
  2. Tap a row: it expands to a line ladder for that stat (Over 4.5, 5.5, ...), each with an L10 strip, hit % and
     price (prices only where we have that line; alt lines aren't pulled because they cost credits).
  3. Open the deep page from a line with our OWN control, not Outlier's bar-chart icon: each ladder line ends in a
     "›" arrow / "Breakdown" pill (tapping the line's hit % works too). player.html opens on that stat and line. Keep
     OUR stat tabs (no FGA/FTM/etc.). Add a bottom section bar to jump between: Statistics (windows + chart),
     Supporting stats, "vs {OPP} {position}" = how this defense does against his position (allowed per game + rank,
     season and last 10, from defenseVsPosition; G/F/C buckets since ESPN rarely gives PG/SG/SF/PF) - NOT a
     game-by-game list of other players and whether they hit their lines (Josh doesn't want that), Shot chart vs
     defense, Key defense ranks, Probable starters + injuries, and line movement as one simple line of text
     ("Opened 10.5 -> now 11.5 ↑", morning vs pre-tip pull), no chart.
  Build directly, no subagents. Pairs with Update 1 (same "tap the bar for the deep page" pattern for game lines).
- Later ideas: correlation finder for same-game parlays, expected starters from ESPN depth charts, a `model-auditor`
  agent that reruns the backtest weekly, re-running the research agent monthly.
- Out of reach for now: NBA.com stats (play types, tracking) are blocked from cloud servers; The Odds API historical
  odds are paid-only, so our own daily prop snapshots on `data` are the line history.
