# Hoop Lab

**NBA trends, hit rates and matchup research, rebuilt from public data several times a day.**

Live site: https://joshwilliams332.github.io/nba-research/

Hoop Lab answers the questions you ask before a game: *How often has this player cleared this line lately?
Does that change without his co-star? How have both teams done against tonight's spread and total?*
It's a static site with no backend: a Python job collects the data, and the browser does the math, so every
filter and line change is instant.

## What it does

| Page | What you get |
|---|---|
| **Games** | Each day's slate with money line, spread and total. Each side shows a last-10 strip and a head-to-head rate against *tonight's* number. |
| **Game** | Odds tab: game lines plus player props, with L5 / L10 / L20 / season hit rates and an alt-line ladder for every player. Matchup tab: records (home/away, conference, division, by division), ATS, O/U, quarter and half records, last 5 games, injuries. Box score once final, with each stat colored against that day's prop line. |
| **Line breakdown** | Tap any money line, spread or total side: hit rates by window against tonight's number (H2H, L5, L10, L20, season, last season) with home/away filters and the game-by-game list, a team-level score estimate (tested on last season: calibrated win chances, no edge against spreads and totals, and the page says so), insights for that market, a team shot chart (offense vs the opponent's defense by zone), probable starters and injuries, and line movement. |
| **Player** | Bar chart of any stat (points, rebounds, assists, threes, PRA and combos, stocks, attempts) against an adjustable line, over or under. Hit rates for H2H / L5 / L10 / L20 / this season / last season. Filters: home/away, days of rest, starter/bench, team result, final margin, minimum minutes, regular season only, and **with / without any teammate**. Supporting stats (minutes, FGA, 3PA, FTA, fouls) for the same games, plus the full game log. |
| **Trends** | The slate's strongest trends written as sentences ("The Indiana Pacers are 10-2 (83.3%) against the spread in their last 12 games as an underdog"), filterable by player/team, market and game. The same feed is the Insights tab on each game page. |
| **Live** | During games the Games list, game page and My picks update every 25 seconds straight from ESPN's public scoreboard: score and clock, each player's stat so far against his prop line, and a live box score. |
| **Props** | Today's sportsbook props with a one-tap sort bar (opponent rank, L5 / L10 / L20, H2H, this or last season, best price, biggest movers) and a filters sheet (stat types, side, matchup, minimum hit rate, odds, games, EV+ only) with saved setups. Each card shows OPP RANK, implied probability and who's out. |

## How it works

```
ESPN site API ──┐                                   ┌── site/data/*.json ── GitHub Pages
                ├── scripts/build_data.py (Actions) ┤
The Odds API ───┘                                   └── store/ ── `data` branch (cache + prop history)
```

- **`scripts/build_data.py`** (standard library only) pulls schedules, scores, quarter scores, closing lines,
  box scores and injuries from ESPN, and player props from The Odds API. Anything that can't change once a game
  is final is cached in `store/`, which the workflow keeps on the repo's `data` branch, so a normal run only
  downloads a few new games. Past prop lines are kept there too, since free APIs don't offer that history.
- **Credit budgeting:** The Odds API's free tier allows 500 credits a month and charges one per game per market.
  `plan_markets()` spreads the month's remaining credits evenly over the days left, then adds markets in priority
  order (points, rebounds, assists, threes) while they fit, so props never run dry mid-month.
- **The trend finder** (`site/assets/insights.js`) runs every player prop and team line through situational splits
  (recent form, home/away, vs opponent, rest, without an injured teammate, as favorite/underdog, after a loss), keeps
  sides that hit 75%+ over 5+ games, and ranks them by the Wilson lower bound so 18-of-20 beats 5-of-5.
- **The site** (`site/`) is plain HTML/CSS/JS with no framework or build step. `site/assets/common.js` holds the
  shared logic: stat definitions, filters, window hit rates, team trends, records and quarter splits.
  Trends for a game line are judged against *that game's* number (e.g. "would the 76ers' last 10 games have
  covered -4.5?"), the same way player props are.
- **Installable app:** a web app manifest and a service worker (`site/sw.js`) let it be added to a phone's home
  screen and open offline with the last data it loaded (with an "Offline · data from …" banner). Each deploy
  stamps the worker with the commit, so it never serves a stale script.
- **`.github/workflows/update-and-deploy.yml`** runs five times a day around the NBA schedule and on every merge
  to `main`. `tests.yml` runs the unit tests on every pull request.

## Projection model

Every prop shows a projection ("Proj 26.1 · 58% over"), built in `site/assets/model.js`:
projected minutes × per-minute production × opponent (defense vs position) × pace, with an adjustment when a key
teammate is out, spread into a negative-binomial range to get the chance of clearing the line.
`scripts/backtest.js` replays every past game through the same code using only earlier games, and writes the
results to the [Model page](https://joshwilliams332.github.io/nba-research/model.html) after each data update.

On 2025-26 plus the start of 2026-27 (about 106,000 player-stat predictions):

| | Model | Last-10 average |
|---|---|---|
| Points, mean absolute error | 4.84 | 4.91 |
| Pts + Reb + Ast, mean absolute error | 6.20 | 6.35 |
| Over leans (model 60%+) that hit | 64.1% | |
| Under leans (model 40% or less) that hit | 65.1% | |

Leans are graded against the typical line, because real sportsbook lines are only stored from the first prop
pulls onward. The model is slightly overconfident at the extremes (its 80%+ calls hit about 76%), which the
calibration chart on the Model page shows.

## Daily picks digest (automated email)

To test the projection model against real sportsbook lines out in the open, the data job runs a small daily digest
(`scripts/digest.js`):

- **Late-morning lock.** Right after the morning props pull, while prices are fresh, the model's chance is blended with the sportsbooks' no-vig price. Props where the two disagree
  a lot are skipped (usually news the model can't see), as are players whose rotation teammates have uncertain injury
  status. The best edges at the posted price become up to five picks, saved to the `data` branch before tip-off and
  never rewritten.
- **Heads-up check.** If injury news or the closing line moves after the lock, the digest writes a note that is
  emailed before tip-off.
- **Morning recap.** The picks are graded from box scores into a recap with the running record and closing-line value.
- **Delivery.** Scheduled tasks email me the picks at midday, a heads-up only when news changed, and the recap. Nothing is posted anywhere automatically.

## Running it locally

```bash
python3 scripts/build_data.py --no-odds      # or set ODDS_API_KEY to pull props
cd site && python3 -m http.server 8000       # open http://localhost:8000
```

To start from the cached data instead of downloading two seasons of box scores:

```bash
git clone --depth 1 --branch data https://github.com/joshwilliams332/nba-research store
python3 scripts/build_data.py --offline
```

Tests:

```bash
python3 -m unittest discover -s tests
node --test tests/*.test.js
```

## Data and disclaimer

Scores, box scores, game lines and injuries come from ESPN's public site API; player props come from
[The Odds API](https://the-odds-api.com). Team logos and headshots are linked from ESPN's image servers, not
stored here. This is a personal research project, not affiliated with the NBA, ESPN or any sportsbook. Hit rates
describe the past, not the future.

## Roadmap

- More Insight rules, e.g. splits against bottom-10 defenses at a position
- Defense vs position and opponent ranks on prop rows
- Shot charts and play-type matchups
- Team totals chart with opponent pace / defense filters
