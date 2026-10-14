'use strict';
const reasons = new Set(['user', 'hidden', 'fullscreen', 'lock', 'suspend', 'display-off']);
class PlaybackGate {
  constructor() { this.reasons = new Set(); }
  set(reason, value) {
    if (!reasons.has(reason)) throw new Error(`Unknown playback reason: ${reason}`);
    const before = this.reasons.has(reason);
    if (value) this.reasons.add(reason); else this.reasons.delete(reason);
    return before !== Boolean(value);
  }
  snapshot() {
    return { paused: this.reasons.size > 0, userPaused: this.reasons.has('user'),
      userHidden: this.reasons.has('hidden'),
      visible: ![...this.reasons].some(reason => reason !== 'user'), pauseReasons: [...this.reasons] };
  }
}
module.exports = { PlaybackGate };
