'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StartupPresentation, inspectTransparentFrame } = require('../src/startup-presentation.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));
function frame(kind = 'character') {
  const bitmap = Buffer.alloc(20 * 20 * 4);
  if (kind === 'black') bitmap.fill(255);
  if (kind === 'character') for (let y = 4; y < 16; y++) for (let x = 7; x < 13; x++) bitmap[(y * 20 + x) * 4 + 3] = 255;
  return { getSize: () => ({ width: 20, height: 20 }), toBitmap: () => bitmap };
}
function harness({ capture = async () => frame(), pause } = {}) {
  let visible = false, opacity = 0, destroyed = false, allowed = true, stamp = 0, timer, schedules = 0;
  const calls = [], failures = [];
  const window = { isDestroyed: () => destroyed, isVisible: () => visible, getOpacity: () => opacity,
    setOpacity: value => { assert.equal(destroyed, false); opacity = value; calls.push(['opacity', value]); },
    showInactive: () => { assert.equal(destroyed, false); visible = true; calls.push(['show']); },
    hide: () => { assert.equal(destroyed, false); visible = false; calls.push(['hide']); },
    webContents: { capturePage: capture } };
  const presentation = new StartupPresentation({ window, allowed: () => allowed, painted: () => true,
    timeoutMs: 500, now: () => stamp,
    pause: async ms => { stamp += ms; if (pause) await pause(ms); },
    schedule: callback => { schedules++; timer = callback; return 1; }, unschedule: () => { timer = null; },
    onFallback: reason => { failures.push(reason); window.setOpacity(1); if (allowed) window.showInactive(); else window.hide(); } });
  return { presentation, window, calls, failures, timeout: () => { assert.ok(timer); timer(); },
    timerActive: () => Boolean(timer), schedules: () => schedules,
    allow: value => { allowed = value; if (!value) window.hide(); }, destroy: () => { destroyed = true; } };
}

test('frame inspection distinguishes a transparent character from blank/black frames', () => {
  assert.equal(inspectTransparentFrame(frame()).valid, true);
  for (const kind of ['empty', 'black']) assert.equal(inspectTransparentFrame(frame(kind)).valid, false);
});
test('normal startup warms at zero opacity, reveals once and clears watchdog', async () => {
  const h = harness(); h.presentation.start();
  assert.equal(await h.presentation.present(), true);
  assert.deepEqual(h.calls, [['opacity', 0], ['show'], ['opacity', 1]]);
  assert.equal(h.presentation.phase, 'ready'); assert.equal(h.timerActive(), false);
  assert.equal(h.schedules(), 1); assert.equal(h.presentation.fallback(), false);
});
test('watchdog runs even when the renderer never sends ready', () => {
  const h = harness(); h.presentation.start(); h.timeout();
  assert.equal(h.presentation.phase, 'fallback'); assert.equal(h.window.getOpacity(), 1);
  assert.equal(h.failures.length, 1); assert.equal(h.timerActive(), false);
});
for (const hangAt of [1, 2]) {
  for (const lateResult of ['resolve', 'reject']) {
    test(`capture ${hangAt} cannot block recovery; late ${lateResult} cannot overwrite fallback`, async () => {
      let count = 0, settle;
      const h = harness({ capture: () => ++count === hangAt ? new Promise((resolve, reject) => {
        settle = () => lateResult === 'resolve' ? resolve(frame()) : reject(new Error('late failure'));
      }) : Promise.resolve(frame()) });
      const pending = h.presentation.present(); await flush();
      assert.equal(count, hangAt); h.timeout();
      assert.equal(await pending, false); assert.equal(h.presentation.pending, null);
      assert.equal(h.window.getOpacity(), 1); assert.equal(h.window.isVisible(), true);
      const calls = [...h.calls], events = [...h.presentation.events];
      settle(); await flush();
      assert.deepEqual(h.calls, calls); assert.deepEqual(h.presentation.events, events);
      assert.equal(h.presentation.phase, 'fallback'); assert.equal(h.failures.length, 1);
    });
  }
}
test('manual recovery interrupts an in-flight capture without waiting for its timeout', async () => {
  const h = harness({ capture: () => new Promise(() => {}) });
  const pending = h.presentation.present();
  assert.equal(h.presentation.fallback('manual recovery'), true);
  assert.equal(await pending, false); assert.equal(h.window.getOpacity(), 1);
  assert.equal(h.timerActive(), false);
});
test('recovery respects a hide/lock/fullscreen gate during warmup', async () => {
  let captures = 0;
  const h = harness({ capture: () => ++captures === 2 ? new Promise(() => {}) : Promise.resolve(frame()) });
  const pending = h.presentation.present(); await flush(); h.allow(false); h.timeout();
  await pending; assert.equal(h.window.isVisible(), false); assert.equal(h.window.getOpacity(), 1);
});
test('shutdown settles pending startup and late capture never touches a destroyed window', async () => {
  let resolve;
  const h = harness({ capture: () => new Promise(done => { resolve = done; }) });
  const pending = h.presentation.present(); h.presentation.cancel(); h.destroy();
  assert.equal(await pending, false); assert.equal(h.timerActive(), false);
  resolve(frame()); await flush(); assert.deepEqual(h.calls, []); assert.equal(h.failures.length, 0);
});
test('warmup rejection can fall back after the promise settles', async () => {
  const h = harness({ capture: async () => { throw new Error('capture failed'); } });
  await assert.rejects(h.presentation.present(), /capture failed/);
  assert.equal(h.presentation.fallback(), true); assert.equal(h.window.getOpacity(), 1);
});
test('a startup gated before presentation can still be shown later', async () => {
  const h = harness(); h.allow(false);
  assert.equal(await h.presentation.present(), false);
  h.allow(true); assert.equal(await h.presentation.present(), true);
  assert.equal(h.window.isVisible(), true);
});
