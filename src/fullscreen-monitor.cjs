'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
class FullscreenMonitor {
  constructor({ directory, source, onChange, log }) {
    Object.assign(this, { directory, source, onChange, log });
    this.generation = 0; this.child = null; this.status = 'stopped'; this.error = null;
  }
  async start(handle) {
    this.stop();
    if (process.platform !== 'win32') { this.status = 'unsupported'; return; }
    const generation = this.generation;
    this.status = 'preparing'; this.error = null;
    try {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(this.source)).digest('hex').slice(0, 16);
      fs.mkdirSync(this.directory, { recursive: true });
      const executable = path.join(this.directory, `fullscreen-${hash}.exe`);
      if (!fs.existsSync(executable)) {
        const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
        await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${executable}`, this.source],
          { windowsHide: true, timeout: 20000 });
      }
      if (generation !== this.generation) return;
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      const child = spawn(executable, [hwnd, String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child; this.status = 'starting';
      let buffer = '';
      child.stdout.setEncoding('utf8');
      const timer = setTimeout(() => { if (generation === this.generation && this.status === 'starting') child.kill(); }, 5000);
      child.stdout.on('data', chunk => {
        if (generation !== this.generation) return;
        buffer += chunk;
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) if (line === '0' || line === '1') {
          clearTimeout(timer); this.status = 'running'; this.onChange(line === '1');
        }
      });
      const failed = error => {
        clearTimeout(timer);
        if (generation !== this.generation) return;
        this.child = null; this.status = 'unavailable'; this.error = error;
        this.log(`Fullscreen observer unavailable: ${error}`); this.onChange(false);
      };
      child.once('error', error => failed(error.message));
      child.once('exit', code => failed(`Observer exited (${code})`));
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = 'unavailable'; this.error = error.message;
      this.log(`Fullscreen observer unavailable: ${error.message}`); this.onChange(false);
    }
  }
  stop() {
    ++this.generation;
    if (this.child) this.child.kill();
    this.child = null; this.status = 'stopped'; this.onChange(false);
  }
  snapshot() { return { status: this.status, pid: this.child?.pid ?? null, error: this.error }; }
}
module.exports = { FullscreenMonitor };
