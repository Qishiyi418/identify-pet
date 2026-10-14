'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetFramePresenter = factory();
})(typeof window === 'object' ? window : globalThis, () => {
  // Blend premultiplied alpha in one output. Two independently fading DOM
  // layers make an opaque overlap only 75% opaque at their midpoint.
  class FramePresenter {
    constructor(stage, { durationMs = 100, now = () => performance.now(),
      createCanvas = () => document.createElement('canvas'),
      requestFrame = callback => requestAnimationFrame(callback),
      cancelFrame = id => cancelAnimationFrame(id), pixelRatio = () => window.devicePixelRatio || 1 } = {}) {
      Object.assign(this, { stage, durationMs, now, requestFrame, cancelFrame, pixelRatio });
      this.canvas = createCanvas(); this.previous = createCanvas(); this.incoming = createCanvas();
      this.context = this.canvas.getContext('2d', { alpha: true });
      this.previousContext = this.previous.getContext('2d', { alpha: true });
      this.incomingContext = this.incoming.getContext('2d', { alpha: true });
      if (!this.context || !this.previousContext || !this.incomingContext) throw new Error('无法创建动作交接画布');
      this.canvas.id = 'presentation-canvas'; this.canvas.className = 'pet-presentation';
      this.canvas.setAttribute('aria-hidden', 'true'); stage.appendChild(this.canvas);
      this.target = null; this.currentId = null; this.hasPicture = false;
      this.blending = false; this.frame = null; this.disposed = false;
      this.transitions = 0; this.paints = 0;
    }
    select(entry) { this.target = entry; this.render(); }
    painted(entry) { if (this.target === entry) this.render(); }
    resize() {
      const ratio = this.pixelRatio();
      const width = Math.max(1, Math.round(this.stage.clientWidth * ratio));
      const height = Math.max(1, Math.round(this.stage.clientHeight * ratio));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        for (const canvas of [this.canvas, this.previous, this.incoming]) { canvas.width = width; canvas.height = height; }
        this.hasPicture = false; this.blending = false;
      }
      return ratio;
    }
    render() {
      const entry = this.target;
      // Keep the last displayed picture while a replacement loads or seeks.
      if (this.disposed || !entry?.player?.hasFrame) return;
      const ratio = this.resize(), time = this.now();
      if (entry.id !== this.currentId) {
        this.blending = this.hasPicture;
        if (this.blending) {
          this.previousContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.previousContext.drawImage(this.canvas, 0, 0);
          this.transitions++;
        }
        this.startedAt = time; this.currentId = entry.id;
      }
      const context = this.incomingContext, style = entry.video.style;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const left = parseFloat(style.left) || 0, top = parseFloat(style.top) || 0;
      const width = parseFloat(style.width), height = parseFloat(style.height);
      context.save();
      if (style.transform === 'scaleX(-1)') {
        const anchor = parseFloat(style.transformOrigin) || 0;
        context.translate(left + anchor, top); context.scale(-1, 1);
        context.drawImage(entry.player.canvas, -anchor, 0, width, height);
      } else context.drawImage(entry.player.canvas, left, top, width, height);
      context.restore();
      const progress = this.blending ? Math.min(1, Math.max(0, (time - this.startedAt) / this.durationMs)) : 1;
      const weight = progress * progress * (3 - 2 * progress);
      const output = this.context;
      output.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (weight < 1) {
        output.globalAlpha = 1 - weight;
        output.drawImage(this.previous, 0, 0);
        output.globalCompositeOperation = 'lighter';
      }
      output.globalAlpha = weight;
      output.drawImage(this.incoming, 0, 0);
      output.globalAlpha = 1; output.globalCompositeOperation = 'source-over';
      this.hasPicture = true; this.paints++;
      this.blending = progress < 1;
      if (this.blending && this.frame === null) this.frame = this.requestFrame(() => { this.frame = null; this.render(); });
      else if (!this.blending && this.frame !== null) { this.cancelFrame(this.frame); this.frame = null; }
    }
    snapshot() {
      return { currentId: this.currentId, targetId: this.target?.id ?? null, blending: this.blending,
        durationMs: this.durationMs, transitions: this.transitions, paints: this.paints,
        hasPicture: this.hasPicture, width: this.canvas.width, height: this.canvas.height };
    }
    dispose() {
      this.disposed = true;
      if (this.frame !== null) this.cancelFrame(this.frame);
      this.frame = null; this.target = null;
      for (const canvas of [this.canvas, this.previous, this.incoming]) canvas.width = canvas.height = 0;
      this.canvas.remove();
    }
  }
  return { FramePresenter };
});
