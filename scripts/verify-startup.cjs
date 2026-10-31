'use strict';
// Run from Node to start isolated Electron processes. Faults are injected only
// into this development harness; no test switch or hook ships in the app.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'work', 'startup-regression');
const scenarios = ['normal', 'capture-first', 'capture-warmup', 'renderer-missing', 'poster-missing', 'late-renderer', 'late-capture', 'hidden-warmup'];
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(output, { recursive: true });
  for (const scenario of scenarios) {
    const child = spawnSync(require('electron'), [__filename, scenario], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 22000 });
    process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
    if (child.error || child.status !== 0) { console.error(child.error || `Failed: ${scenario}`); process.exit(1); }
  }
  console.log(`All ${scenarios.length} Electron startup scenarios passed. Reports: ${output}`);
} else {
  const assert = require('node:assert/strict');
  const Module = require('node:module');
  const { app, BrowserWindow, session } = require('electron');
  const scenario = process.argv[2];
  if (!scenarios.includes(scenario)) throw new Error('Unknown startup scenario');
  const profile = path.join(output, scenario, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ avoidFullscreen: false, wanderEnabled: false, randomEnabled: false }));
  const setPath = app.setPath.bind(app);
  app.setPath = (name, value) => setPath(name, name === 'userData' ? profile : value);
  const captures = new Map();
  app.on('web-contents-created', (_event, contents) => {
    const capture = contents.capturePage.bind(contents); captures.set(contents, capture);
    let count = 0;
    contents.capturePage = (...args) => {
      count++;
      if (scenario === 'capture-first' && count === 1) return new Promise(() => {});
      if (['capture-warmup', 'hidden-warmup'].includes(scenario) && count === 2) {
        if (scenario === 'hidden-warmup') global.startupAudit.hide();
        return new Promise(() => {});
      }
      if (scenario === 'late-capture' && count === 1) return new Promise((resolve, reject) => {
        setTimeout(() => capture(...args).then(resolve, reject), 5800);
      });
      return capture(...args);
    };
  });
  app.whenReady().then(() => {
    if (scenario === 'late-renderer') session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      if (details.url.endsWith('/renderer.js')) setTimeout(() => done({ cancel: false }), 6000);
      else done({ cancel: false });
    });
    if (['renderer-missing', 'poster-missing'].includes(scenario)) session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      done({ cancel: details.url.endsWith('/renderer.js') || (scenario === 'poster-missing' && details.url.endsWith('/idle-breathe.png')) });
    });
  });
  const filename = path.join(root, 'src/main.cjs');
  const entry = new Module(filename, module); entry.filename = filename;
  entry.paths = Module._nodeModulePaths(path.dirname(filename));
  entry._compile(fs.readFileSync(filename, 'utf8') + `
global.startupAudit = {
  read: () => ({ rendererReady, fallbackReady, opacity: win.getOpacity(), visible: win.isVisible(),
    startup: startupPresentation.snapshot(), lifecycle: playbackGate.snapshot() }),
  hide: () => setReason('hidden', true),
  show: () => setReason('hidden', false),
  menu: () => menuModel(),
};`, filename);
  app.whenReady().then(() => setTimeout(async () => {
    try {
      const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'));
      const report = { scenario, electron: process.versions.electron, ...global.startupAudit.read() };
      report.dom = await win.webContents.executeJavaScript(`({ fallback: Boolean(document.getElementById('startup-fallback')),
        text: document.getElementById('startup-fallback')?.textContent, renderer: window.petDiagnostics?.() ?? null })`);
      assert.equal(report.opacity, 1);
      assert.equal(report.visible, scenario !== 'hidden-warmup');
      assert.equal(report.startup.phase, scenario === 'normal' ? 'ready' : 'fallback');
      const missingRenderer = ['renderer-missing', 'poster-missing'].includes(scenario);
      assert.equal(report.dom.fallback, missingRenderer);
      assert.equal(report.fallbackReady, missingRenderer || scenario === 'late-renderer');
      assert.equal(report.rendererReady, !missingRenderer);
      assert.ok(global.startupAudit.menu().commands.some(item => item.id === 'restart'));
      if (scenario === 'poster-missing') assert.match(report.dom.text, /人物素材加载失败/);
      if (scenario === 'hidden-warmup') {
        global.startupAudit.show(); assert.equal(global.startupAudit.read().visible, true);
        global.startupAudit.hide(); assert.equal(global.startupAudit.read().visible, false);
      } else {
        const image = await captures.get(win.webContents)(undefined, { stayHidden: true });
        assert.equal(image.isEmpty(), false);
        const pixels = image.toBitmap();
        assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 200), 'Character or fallback error must contain visible pixels');
        fs.writeFileSync(path.join(output, `${scenario}.png`), image.toPNG());
      }
      fs.writeFileSync(path.join(output, `${scenario}.json`), JSON.stringify(report, null, 2));
      console.log(`PASS ${scenario}: phase=${report.startup.phase}, opacity=${report.opacity}, visible=${report.visible}, fallback=${report.dom.fallback}`);
      app.quit();
    } catch (error) { console.error(error.stack); app.exit(1); }
  }, 7200));
  setTimeout(() => { console.error(`Timed out: ${scenario}`); app.exit(2); }, 18000).unref();
}
