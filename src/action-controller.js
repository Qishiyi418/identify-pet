'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetActions = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  class ActionController {
    constructor({ definitions, start, stop = () => {}, idle = () => {}, available = () => true,
      now = () => performance.now(), maxPending = 1, pendingTtlMs = 1200 }) {
      Object.assign(this, { definitions, start, stop, idle, available, now, maxPending, pendingTtlMs });
      this.current = null; this.pending = []; this.serial = 0; this.blocked = new Set();
    }
    isCurrent(token) { return this.current?.token === token; }
    request(id, trigger = 'click', payload = null) {
      const definition = this.definitions[id];
      if (!definition || this.blocked.size || !this.available(id)) return 'ignored';
      const request = { id, trigger, payload, priority: definition.priority, expires: this.now() + this.pendingTtlMs };
      if (this.current?.id === id && definition.repeat !== 'restart') return 'ignored';
      if (this.current && request.priority < this.current.priority) {
        this.pending = this.pending.filter(item => item.expires > this.now() && item.id !== id);
        this.pending.push(request);
        this.pending.sort((a, b) => b.priority - a.priority);
        this.pending = this.pending.slice(0, this.maxPending);
        return this.pending.includes(request) ? 'queued' : 'ignored';
      }
      const result = this.current?.id === id ? 'restart' : 'start';
      if (this.current && result !== 'restart') this.stop(this.current, false);
      this._begin(request, result);
      return result;
    }
    _begin(request, result) {
      const token = ++this.serial;
      this.current = { ...request, token };
      // Invoke synchronously: a head click must repaint its first frame before
      // pointerup returns, even when the decoder's play promise is pending.
      try {
        Promise.resolve(this.start(this.current, result)).then(ok => {
          if (ok === false && this.isCurrent(token)) this._finish(token, false);
        }, () => { if (this.isCurrent(token)) this._finish(token, false); });
      } catch { this._finish(token, false); }
    }
    complete(token) { return this._finish(token, true); }
    _finish(token, completed) {
      if (!this.isCurrent(token)) return false;
      this.stop(this.current, completed); this.current = null; ++this.serial;
      this.pending = this.pending.filter(item => item.expires > this.now() && this.available(item.id));
      if (!this.blocked.size && this.pending.length) this._begin(this.pending.shift(), 'start');
      else this.idle();
      return true;
    }
    cancel() {
      if (this.current) this.stop(this.current, false);
      this.current = null; this.pending = []; ++this.serial; this.idle();
    }
    setBlocked(reason, value, cancel = false) {
      if (value) this.blocked.add(reason); else this.blocked.delete(reason);
      if (value && cancel) this.cancel();
    }
    snapshot() {
      return { current: this.current?.id ?? 'idle', serial: this.serial,
        pending: this.pending.filter(item => item.expires > this.now()).map(item => item.id), blocked: [...this.blocked] };
    }
  }
  return { ActionController };
});
