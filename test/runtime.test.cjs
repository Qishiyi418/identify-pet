'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/runtime.json');
const movement = require('../config/movement.json');
const { sanitizeSettings, geometry, resizeAtFeet, constrain, recoverPosition, movementBody, roamArea, roamingArea } = require('../src/runtime.cjs');

const screen = { x: 0, y: 0, width: 1920, height: 1040 };

test('settings fall back to defaults for missing or malformed input', () => {
  for (const input of [null, 'text', { height: 'tall', alwaysOnTop: 1, activityIdleSec: 7, position: { x: 'a' } }]) {
    const settings = sanitizeSettings(input, config);
    assert.equal(settings.height, config.defaultHeight);
    assert.equal(settings.alwaysOnTop, true);
    assert.equal(settings.activityIdleSec, 60);
    assert.equal(settings.position, null);
    assert.deepEqual(Object.keys(settings.randomActions).sort(), Object.keys(config.randomPolicy.defaults).sort());
  }
});

test('settings clamp size and rule values', () => {
  const settings = sanitizeSettings({ height: 9999, randomActions: { candy: { weight: 42, cooldownMs: -5, timeProfile: 'never' } } }, config);
  assert.equal(settings.height, config.maxHeight);
  assert.equal(sanitizeSettings({ height: 1 }, config).height, config.minHeight);
  assert.equal(settings.randomActions.candy.weight, 10);
  assert.equal(settings.randomActions.candy.cooldownMs, 0);
  assert.equal(settings.randomActions.candy.timeProfile, config.randomPolicy.defaults.candy.timeProfile);
});

test('resizing keeps the feet where they were', () => {
  const small = geometry(config.minHeight, config.idle), large = geometry(config.maxHeight, config.idle);
  const bounds = { x: 500, y: 300, width: small.width, height: small.height };
  const next = resizeAtFeet(bounds, small, large);
  assert.ok(Math.abs(bounds.x + small.anchorX - (next.x + large.anchorX)) <= 1);
  assert.ok(Math.abs(bounds.y + small.footY - (next.y + large.footY)) <= 1);
  assert.equal(next.width, large.width);
});

test('windows are kept on the nearest display', () => {
  const size = geometry(config.defaultHeight, config.idle);
  const placed = constrain({ x: 5000, y: -400, width: size.width, height: size.height }, [screen]);
  assert.equal(placed.x, screen.width - size.width);
  assert.equal(placed.y, 0);
});

test('a character partly off screen stays put, one fully off screen is brought back', () => {
  const size = geometry(config.defaultHeight, config.idle), body = movementBody(size, config.idle, movement);
  const edge = { x: screen.width - body.x - body.width / 2, y: 400, width: size.width, height: size.height };
  assert.deepEqual(recoverPosition(edge, [screen], body), edge);
  const lost = recoverPosition({ ...edge, x: 4000 }, [screen], body);
  assert.ok(lost.x + body.x + body.width <= screen.width && lost.x + body.x >= 0);
});

test('automatic movement stays near home and inside the display', () => {
  const size = geometry(config.defaultHeight, config.idle), body = movementBody(size, config.idle, movement);
  const home = { x: 1500, y: 700 };
  const area = roamArea(home, body, [screen], size.scale);
  assert.ok(area.x >= screen.x && area.y >= screen.y);
  assert.ok(area.x + area.width <= screen.width && area.y + area.height <= screen.height);
  assert.ok(area.x <= home.x + body.x && area.x + area.width >= home.x + body.x + body.width);
  assert.ok(area.width < screen.width);
  // Being moved far away by something other than a drag makes that place the new home.
  const moved = roamingArea(home, { x: 100, y: 100, width: size.width, height: size.height }, body, [screen], size.scale);
  assert.deepEqual(moved.home, { x: 100, y: 100 });
});
