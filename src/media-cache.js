'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetMediaCache = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  // Stable video elements retain their event listeners; cold decoders and
  // canvases are released. Abort plus generation guards invalidate old loads.
  class MediaCache {
    constructor({ entries, load, unload, failed = () => {} }) {
      Object.assign(this, { entries, load, unload, failed }); this.disposed = false;
      for (const entry of Object.values(entries)) Object.assign(entry, { residency: 'unloaded', generation: 0, loads: 0, releases: 0 });
    }
    ensure(id) {
      const entry = this.entries[id];
      if (!entry || this.disposed || entry.failure) return Promise.resolve(false);
      if (entry.residency === 'ready') return Promise.resolve(true);
      if (entry.pending) return entry.pending;
      const generation = ++entry.generation, abort = new AbortController();
      entry.abort = abort; entry.residency = 'loading'; entry.loads++;
      let result;
      try { result = this.load(entry, abort.signal); } catch (error) { result = Promise.reject(error); }
      const pending = Promise.resolve(result).then(() => {
        if (this.disposed || entry.generation !== generation) return false;
        entry.residency = 'ready'; return true;
      }, error => {
        if (entry.generation !== generation || this.disposed || error.name === 'AbortError') return false;
        entry.residency = 'failed'; entry.failure = error.message; this.failed(entry); return false;
      }).finally(() => { if (entry.generation === generation) { entry.pending = null; entry.abort = null; } });
      entry.pending = pending; return pending;
    }
    async prepare(ids) { return (await Promise.all(ids.map(id => this.ensure(id)))).every(Boolean); }
    retain(ids) {
      const keep = new Set(ids);
      for (const entry of Object.values(this.entries)) if (!entry.hot && !keep.has(entry.id)) this.release(entry);
    }
    release(entry) {
      if (entry.residency === 'unloaded') return;
      ++entry.generation; entry.abort?.abort(); entry.abort = null; entry.pending = null;
      entry.residency = 'unloaded'; entry.releases++; this.unload(entry);
    }
    snapshot() {
      const items = Object.values(this.entries).map(entry => ({ id: entry.id, hot: entry.hot, status: entry.residency,
        canvas: Boolean(entry.player), sourceAssigned: Boolean(entry.video?.getAttribute('src')),
        loads: entry.loads, releases: entry.releases, failure: entry.failure }));
      return { total: items.length, resident: items.filter(v => v.canvas).length,
        loading: items.filter(v => v.status === 'loading').length, items };
    }
    dispose() { this.disposed = true; for (const entry of Object.values(this.entries)) this.release(entry); }
  }
  return { MediaCache };
});
