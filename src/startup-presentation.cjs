'use strict';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function inspectTransparentFrame(image) {
  const { width, height } = image.getSize(), bitmap = image.toBitmap();
  if (!width || !height || bitmap.length !== width * height * 4) return { valid: false, width, height };
  const corners = [0, width - 1, (height - 1) * width, width * height - 1].map(index => bitmap[index * 4 + 3]);
  let opaque = 0;
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] > 200) opaque++;
  return { valid: corners.every(alpha => alpha <= 8) && opaque >= 16 && opaque < width * height * .95,
    width, height, corners, opaque };
}
class StartupPresentation {
  constructor({ window, allowed, painted, warmupMs = 120, timeoutMs = 5000, pause = sleep, now = () => performance.now() }) {
    Object.assign(this, { window, allowed, painted, warmupMs, timeoutMs, pause, now });
    this.phase = 'waiting'; this.finished = false; this.pending = null; this.cancelled = false;
    this.frames = []; this.events = []; this.firstFrame = null;
  }
  available() { return !this.cancelled && !this.window.isDestroyed(); }
  present() {
    if (this.pending) return this.pending;
    this.pending = this._present().finally(() => { this.pending = null; });
    return this.pending;
  }
  async capture() {
    const image = await this.window.webContents.capturePage(undefined, { stayHidden: true });
    const stats = inspectTransparentFrame(image); this.frames.push(stats);
    return { image, stats };
  }
  async _present() {
    if (this.finished || !this.available() || !this.allowed()) return false;
    this.phase = 'preparing'; const deadline = this.now() + this.timeoutMs;
    let frame;
    while (this.available() && this.allowed() && this.now() < deadline) {
      if (this.painted()) {
        frame = await this.capture();
        if (frame.stats.valid) break;
      }
      await this.pause(50);
    }
    if (!this.available() || !this.allowed()) { this.phase = 'waiting'; return false; }
    if (!frame?.stats.valid) { this.phase = 'failed'; throw new Error('No transparent character frame before startup timeout'); }
    this.firstFrame = frame.image;
    // Prime the native layered window while it is fully invisible. This keeps
    // Windows' initial compositor surface from appearing as a black rectangle.
    this.window.setOpacity(0); this.window.showInactive();
    if (!this.window.isVisible()) this.window.showInactive();
    this.events.push({ type: 'native-show', opacity: this.window.getOpacity() });
    this.phase = 'warming'; await this.pause(this.warmupMs);
    if (!this.available()) return false;
    frame = await this.capture();
    while (!frame.stats.valid && this.available() && this.allowed() && this.now() < deadline) {
      await this.pause(50);
      if (!this.available()) return false;
      frame = await this.capture();
    }
    if (!this.available()) return false;
    if (!frame.stats.valid) {
      this.window.hide(); this.phase = 'failed';
      throw new Error('Transparent startup frame was lost during native warmup');
    }
    if (!this.allowed()) this.window.hide();
    this.window.setOpacity(1);
    this.events.push({ type: 'reveal', opacity: this.window.getOpacity(), visible: this.window.isVisible() });
    this.finished = true; this.phase = 'ready'; return true;
  }
  // After a failed warmup, let the caller show the window normally instead of
  // retrying forever while the pet stays invisible.
  fallback() {
    if (this.finished || this.pending || !this.available()) return false;
    this.finished = true; this.phase = 'fallback'; this.events.push({ type: 'fallback' }); return true;
  }
  cancel() { this.cancelled = true; }
  snapshot() { return { phase: this.phase, finished: this.finished, frames: this.frames, events: this.events }; }
}
module.exports = { StartupPresentation, inspectTransparentFrame };
