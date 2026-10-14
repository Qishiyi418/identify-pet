'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FramePresenter } = require('../src/frame-presenter.js');

// A single premultiplied pixel makes opacity loss, transparent edges and
// interrupted transitions observable independently of a browser's renderer.
function canvas(pixel = [0, 0, 0, 0]) {
  const result = { width: 1, height: 1, pixel: [...pixel], setAttribute() {}, remove() {} };
  const context = { globalAlpha: 1, globalCompositeOperation: 'source-over',
    clearRect() { result.pixel = [0, 0, 0, 0]; },
    setTransform() {}, save() {}, restore() {}, translate() {}, scale() {},
    drawImage(source) {
      const incoming = source.pixel.map(value => value * this.globalAlpha);
      const remaining = this.globalCompositeOperation === 'lighter' ? 1 : 1 - incoming[3];
      result.pixel = incoming.map((value, index) => Math.min(1, value + result.pixel[index] * remaining));
    } };
  result.getContext = () => context;
  return result;
}
function harness() {
  let time = 0, serial = 0;
  const callbacks = new Map();
  const stage = { clientWidth: 1, clientHeight: 1, appendChild() {} };
  const presenter = new FramePresenter(stage, { createCanvas: canvas, pixelRatio: () => 1, now: () => time,
    requestFrame: callback => { callbacks.set(++serial, callback); return serial; },
    cancelFrame: id => callbacks.delete(id) });
  const entry = (id, pixel, hasFrame = true) => ({ id, player: { canvas: canvas(pixel), hasFrame },
    video: { style: { width: '1px', height: '1px', left: '0px', top: '0px' } } });
  return { presenter, entry, callbacks, at: value => { time = value; presenter.render(); } };
}
const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9));

test('opaque overlap remains opaque throughout a transition', () => {
  const h = harness();
  h.presenter.select(h.entry('idle', [1, 0, 0, 1]));
  h.presenter.select(h.entry('head', [0, 0, 1, 1]));
  for (let time = 0; time <= 100; time++) { h.at(time); assert.equal(h.presenter.canvas.pixel[3], 1); }
  close(h.presenter.canvas.pixel, [0, 0, 1, 1]);
  assert.equal(h.callbacks.size, 0);
});

test('transparent pixels interpolate without a background or dark edge', () => {
  const h = harness();
  h.presenter.select(h.entry('idle', [.5, .1, 0, .5]));
  h.presenter.select(h.entry('head', [0, 0, 0, 0])); h.at(50);
  close(h.presenter.canvas.pixel, [.25, .05, 0, .25]);
  h.at(100); close(h.presenter.canvas.pixel, [0, 0, 0, 0]);
});

test('a late first frame keeps the displayed picture until it is ready', () => {
  const h = harness(), delayed = h.entry('cold', [0, 0, 1, 1], false);
  h.presenter.select(h.entry('idle', [1, 0, 0, 1]));
  h.presenter.select(delayed); h.at(500);
  close(h.presenter.canvas.pixel, [1, 0, 0, 1]); assert.equal(h.callbacks.size, 0);
  delayed.player.hasFrame = true; h.presenter.painted(delayed); h.at(550);
  close(h.presenter.canvas.pixel, [.5, 0, .5, 1]);
});

test('rapid interruptions begin at the actual displayed mixture', () => {
  const h = harness();
  h.presenter.select(h.entry('idle', [1, 0, 0, 1]));
  h.presenter.select(h.entry('head', [0, 0, 1, 1])); h.at(50);
  const displayed = [...h.presenter.canvas.pixel];
  h.presenter.select(h.entry('body', [0, 1, 0, 1])); close(h.presenter.canvas.pixel, displayed);
  h.at(100); close(h.presenter.canvas.pixel, [.25, .5, .25, 1]);
  assert.equal(h.callbacks.size, 1);
});

test('late paint from a cancelled surface cannot replace the selected action', () => {
  const h = harness(), stale = h.entry('cancelled', [1, 0, 0, 1]);
  h.presenter.select(stale); h.presenter.select(h.entry('latest', [0, 0, 1, 1])); h.at(100);
  h.presenter.painted(stale); close(h.presenter.canvas.pixel, [0, 0, 1, 1]);
  assert.equal(h.presenter.snapshot().currentId, 'latest');
});

test('settled playback schedules no extra render loop and disposal cancels blending', () => {
  const h = harness();
  h.presenter.select(h.entry('idle', [1, 0, 0, 1])); assert.equal(h.callbacks.size, 0);
  h.presenter.select(h.entry('head', [0, 0, 1, 1])); assert.equal(h.callbacks.size, 1);
  h.presenter.dispose(); assert.equal(h.callbacks.size, 0);
  h.at(100); assert.equal(h.presenter.snapshot().paints, 2);
});
