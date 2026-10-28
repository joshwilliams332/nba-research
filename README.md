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
| **Player** | Bar chart of any stat (points, rebounds, assists, threes, PRA and combos, stocks, attempts) against an adjustable line, over or under. Hit rates for H2H / L5 / L10 / L20 / this season / last season. Filters: home/away, days of rest, starter/bench, team result, final margin, minimum minutes, regular season only, and **with / without any teammate**. Supporting stats (minutes, FGA, 3PA, FTA, fouls) for the same games, plus the full game log. |
| **Trends** | The slate's strongest trends written as sentences ("The Indiana Pacers are 10-2 (83.3%) against the spread in their last 12 games as an underdog"), filterable by player/team, market and game. The same feed is the Insights tab on each game page. |
| **Props** | Today's sportsbook props ranked by recent hit rate, best side or overs/unders only, each with the model's projection, its gap to the line and the chance of that side. Players ruled out sink to the bottom. |
| **Model** | How the projection model works and how it did on last season: accuracy against simple baselines, a calibration chart, what each adjustment adds, and how its leans did. |

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
- **The projection model** (`site/assets/model.js`) projects a stat as expected minutes x per-minute rate, adjusted for
  the opponent's defense against the player's position (per possession, shrunk toward average) and the game's expected
  pace, then turns it into over / under probabilities with a negative binomial. `scripts/backtest.js` replays every game
  of last season using only earlier games, fits each stat's spread on the first half and reports the second half
  (accuracy vs L10 / season averages, Brier score vs the site's hit rates, calibration, and an ablation of each
  adjustment) to `site/data/model.json`, which the Model page renders. It reruns with every data update.
- **The site** (`site/`) is plain HTML/CSS/JS with no framework or build step. `site/assets/common.js` holds the
  shared logic: stat definitions, filters, window hit rates, team trends, records and quarter splits.
  Trends for a game line are judged against *that game's* number (e.g. "would the 76ers' last 10 games have
  covered -4.5?"), the same way player props are.
- **`.github/workflows/update-and-deploy.yml`** runs five times a day around the NBA schedule and on every merge
  to `main`. `tests.yml` runs the unit tests on every pull request.

## Running it locally

```bash
python3 scripts/build_data.py --no-odds      # or set ODDS_API_KEY to pull props
cd site && python3 -m http.server 8000       # open http://localhost:8000
```

To start from the cached data instead of downloading two seasons of box scores:

```bash
git clone --depth 1 --branch data https://github.com/joshwilliams332/nba-research store
python3 scripts/build_data.py --offline
node scripts/backtest.js                     # projection model backtest -> site/data/model.json
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
