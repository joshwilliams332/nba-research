// Tests for the service worker's request routing and precache list (site/sw.js). Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const SW = require('../site/sw.js');

const scope = 'https://joshwilliams332.github.io/nba-research/';

test('requests are routed by kind', () => {
  assert.strictEqual(SW.route(scope, scope, 'navigate'), 'page');
  assert.strictEqual(SW.route(`${scope}game.html?id=401909935`, scope, 'navigate'), 'page');
  assert.strictEqual(SW.route(`${scope}player.html?id=1`, scope, 'cors'), 'page');
  assert.strictEqual(SW.route(`${scope}data/logs.json`, scope, 'cors'), 'data');
  assert.strictEqual(SW.route(`${scope}data/wp/401909880.json`, scope, 'cors'), 'data');
  assert.strictEqual(SW.route(`${scope}assets/common.js?v=abcdef12`, scope, 'no-cors'), 'asset');
  assert.strictEqual(SW.route(`${scope}manifest.webmanifest`, scope, 'cors'), 'asset');
  // The worker script itself, other sites (ESPN images) and other repos on the same host are left alone.
  assert.strictEqual(SW.route(`${scope}sw.js`, scope, 'no-cors'), 'none');
  assert.strictEqual(SW.route('https://a.espncdn.com/i/teamlogos/nba/500/phi.png', scope, 'no-cors'), 'none');
  assert.strictEqual(SW.route('https://joshwilliams332.github.io/mingus/index.html', scope, 'navigate'), 'none');
});

test('precache uses the same ?v= tag the deploy puts on asset links', () => {
  const dev = SW.shellUrls('dev');
  assert.ok(dev.includes('assets/common.js'));
  assert.ok(dev.includes('index.html') && dev.includes('./'));
  const live = SW.shellUrls('abcdef12');
  assert.ok(live.includes('assets/common.js?v=abcdef12'));
  assert.ok(live.includes('assets/style.css?v=abcdef12'));
  assert.ok(live.includes('assets/icons/icon-192.png'));  // icons aren't tagged
});
