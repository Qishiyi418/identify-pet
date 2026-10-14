'use strict';
const { nearestArea, contentBounds, contentLimits, constrainContent } = require('./runtime.cjs');

// Window motion waits for the run decoder to be ready. User actions can cancel
// preparation or movement, and stale decoder acknowledgements cannot resume it.
class WanderMotion {
  constructor({ readBounds, readAreas, readScale, readBody, canStart, canContinue, move, onStart, onStop,
    durationMs, leadInMs = 350, leadOutMs = 0, restMinMs = 8000, restMaxMs = 16000, autoStart = true,
    now = () => performance.now(), random = Math.random, schedule = setInterval, cancel = clearInterval }) {
    Object.assign(this, { readBounds, readAreas, readScale, readBody, canStart, canContinue, move, onStart, onStop,
      durationMs, leadInMs, leadOutMs, restMinMs, restMaxMs, autoStart, now, random, schedule, cancel });
    this.enabled = false; this.phase = 'idle'; this.serial = 0; this.timer = null;
    this.completed = 0; this.interrupted = 0; this.last = null;
  }
  arm() { this.nextAt = this.now() + this.restMinMs + this.random() * (this.restMaxMs - this.restMinMs); }
  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled) this.stop('disabled');
    else this.arm();
    if (this.enabled && this.timer == null) this.timer = this.schedule(() => this.tick(), 16);
    if (!this.enabled && this.timer != null) { this.cancel(this.timer); this.timer = null; }
  }
  get active() { return this.phase !== 'idle'; }
  request(preferredDirection, manual = false) {
    if ((!this.enabled && !manual) || this.active || !this.canStart(manual)) return false;
    const bounds = this.readBounds(), areas = this.readAreas();
    const body = this.readBody?.() ?? { x: 0, y: 0, width: bounds.width, height: bounds.height };
    const origin = { ...bounds }, area = nearestArea(contentBounds(bounds, body), areas);
    const limits = contentLimits(area, body);
    if (limits.maxX < limits.minX || limits.maxY < limits.minY) { this.arm(); return false; }
    const scale = this.readScale(), left = Math.max(0, origin.x - limits.minX),
      right = Math.max(0, limits.maxX - origin.x);
    let direction = preferredDirection === 'left' || preferredDirection === 'right'
      ? preferredDirection : this.random() < .5 ? 'left' : 'right';
    if ((direction === 'left' ? left : right) < 40 * scale) direction = direction === 'left' ? 'right' : 'left';
    if (origin.x < limits.minX) direction = 'right';
    else if (origin.x > limits.maxX) direction = 'left';
    const distance = Math.min(direction === 'left' ? left : right,
      (85 + this.random() * 40) * scale * Math.max(1, this.durationMs - this.leadInMs - this.leadOutMs) / 1000);
    if (distance < 8) { this.arm(); return false; }
    const target = constrainContent({ ...origin, x: origin.x + (direction === 'left' ? -distance : distance),
      y: origin.y + (this.random() * 2 - 1) * 90 * scale }, [area], body);
    this.plan = { id: ++this.serial, direction, origin, target, area, body, updates: 0, manual: Boolean(manual) };
    this.phase = 'preparing'; this.preparedAt = this.now();
    if (this.timer == null) this.timer = this.schedule(() => this.tick(), 16);
    this.onStart({ id: this.plan.id, direction, ...(manual ? { manual: true } : {}) }); return true;
  }
  confirm(id, ready) {
    if (this.phase !== 'preparing' || this.plan.id !== id) return false;
    if (!ready || !this.canContinue()) { this.stop('not-ready'); return false; }
    this.phase = 'running'; this.startedAt = this.now();
    this.position = { x: this.plan.origin.x, y: this.plan.origin.y }; return true;
  }
  tick() {
    if (!this.enabled && !this.active) return;
    if (this.active && !this.canContinue()) { this.stop('unavailable'); return; }
    if (this.phase === 'preparing') {
      if (this.now() - this.preparedAt > 2000) this.stop('decoder-timeout');
      return;
    }
    if (this.phase === 'idle') { if (this.enabled && this.autoStart && this.now() >= this.nextAt) this.request(); return; }
    const elapsed = this.now() - this.startedAt;
    const progress = Math.min(1, Math.max(0, (elapsed - this.leadInMs) / Math.max(1, this.durationMs - this.leadInMs - this.leadOutMs)));
    const { origin, target } = this.plan;
    // If a user parked the character partly outside, move inward smoothly from
    // that exact position instead of teleporting to a clamped starting point.
    const next = { ...origin, x: Math.round(origin.x + (target.x - origin.x) * progress),
      y: Math.round(origin.y + (target.y - origin.y) * progress) };
    if (next.x !== this.position.x || next.y !== this.position.y) {
      this.move(next.x, next.y); this.position = next; this.plan.updates++;
    }
    if (elapsed >= this.durationMs) this.stop('completed');
  }
  stop(reason = 'interrupted') {
    if (!this.active) return false;
    const plan = this.plan;
    this.phase = 'idle'; this.plan = null;
    if (reason === 'completed') this.completed++; else this.interrupted++;
    this.last = { ...plan, reason, stoppedAt: this.now() };
    this.arm();
    if (!this.enabled && this.timer != null) { this.cancel(this.timer); this.timer = null; }
    this.onStop({ id: plan.id, reason }); return true;
  }
  interrupt(reason) { if (!this.stop(reason)) this.arm(); }
  diagnostics() { return { enabled: this.enabled, phase: this.phase, completed: this.completed,
    interrupted: this.interrupted, nextInMs: Math.max(0, (this.nextAt ?? this.now()) - this.now()),
    plan: this.plan ? { ...this.plan } : null, last: this.last }; }
  dispose() { this.setEnabled(false); }
}
module.exports = { WanderMotion };
