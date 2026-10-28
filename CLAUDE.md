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
- The Odds API (`ODDS_API_KEY` repo secret, free tier 500 credits/month): props only, pulled once per ET day after
  10:00 ET. 1 credit per game per market; `plan_markets()` budgets markets over the rest of the month.
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
- Projection model (`site/assets/model.js`, tested in `tests/model.test.js`): minutes x per-minute rate x defense
  (per possession vs position, shrunk) x pace, negative binomial for probabilities. Everything must use only games
  before tip-off (there's a no-peeking test). `scripts/backtest.js` runs in the deploy workflow after `check_data.py`,
  writes `site/data/model.json` (fitted phi per stat + backtest report for `model.html`). Last season is judged
  against typical lines because no book line history exists for it; change tuning only on the fit half (before Jan 1).
- Green = hit, red = miss, grey = push. Ruled-out players are tagged (O/Q/D/P/DTD) and sink on the Props page.

## Agents (`.claude/agents/`)
- `data-checker`: runs `scripts/check_data.py` (also a workflow step; report on each run's summary page) and
  traces warnings to their cause.
- `mobile-reviewer`: screenshots pages at 390px and 1280px and reports layout problems. Run it before merging UI work.
- `trend-finder`: proposes and tests new Insight rules for `site/assets/insights.js` against real data.
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
- Phase 4 "Prove it" (next, from the research report):
  1. (done) Projection model (minutes x per-minute rate, adjusted for DvP and pace) with a backtest on last season, a
     calibration chart and a methodology page (`model.html`); projections and gap to the line on prop rows and the
     player page. Follow-ups: injury / teammate-out minutes, real-line backtest once props accumulate.
  2. Second, small pre-tip props pull (budgeted in `plan_markets`) for closing line value and line movement.
  3. Saved picks tracker (localStorage, no backend): auto-graded from box scores, record / units / CLV, share cards.
  4. PWA: manifest, icons, offline shell; later opt-in push alerts (needs VAPID keys in Actions secrets).
- Later ideas: correlation finder for same-game parlays, expected starters from ESPN depth charts, a `model-auditor`
  agent that reruns the backtest weekly, re-running the research agent monthly.
- Out of reach for now: NBA.com stats (play types, tracking) are blocked from cloud servers; The Odds API historical
  odds are paid-only, so our own daily prop snapshots on `data` are the line history.
