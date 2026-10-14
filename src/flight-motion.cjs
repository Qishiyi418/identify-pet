'use strict';
const { nearestArea, contentBounds, contentLimits } = require('./runtime.cjs');

// Z is altitude in desktop DIPs. Each flight has one signed destination;
// interruption leaves the character at its current altitude.
class FlightMotion {
  constructor({ readBounds, readAreas, readScale, readBody, canStart, canContinue,
    move, onStart, onStop, durationMs, leadInMs = 250, leadOutMs = 250,
    now = () => performance.now(), random = Math.random, schedule = setInterval, cancel = clearInterval }) {
    Object.assign(this, { readBounds, readAreas, readScale, readBody, canStart, canContinue,
      move, onStart, onStop, durationMs, leadInMs, leadOutMs, now, random, schedule, cancel });
    this.phase = 'idle'; this.serial = 0; this.timer = null;
    this.completed = 0; this.interrupted = 0; this.last = null;
  }
  get active() { return this.phase !== 'idle'; }
  request(preferredDirection, manual = false) {
    if (this.active || !this.canStart(manual)) return false;
    const origin = { ...this.readBounds() }, body = this.readBody();
    const area = nearestArea(contentBounds(origin, body), this.readAreas());
    const limits = contentLimits(area, body), scale = this.readScale();
    if (limits.maxY < limits.minY) return false;
    const room = { up: Math.max(0, origin.y - limits.minY), down: Math.max(0, limits.maxY - origin.y) };
    const explicit = preferredDirection === 'up' || preferredDirection === 'down';
    let direction = explicit ? preferredDirection : this.random() < .5 ? 'up' : 'down';
    if (!explicit && room[direction] < 24 * scale) direction = direction === 'up' ? 'down' : 'up';
    const distance = Math.min(room[direction], (180 + this.random() * 140) * scale);
    if (distance < 8 * scale) return false;
    const target = { ...origin, y: Math.round(origin.y + (direction === 'up' ? -distance : distance)) };
    this.plan = { id: ++this.serial, direction, manual: Boolean(manual), origin, target, area, body, updates: 0, z: 0 };
    this.phase = 'preparing'; this.preparedAt = this.now();
    this.timer = this.schedule(() => this.tick(), 16);
    this.onStart({ id: this.plan.id, direction, manual: Boolean(manual) });
    return true;
  }
  confirm(id, ready) {
    if (this.phase !== 'preparing' || this.plan.id !== id) return false;
    if (!ready || !this.canContinue()) { this.stop('not-ready'); return false; }
    this.phase = 'flying'; this.startedAt = this.now(); this.position = { ...this.plan.origin };
    return true;
  }
  tick() {
    if (!this.active) return;
    if (!this.canContinue()) { this.stop('unavailable'); return; }
    if (this.phase === 'preparing') {
      if (this.now() - this.preparedAt > 2000) this.stop('decoder-timeout');
      return;
    }
    const elapsed = this.now() - this.startedAt;
    const t = Math.max(0, Math.min(1, (elapsed - this.leadInMs) / Math.max(1, this.durationMs - this.leadInMs - this.leadOutMs)));
    const eased = t * t * (3 - 2 * t), { origin, target } = this.plan;
    const y = Math.round(origin.y + (target.y - origin.y) * eased);
    this.plan.z = origin.y - y;
    if (y !== this.position.y) {
      this.move(origin.x, y); this.position.y = y; this.plan.updates++;
    }
    if (elapsed >= this.durationMs) this.stop('completed');
  }
  stop(reason = 'interrupted') {
    if (!this.active) return false;
    const plan = this.plan; this.phase = 'idle'; this.plan = null;
    this.cancel(this.timer); this.timer = null;
    if (reason === 'completed') this.completed++; else this.interrupted++;
    this.last = { ...plan, reason, stoppedAt: this.now() };
    this.onStop({ id: plan.id, reason }); return true;
  }
  interrupt(reason) { return this.stop(reason); }
  diagnostics() { return { phase: this.phase, completed: this.completed, interrupted: this.interrupted,
    plan: this.plan ? { ...this.plan } : null, last: this.last }; }
  dispose() { this.stop('disposed'); }
}
module.exports = { FlightMotion };
