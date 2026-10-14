'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetActivities = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  const durationMs = segment => {
    if (Number.isFinite(segment?.durationMs)) return segment.durationMs;
    if (Number.isFinite(segment?.durationSec)) return segment.durationSec * 1000;
    if (Number.isFinite(segment?.duration)) return segment.duration * 1000;
    return 0;
  };

  // Fit an integer number of cycles to the remaining real playback budget.
  // Returning rate 1 on an unsuitable short budget preserves natural motion
  // instead of forcing a conspicuous speed change just to meet an exit pose.
  function planLoopExit(options = {}) {
    const { remainingMs = 0, durationSec = 0, exitAtSec = 0, currentTime = 0,
      minRate = .97, maxRate = 1.03 } = options ?? {};
    const remainingSec = Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs / 1000 : null;
    const naturalTarget = remainingSec !== null && Number.isFinite(currentTime) && currentTime >= 0
      ? currentTime + remainingSec : null;
    const fallback = reason => ({ aligned: false, playbackRate: 1,
      targetMediaTime: Number.isFinite(naturalTarget) ? naturalTarget : null,
      cycles: null, exitAtSec: Number.isFinite(exitAtSec) ? exitAtSec : null, remainingSec, reason });
    if (remainingSec === null || !Number.isFinite(durationSec) || durationSec <= 0 ||
      !Number.isFinite(exitAtSec) || exitAtSec < 0 || exitAtSec > durationSec ||
      !Number.isFinite(currentTime) || currentTime < 0 ||
      !Number.isFinite(minRate) || !Number.isFinite(maxRate) || minRate <= 0 || maxRate < minRate) {
      return fallback('invalid-parameters');
    }
    const phase = exitAtSec === durationSec ? 0 : exitAtSec;
    // An exit already reached in this cycle belongs to the next cycle. Never
    // choose a negative rate or seek backwards to the previous matching pose.
    const firstForwardCycle = Math.max(0, Math.floor((currentTime - phase) / durationSec) + 1);
    const cycles = Math.max(firstForwardCycle, Math.round((naturalTarget - phase) / durationSec));
    const targetMediaTime = cycles * durationSec + phase;
    const playbackRate = (targetMediaTime - currentTime) / remainingSec;
    if (!Number.isSafeInteger(cycles) || !Number.isFinite(targetMediaTime) ||
      !Number.isFinite(playbackRate) || targetMediaTime <= currentTime || playbackRate <= 0) {
      return fallback('unrepresentable-target');
    }
    if (playbackRate < minRate || playbackRate > maxRate) return fallback('rate-out-of-bounds');
    return { aligned: true, playbackRate, targetMediaTime, cycles,
      exitAtSec: phase, remainingSec, reason: 'aligned' };
  }

  // Native looping briefly seeks back to the beginning. Correct its measured
  // clock drift throughout playback so many cycles still meet the same pose
  // at the group deadline, without jumping the playhead or changing the budget.
  class LoopExitClock {
    constructor(plan, durationSec, currentTime = 0) {
      this.plan = plan;
      this.durationSec = durationSec;
      this.lastTime = currentTime;
      this.cycles = 0;
      this.mediaTime = currentTime;
      this.minRate = Math.min(.97, plan.playbackRate);
      this.maxRate = Math.max(1.03, plan.playbackRate);
    }

    update(currentTime, remainingMs) {
      if (!Number.isFinite(currentTime) || !Number.isFinite(remainingMs) || remainingMs <= 0) return null;
      if (currentTime < this.lastTime - this.durationSec / 2) this.cycles++;
      this.lastTime = currentTime;
      this.mediaTime = this.cycles * this.durationSec + currentTime;
      const rate = (this.plan.targetMediaTime - this.mediaTime) / (remainingMs / 1000);
      return Math.max(this.minRate, Math.min(this.maxRate, rate));
    }
  }

  // The renderer calls ready(token) after its decoder starts presenting, then
  // ended(token) for a non-looping segment. Every decoder switch gets a fresh
  // token: old ended events, play promises and timer callbacks cannot advance it.
  class ActivitySequencer {
    constructor({ activities = [], idleMs = 15000, groupMs = 30000,
      now = () => performance.now(), setTimeout: schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: unschedule = timer => globalThis.clearTimeout(timer), random = Math.random,
      available = () => true, rules = () => ({}), localTime = () => new Date(),
      onStartActivity = () => {}, onSegment = () => {},
      onComplete = () => {} } = {}) {
      if (!Number.isFinite(idleMs) || idleMs < 0) throw new RangeError('idleMs must be non-negative');
      if (!Number.isFinite(groupMs) || groupMs <= 0) throw new RangeError('groupMs must be positive');
      const ids = new Set();
      for (const activity of activities) {
        if (!activity?.id || ids.has(activity.id)) throw new TypeError('Activities need unique ids');
        ids.add(activity.id);
        if (activity.type === 'group') {
          if (!activity.start || !activity.loop || !activity.end) throw new TypeError('A group needs start, loop and end segments');
          const endMs = durationMs(activity.end);
          if (endMs <= 0 || endMs >= groupMs) throw new RangeError('Group end duration must be shorter than groupMs');
        } else if (activity.type !== 'single' || !activity.segment) {
          throw new TypeError('A single activity needs a segment');
        }
      }
      Object.assign(this, { activities: [...activities], idleMs, groupMs, now,
        schedule, unschedule, random, available, rules, localTime, onStartActivity, onSegment, onComplete });
      this.startedAt = new Map();
      this.current = null;
      this.eligible = false;
      this.disposed = false;
      this.serial = 0;
      this.idleRevision = 0;
      this.idleTimer = null;
      this.segmentTimer = null;
      this.idleSince = null;
      this.lastId = null;
      this.lastCompletion = null;
      this.counters = { started: 0, completed: 0, cancelled: 0, failed: 0 };
    }

    isCurrent(token) { return !this.disposed && this.current?.token === token; }

    setIdle(eligible, reason = 'interrupted') {
      if (this.disposed) return false;
      const next = Boolean(eligible);
      const changed = next !== this.eligible;
      this.eligible = next;
      if (!next) {
        this._clearIdle();
        if (this.current) this._finish(reason);
      } else this._armIdle();
      return changed;
    }

    // Menu previews can start immediately, while honoring the same eligibility
    // and media availability rules as the automatic selection.
    start(id) {
      if (this.disposed || !this.eligible) return false;
      const activity = this.activities.find(item => item.id === id);
      if (!activity || !this._available(activity)) return false;
      this._clearIdle();
      if (this.current) this._finish('replaced');
      // A completion callback may have closed a menu, paused or hidden the pet.
      if (this.disposed || !this.eligible || this.current) return false;
      this._clearIdle();
      this._begin(activity);
      return true;
    }

    ready(token) {
      if (!this.isCurrent(token) || this.current.ready) return false;
      const current = this.current;
      current.ready = true;
      if (!current.cooldownMarked) {
        this.markStarted(current.activity.id);
        current.cooldownMarked = true;
      }
      current.playingSince = this.now();
      if (current.activity.type === 'group' && current.phase !== 'end') {
        const untilEnd = this.groupMs - durationMs(current.activity.end) - current.elapsedMs;
        if (untilEnd <= 0) this._segment('end');
        else this.segmentTimer = this.schedule(() => {
          if (!this.isCurrent(token)) return;
          this.segmentTimer = null;
          this._segment('end');
        }, untilEnd);
      }
      return true;
    }

    ended(token) {
      if (!this.isCurrent(token) || !this.current.ready) return false;
      if (this.current.phase === 'start') this._segment('loop');
      else if (this.current.phase === 'single' || this.current.phase === 'end') this._finish('completed');
      else return false; // Loop transitions are driven by the group deadline.
      return true;
    }

    cancel(reason = 'cancelled') {
      if (this.disposed) return false;
      this._clearIdle();
      const active = Boolean(this.current);
      if (active) this._finish(reason);
      else this._armIdle();
      return active;
    }

    dispose() {
      if (this.disposed) return;
      this.eligible = false;
      this.disposed = true;
      this._clearIdle();
      if (this.current) this._finish('disposed');
    }

    snapshot() {
      const current = this.current;
      const elapsedMs = current ? this._elapsed(current) : 0;
      return {
        activityId: current?.activity.id ?? null,
        phase: current?.phase ?? 'idle',
        segmentToken: current?.token ?? null,
        ready: current?.ready ?? false,
        remainingMs: current?.activity.type === 'group' ? Math.max(0, this.groupMs - elapsedMs) : null,
        elapsedMs,
        nextInMs: this.idleSince === null ? null : Math.max(0, this.idleMs - (this.now() - this.idleSince)),
        idleEligible: this.eligible,
        eligible: this.eligible,
        disposed: this.disposed,
        lastId: this.lastId,
        lastCompletion: this.lastCompletion && { ...this.lastCompletion },
        counters: { ...this.counters },
      };
    }

    _available(activity) {
      try { return Boolean(this.available(activity)); } catch { return false; }
    }

    markStarted(id) { this.startedAt.set(id, this.now()); }

    refreshPolicy() {
      if (this.current || this.disposed) return;
      this._clearIdle(); this._armIdle();
    }

    _rule(activity) {
      try { return this.rules(activity) ?? {}; } catch { return { enabled: false }; }
    }

    _eligible(activity) {
      const rule = this._rule(activity);
      if (!this._available(activity) || this._weight(activity) <= 0) return false;
      const previous = this.startedAt.get(activity.id);
      return previous === undefined || this.now() - previous >= Math.max(0, rule.cooldownMs ?? 0);
    }

    _weight(activity) {
      const rule = this._rule(activity), weight = rule.weight ?? 1;
      if (rule.enabled === false || !Number.isFinite(weight) || weight <= 0) return 0;
      const windows = rule.windows;
      if (windows !== undefined && !Array.isArray(windows)) return 0;
      if (windows?.length) {
        const time = this.localTime(), hour = time.getHours() + time.getMinutes() / 60;
        if (!windows.some(window => {
          if (!Array.isArray(window) || window.length !== 2) return false;
          const [start, end] = window;
          if (![start, end, hour].every(Number.isFinite) || start < 0 || start >= 24 || end < 0 || end > 24) return false;
          return start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end);
        })) return Number.isFinite(rule.offHoursWeight) && rule.offHoursWeight > 0 ? weight * Math.min(1, rule.offHoursWeight) : 0;
      }
      return weight;
    }

    _pool() {
      const pool = this.activities.filter(activity => this._eligible(activity));
      const alternatives = pool.filter(activity => activity.id !== this.lastId);
      return alternatives.length ? alternatives : pool;
    }

    _clearIdle() {
      ++this.idleRevision;
      if (this.idleTimer !== null) this.unschedule(this.idleTimer);
      this.idleTimer = null;
      this.idleSince = null;
    }

    _armIdle() {
      if (this.disposed || !this.eligible || this.current || this.idleTimer !== null) return;
      const revision = ++this.idleRevision;
      this.idleSince = this.now();
      this.idleTimer = this.schedule(() => {
        if (revision !== this.idleRevision || this.disposed || !this.eligible || this.current) return;
        this.idleTimer = null;
        this.idleSince = null;
        const pool = this._pool();
        // Recheck time and cooldown later when every action is excluded.
        // An empty pool never falls back to an ineligible action.
        if (!pool.length) { this._armIdle(); return; }
        const sample = this.random();
        const maximum = Math.max(...pool.map(activity => this._weight(activity)));
        const weights = pool.map(activity => this._weight(activity) / maximum);
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        let position = Math.max(0, Math.min(1 - Number.EPSILON, Number.isFinite(sample) ? sample : 0)) * total;
        const selected = pool.find((_activity, index) => { position -= weights[index]; return position < 0; }) ?? pool.at(-1);
        this._begin(selected);
      }, Math.max(1, this.idleMs));
    }

    _begin(activity) {
      this.lastId = activity.id;
      this.counters.started++;
      this.current = { activity, phase: null, token: ++this.serial,
        segment: null, ready: false, playingSince: null, elapsedMs: 0 };
      const token = this.current.token;
      try { this.onStartActivity(activity, token); }
      catch { if (this.isCurrent(token)) this._finish('failed'); return; }
      if (this.isCurrent(token)) this._segment(activity.type === 'group' ? 'start' : 'single');
    }

    _elapsed(current) {
      return current.elapsedMs + (current.playingSince === null ? 0 : Math.max(0, this.now() - current.playingSince));
    }

    _freeze() {
      if (this.segmentTimer !== null) this.unschedule(this.segmentTimer);
      this.segmentTimer = null;
      if (this.current) {
        this.current.elapsedMs = this._elapsed(this.current);
        this.current.playingSince = null;
      }
    }

    _segment(phase) {
      this._freeze();
      const current = this.current;
      if (!current) return;
      const segment = phase === 'single' ? current.activity.segment : current.activity[phase];
      current.phase = phase;
      current.segment = segment;
      current.token = ++this.serial;
      current.ready = false;
      const token = current.token;
      try {
        const result = this.onSegment(segment, phase, token, current.activity);
        if (result === false) { if (this.isCurrent(token)) this._finish('failed'); }
        else if (result && typeof result.then === 'function') {
          Promise.resolve(result).then(ok => {
            if (ok === false && this.isCurrent(token)) this._finish('failed');
          }, () => { if (this.isCurrent(token)) this._finish('failed'); });
        }
      } catch { if (this.isCurrent(token)) this._finish('failed'); }
    }

    _finish(reason) {
      const current = this.current;
      if (!current) return;
      this._freeze();
      this.current = null;
      ++this.serial;
      this.counters[reason === 'completed' ? 'completed' : reason === 'failed' ? 'failed' : 'cancelled']++;
      this.lastCompletion = { activityId: current.activity.id, reason, elapsedMs: current.elapsedMs };
      try { this.onComplete(current.activity, reason); }
      finally { this._armIdle(); }
    }
  }

  return { ActivitySequencer, planLoopExit, LoopExitClock };
});
