'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetHold = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  class HoldIntent {
    constructor({ now = () => performance.now(), holdMs = 500, movePx = 4, onIntent = () => {} } = {}) {
      Object.assign(this, { now, holdMs, movePx, onIntent }); this.press = null;
    }
    begin(point) {
      if (this.press || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      this.press = { origin: { ...point }, cursor: { ...point }, at: this.now(), intent: null }; return true;
    }
    trigger(intent) {
      if (!this.press || this.press.intent) return null;
      this.press.intent = intent; this.onIntent(intent, this.press.cursor); return intent;
    }
    move(point) {
      if (!this.press || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      this.press.cursor = { ...point };
      if (Math.hypot(point.x - this.press.origin.x, point.y - this.press.origin.y) >= this.movePx) return this.trigger('drag');
      return this.tick();
    }
    tick() { return this.press && this.now() - this.press.at >= this.holdMs ? this.trigger('hold') : null; }
    release() {
      if (!this.press) return null;
      this.tick(); // A delayed timer must not turn a long hold into a click.
      const result = this.press.intent ? 'release' : 'click'; this.press = null; return result;
    }
    cancel() { this.press = null; }
  }
  return { HoldIntent };
});
