'use strict';

// Read the OS cursor independently of renderer frame rate and alpha readback.
class DragMotion {
  constructor({ readCursor, readBounds, move, intervalMs = 8,
    now = () => performance.now(), schedule = setInterval, cancel = clearInterval }) {
    Object.assign(this, { readCursor, readBounds, move, intervalMs, now, schedule, cancel });
    this.active = false; this.timer = null; this.stats = null;
  }
  begin(origin, cursor = this.readCursor()) {
    if (this.active) return false;
    this.origin = { ...origin }; this.bounds = { ...this.readBounds() };
    this.position = { x: this.bounds.x, y: this.bounds.y };
    this.startedAt = this.lastSampleAt = this.now();
    this.stats = { requestedIntervalMs: this.intervalMs, samples: 0, updates: 0,
      sampleGapTotalMs: 0, sampleGapCount: 0, maxSampleGapMs: 0, durationMs: 0,
      startBounds: { ...this.bounds }, finalBounds: { ...this.bounds } };
    this.active = true;
    this.update(cursor);
    this.timer = this.schedule(() => { if (this.active) this.update(this.readCursor()); }, this.intervalMs);
    return true;
  }
  update(cursor) {
    if (!this.active || !cursor || !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return;
    const stamp = this.now(), gap = stamp - this.lastSampleAt;
    this.lastSampleAt = stamp; this.stats.samples++;
    if (gap > 0) {
      this.stats.sampleGapTotalMs += gap; this.stats.sampleGapCount++;
      this.stats.maxSampleGapMs = Math.max(this.stats.maxSampleGapMs, gap);
    }
    const next = { ...this.bounds,
      x: Math.round(this.bounds.x + cursor.x - this.origin.x),
      y: Math.round(this.bounds.y + cursor.y - this.origin.y) };
    if (next.x === this.position.x && next.y === this.position.y) return;
    this.move(next.x, next.y, next.width, next.height);
    this.position = { x: next.x, y: next.y }; this.stats.updates++;
    this.stats.finalBounds = next;
  }
  finish(cursor) {
    if (!this.active) return false;
    this.update(cursor || this.readCursor()); // Flush release coordinates even between timer ticks.
    return this.stop();
  }
  stop() {
    if (!this.active) return false;
    this.active = false;
    this.cancel(this.timer); this.timer = null;
    this.stats.durationMs = this.now() - this.startedAt;
    return true;
  }
  diagnostics() {
    return this.stats ? { ...this.stats, active: this.active,
      meanSampleIntervalMs: this.stats.sampleGapCount ? this.stats.sampleGapTotalMs / this.stats.sampleGapCount : 0 } : null;
  }
}
module.exports = { DragMotion };
