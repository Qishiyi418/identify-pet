'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
class DisplayMonitor {
  constructor({ directory, onChange, log }) {
    Object.assign(this, { directory, onChange, log });
    this.generation = 0; this.child = null; this.status = 'stopped'; this.error = null; this.state = null; this.events = 0;
  }
  async start() {
    this.stop();
    if (process.platform !== 'win32') { this.status = 'unsupported'; return; }
    const generation = this.generation;
    this.status = 'preparing'; this.error = null;
    try {
      const source = path.join(__dirname, 'native', 'display-monitor.cs');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
      fs.mkdirSync(this.directory, { recursive: true });
      const executable = path.join(this.directory, `display-${hash}.exe`);
      if (!fs.existsSync(executable)) {
        const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
        await promisify(execFile)(compiler, ['/nologo', '/optimize+', '/target:exe', '/r:System.Windows.Forms.dll', `/out:${executable}`, source],
          { windowsHide: true, timeout: 20000 });
      }
      if (generation !== this.generation) return;
      const child = spawn(executable, [String(process.pid)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child; this.status = 'starting';
      let buffer = '', failed = false;
      const timer = setTimeout(() => { if (generation === this.generation && this.status === 'starting') child.kill(); }, 5000);
      const fail = error => {
        if (generation !== this.generation || failed) return;
        failed = true; clearTimeout(timer); child.kill(); this.child = null; this.status = 'unavailable'; this.error = error;
        this.state = null; this.log(`Display observer unavailable: ${error}`); this.onChange(false);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (generation !== this.generation || failed) return;
        buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) {
          if (line === 'ready') { clearTimeout(timer); this.status = 'running'; }
          else if (/^display:[012]$/.test(line)) {
            this.state = Number(line.at(-1)); this.events++;
            // Dimmed remains usable and must clear an earlier display-off gate.
            this.onChange(this.state === 0);
          } else if (line.startsWith('error:')) fail(line.slice(6));
        }
      });
      child.once('error', error => fail(error.message)); child.once('exit', code => fail(`Observer exited (${code})`));
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = 'unavailable'; this.error = error.message;
      this.log(`Display observer unavailable: ${error.message}`); this.onChange(false);
    }
  }
  stop() {
    ++this.generation; if (this.child) this.child.kill();
    this.child = null; this.status = 'stopped'; this.state = null; this.onChange(false);
  }
  snapshot() { return { status: this.status, pid: this.child?.pid ?? null, state: this.state, events: this.events, error: this.error }; }
}
module.exports = { DisplayMonitor };
