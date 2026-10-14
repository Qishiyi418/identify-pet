'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetDragFeedback = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  // This controller owns only the visual response. Native window movement,
  // screen coordinates and position persistence remain with DragMotion.
  class DragFeedback {
    constructor({ start, stop = () => {}, idle = () => {}, available = () => true, changed = () => {} }) {
      Object.assign(this, { start, stop, idle, available, changed });
      this.phase = 'idle'; this.serial = 0;
      this.counters = { started: 0, released: 0, completed: 0, cancelled: 0, failed: 0 };
    }
    get active() { return this.phase !== 'idle'; }
    get id() { return this.phase === 'hold' ? 'dragHold' : this.phase === 'release' ? 'dragRelease' : null; }
    isCurrent(token, id = this.id) { return this.serial === token && this.active && this.id === id; }
    begin() {
      if (this.phase === 'hold') return false;
      if (!this.available('dragHold')) return false;
      if (this.active) { this.stop(this.id); this.counters.cancelled++; }
      this.counters.started++;
      this._begin('hold'); return true;
    }
    release(normal = true) {
      if (this.phase !== 'hold') return false;
      if (!normal || !this.available('dragRelease')) return this.cancel();
      this.stop(this.id); this.counters.released++;
      this._begin('release'); return true;
    }
    _begin(phase) {
      this.phase = phase;
      const token = ++this.serial, id = this.id;
      this.changed();
      try {
        Promise.resolve(this.start(id, token)).then(ok => {
          if (ok === false && this.isCurrent(token, id)) { this.counters.failed++; this.cancel(); }
        }, () => {
          if (this.isCurrent(token, id)) { this.counters.failed++; this.cancel(); }
        });
      } catch {
        if (this.isCurrent(token, id)) { this.counters.failed++; this.cancel(); }
      }
    }
    complete(id = this.id) {
      if (this.phase !== 'release' || id !== 'dragRelease') return false;
      this.counters.completed++;
      this._finish(); return true;
    }
    cancel() {
      if (!this.active) return false;
      this.counters.cancelled++;
      this._finish(); return true;
    }
    _finish() {
      this.stop(this.id); this.phase = 'idle'; ++this.serial;
      this.idle(); this.changed();
    }
    snapshot() {
      return { phase: this.phase, active: this.active, serial: this.serial, counters: { ...this.counters } };
    }
  }
  return { DragFeedback };
});
