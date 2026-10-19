'use strict';
// Checks that every clip the app loads ships with the package and matches its recorded hash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const config = require('../config/runtime.json');
const movement = require('../config/movement.json');
const pkg = require('../package.json');

function clips(value, at = 'runtime') {
  if (!value || typeof value !== 'object') return [];
  const own = typeof value.file === 'string' ? [{ at, ...value }] : [];
  return own.concat(Object.entries(value).flatMap(([key, item]) => clips(item, `${at}.${key}`)));
}
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const all = [...clips(config), ...clips(movement.clips, 'movement')];

test('every clip and poster exists and matches its sha256', () => {
  assert.ok(all.length > 20);
  for (const clip of all) {
    assert.ok(fs.existsSync(path.join(root, clip.file)), `${clip.at}: missing ${clip.file}`);
    if (clip.poster) assert.ok(fs.existsSync(path.join(root, clip.poster)), `${clip.at}: missing ${clip.poster}`);
    if (clip.sha256) assert.equal(sha256(clip.file), clip.sha256, `${clip.at}: ${clip.file} changed`);
  }
});

test('packaged builds unpack every clip, poster and native source', () => {
  const unpacked = pkg.build.asarUnpack.map(pattern => pattern.replace(/\*\*$/, ''));
  const covered = file => unpacked.some(prefix => file.startsWith(prefix));
  for (const clip of all) {
    assert.ok(covered(clip.file), `${clip.file} would stay inside app.asar`);
    if (clip.poster) assert.ok(covered(clip.poster), `${clip.poster} would stay inside app.asar`);
  }
  for (const name of ['fullscreen-monitor.cs', 'display-monitor.cs']) {
    assert.ok(fs.existsSync(path.join(root, 'src/native', name)));
    assert.ok(covered(`src/native/${name}`));
  }
});

test('the installer AppUserModelId matches the one the app sets', () => {
  assert.equal(pkg.build.appId, config.appId);
});

test('each random activity has default rules', () => {
  const defaults = config.randomPolicy.defaults;
  for (const { id } of config.activities.items) assert.ok(defaults[id], `no randomPolicy default for ${id}`);
  for (const rule of Object.values(defaults)) {
    assert.ok(Object.hasOwn(config.randomPolicy.timeProfiles, rule.timeProfile), `unknown time profile ${rule.timeProfile}`);
  }
});
