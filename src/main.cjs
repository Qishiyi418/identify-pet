'use strict';
const { app, BrowserWindow, ipcMain, Tray, nativeImage, nativeTheme, screen, dialog, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const config = require('../config/runtime.json');
const movement = require('../config/movement.json');
const { sanitizeSettings, activityIdleChoices, roamingArea, geometry, constrain, resizeAtFeet, movementBody, recoverPosition } = require('./runtime.cjs');
const { DragMotion } = require('./drag-motion.cjs');
const { WanderMotion } = require('./wander-motion.cjs');
const { FlightMotion } = require('./flight-motion.cjs');
const { PlaybackGate } = require('./playback-gate.cjs');
const { FullscreenMonitor } = require('./fullscreen-monitor.cjs');
const { DisplayMonitor } = require('./display-monitor.cjs');
const { StartupPresentation } = require('./startup-presentation.cjs');
const root = path.resolve(__dirname, '..');
// Installed builds keep videos, posters and the native observer sources outside
// app.asar (asarUnpack in package.json), so the player and csc.exe read plain files.
const unpackedRoot = app.isPackaged ? root.replace(/\.asar$/, '.asar.unpacked') : root;
const nativeSource = name => path.join(unpackedRoot, 'src', 'native', name);
const diagnostics = process.argv.includes('--diagnostics');

app.setName(config.title);
app.setAppUserModelId(config.appId);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Match the working Windows baseline: GPU composition can leave layered
// transparent windows blank on this system. This affects only this app.
if (process.platform === 'win32') app.disableHardwareAcceleration();
app.setPath('userData', path.join(app.getPath('appData'), config.dataDirectory));
app.setPath('sessionData', path.join(app.getPath('userData'), 'chromium'));

let win, tray, trayClickTimer, pointerTimer, diagnosticsTimer, saveTimer;
let speechWin, speechReady, speechTimer, speechText = '', speechBelow = false, speechRevision = 0;
let settingsWin;
let menuWin, menuReady, menuPoint, menuFocusTimer, menuToken = 0;
const MENU_MARGIN = 12; // transparent edge around the menu card, matching body padding in menu.css
let settingsResizeAnchor;
let settings, size, paused = false, ignored = false, menuOpen = false;
let displayAreas = [], displayBounds = [];
let shuttingDown = false, rendererReady = false, lastCursor = null, interactionBusy = false, hovered = false;
let wanderMotion, flightMotion, savedTopPadding = config.idle.topPadding ?? 0;
let startupPresentation, firstPagePainted = false;
const playbackGate = new PlaybackGate();
const systemListeners = [];
const fullscreenMonitor = new FullscreenMonitor({
  directory: path.join(app.getPath('userData'), 'native-tools'), source: nativeSource('fullscreen-monitor.cs'), log,
  onChange: value => setReason('fullscreen', value),
});
const displayMonitor = new DisplayMonitor({ directory: path.join(app.getPath('userData'), 'native-tools'),
  source: nativeSource('display-monitor.cs'), log,
  onChange: value => setReason('display-off', value) });
const dragMotion = new DragMotion({
  readCursor: () => screen.getCursorScreenPoint(), readBounds: () => win.getBounds(),
  // Electron/Windows can accumulate DIP rounding when setPosition carries
  // forward the previous native size. Supply the fixed content size each time.
  move: (x, y) => win.setBounds({ x, y, width: size.width, height: size.height }, false),
});
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const logFile = path.join(app.getPath('userData'), 'runtime.log');
fs.mkdirSync(app.getPath('userData'), { recursive: true });

function log(message) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512000) fs.renameSync(logFile, logFile + '.previous');
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch { /* A read-only profile must not crash the pet. */ }
}

try {
  const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings = sanitizeSettings(stored, config);
  savedTopPadding = Number.isFinite(stored.viewportTopPadding) ? stored.viewportTopPadding : 0;
}
catch { settings = sanitizeSettings(null, config); }

function saveNow() {
  clearTimeout(saveTimer);
  if (win && !win.isDestroyed()) {
    const { x, y } = win.getBounds();
    settings.position = { x, y };
  }
  try {
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify({ ...settings, viewportTopPadding: config.idle.topPadding ?? 0 }, null, 2));
    fs.renameSync(settingsFile + '.tmp', settingsFile);
  } catch (error) { log(`Settings save failed: ${error.message}`); }
}
function queueSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
const areas = () => displayAreas;
function refreshAreas() {
  const displays = screen.getAllDisplays();
  displayAreas = displays.map(display => display.workArea);
  displayBounds = displays.map(display => display.bounds);
}
const body = () => movementBody(size, config.idle, movement);
const flightBody = () => {
  const bounds = config.flight.visibleBounds, offset = config.flight.offsetY ?? 0;
  return movementBody(size, config.idle, { visibleBounds: [Math.min(bounds[0], movement.visibleBounds[0]),
    Math.min(bounds[1] + offset, movement.visibleBounds[1]), Math.max(bounds[2], movement.visibleBounds[2]),
    Math.max(bounds[3] + offset, movement.visibleBounds[3])] });
};
const recoverBounds = bounds => recoverPosition(bounds, displayBounds, body());
// Automatic movement stays near the place the user last chose (drag, reset,
// resize or display recovery); manual placement itself remains unrestricted.
function rememberHome() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds(); settings.home = { x, y };
}
function motionAreas(readBody) {
  return () => {
    if (!settings.roamNearHome || !displayAreas.length) return areas();
    const { area, home } = roamingArea(settings.home, win.getBounds(), readBody(), displayAreas, size.scale);
    settings.home = home; return [area];
  };
}
// Login items point at this project's Electron runtime in the development layout.
const loginItem = () => app.isPackaged ? {} : { path: process.execPath, args: [root.includes(' ') ? `"${root}"` : root] };
function launchAtLogin() {
  try { return app.getLoginItemSettings(loginItem()).openAtLogin; } catch { return false; }
}
function setLaunchAtLogin(value) {
  try { app.setLoginItemSettings({ openAtLogin: Boolean(value), ...loginItem() }); }
  catch (error) { log(`Login item update failed: ${error.message}`); }
}

function model() {
  const clip = value => ({ ...value,
    file: pathToFileURL(path.join(unpackedRoot, value.file)).href,
    poster: pathToFileURL(path.join(unpackedRoot, value.poster)).href });
  return { title: config.title, height: settings.height, size,
    ...playbackGate.snapshot(), actionPolicy: config.actionPolicy, alwaysOnTop: settings.alwaysOnTop,
    wanderEnabled: settings.wanderEnabled,
    conditionalRandomEnabled: settings.conditionalRandomEnabled,
    randomActions: { rules: settings.randomActions, timeProfiles: config.randomPolicy.timeProfiles },
    flight: config.flight ? clip(config.flight) : null,
    hover: config.hover ? { ...config.hover, greetEnabled: settings.hoverGreetingEnabled, enabled: true, greet: clip(config.hover.greet), fall: clip(config.hover.fall) } : null,
    activityIdleMs: settings.activityIdleSec * 1000,
    activitySchedulingEnabled: settings.randomEnabled,
    activities: config.activities ? { ...config.activities, items: config.activities.items.map(item =>
      item.type === 'group' ? { ...item, start: clip(item.start), loop: clip(item.loop), end: clip(item.end) }
        : { ...item, segment: clip(item.segment) }) } : null,
    dragFeedback: config.dragFeedback ? { hold: clip(config.dragFeedback.hold), release: clip(config.dragFeedback.release) } : null,
    idle: { ...config.idle,
      file: pathToFileURL(path.join(unpackedRoot, config.idle.file)).href,
      poster: pathToFileURL(path.join(unpackedRoot, config.idle.poster)).href },
    headTouch: { ...config.headTouch,
      file: pathToFileURL(path.join(unpackedRoot, config.headTouch.file)).href,
      poster: pathToFileURL(path.join(unpackedRoot, config.headTouch.poster)).href },
    run: { ...config.run, file: pathToFileURL(path.join(unpackedRoot, config.run.file)).href,
      poster: pathToFileURL(path.join(unpackedRoot, config.run.poster)).href },
    bodyTouch: { ...config.bodyTouch,
      file: pathToFileURL(path.join(unpackedRoot, config.bodyTouch.file)).href,
      poster: pathToFileURL(path.join(unpackedRoot, config.bodyTouch.poster)).href } };
}
function send(channel, value) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}
function hideSpeech() {
  ++speechRevision; clearTimeout(speechTimer); speechText = '';
  if (speechWin && !speechWin.isDestroyed()) speechWin.hide();
}
function positionSpeech() {
  if (!win || win.isDestroyed() || !speechWin || speechWin.isDestroyed() || !speechText) return;
  const bounds = win.getBounds();
  const anchor = { x: Math.round(bounds.x + size.anchorX), y: Math.round(bounds.y + size.footY) };
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  const width = 270, height = 104;
  const above = bounds.y + (config.idle.foot[1] - config.idle.visibleHeight - config.idle.viewport.y + (config.idle.topPadding ?? 0)) * size.scale - height - 4;
  speechBelow = above < area.y;
  const desiredY = speechBelow ? bounds.y + size.footY + 5 : above;
  const x = Math.round(Math.max(area.x, Math.min(anchor.x - width / 2, area.x + area.width - width)));
  const y = Math.round(Math.max(area.y, Math.min(desiredY, area.y + area.height - height)));
  speechWin.setBounds({ x, y, width, height }, false);
  speechWin.webContents.send('pet:speech-message', { text: speechText, below: speechBelow, revision: speechRevision });
}
async function showSpeech(value) {
  if (value === null) { hideSpeech(); return; }
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 120 ||
      paused || !win?.isVisible() || menuOpen || dragMotion.active) return;
  const revision = ++speechRevision;
  clearTimeout(speechTimer); speechText = value.text;
  await speechReady;
  if (revision !== speechRevision || shuttingDown || !speechWin || speechWin.isDestroyed()) return;
  positionSpeech(); speechWin.showInactive();
  const duration = Number.isFinite(value.durationMs) ? Math.max(1000, Math.min(value.durationMs, 12000)) : 7200;
  speechTimer = setTimeout(hideSpeech, duration);
}
function sync() {
  send('pet:state', model()); updateTray();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('pet:settings-state', settingsModel());
}
function applyPlaybackGate() {
  const state = playbackGate.snapshot(); paused = state.paused;
  if (!win || win.isDestroyed() || shuttingDown) return;
  if (paused) wanderMotion?.interrupt('paused');
  if (paused) flightMotion?.interrupt('paused');
  if (paused || !state.visible) hideSpeech();
  if (!state.visible) { endDrag(); win.hide(); }
  else if (rendererReady) {
    if (startupPresentation?.finished) {
      if (!win.isVisible()) { win.showInactive(); lastCursor = null; }
    } else if (startupPresentation && !startupPresentation.pending) {
      startupPresentation.present().then(shown => { if (shown) applyPlaybackGate(); }).catch(error => {
        // Showing without the transparency warmup risks a brief dark frame, but
        // is better than a pet which never appears and leaves only a tray icon.
        log(`Startup presentation failed: ${error.message}; showing without warmup`);
        if (startupPresentation.fallback()) { win.setOpacity(1); applyPlaybackGate(); }
      });
    }
  }
  sync(); send('pet:visibility', state.visible);
}
function setReason(reason, value) {
  if (playbackGate.set(reason, value)) applyPlaybackGate();
}
function setIgnored(value) {
  const next = Boolean(value) && !dragMotion.active && !menuOpen;
  if (!win || win.isDestroyed() || next === ignored) return;
  ignored = next;
  // Forward hover promptly; global cursor polling also restores input if the
  // Windows forwarding hook stops delivering movement.
  win.setIgnoreMouseEvents(next, { forward: true });
}
const validPoint = point => point && typeof point.x === 'number' && Number.isFinite(point.x) &&
  typeof point.y === 'number' && Number.isFinite(point.y) && Math.abs(point.x) < 100000 && Math.abs(point.y) < 100000;
function endDrag(point) {
  if (!dragMotion.active) return;
  if (!dragMotion.finish(validPoint(point) ? point : screen.getCursorScreenPoint())) return;
  send('pet:dragging', false);
  rememberHome(); queueSave();
  lastCursor = null;
}
function resetPosition() {
  wanderMotion?.interrupt('reset-position');
  flightMotion?.interrupt('reset-position');
  endDrag();
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds(constrain({ x: area.x + area.width - size.width - 48,
    y: area.y + area.height - size.height - 8, width: size.width, height: size.height }, areas()));
  rememberHome(); applyPlaybackGate();
  queueSave();
  lastCursor = null;
}
function setHeight(height, anchor) {
  if (typeof height !== 'number' || !Number.isFinite(height)) return;
  wanderMotion?.interrupt('resize');
  flightMotion?.interrupt('resize');
  endDrag();
  const next = sanitizeSettings({ ...settings, height }, config);
  const nextSize = geometry(next.height, config.idle);
  const bounds = resizeAtFeet(win.getBounds(), size, nextSize);
  if (anchor) { bounds.x = Math.round(anchor.x - nextSize.anchorX); bounds.y = Math.round(anchor.y - nextSize.footY); }
  settings = next;
  size = nextSize;
  win.setBounds(recoverBounds(bounds));
  rememberHome(); sync(); queueSave(); lastCursor = null; positionSpeech();
}
function setPaused(value) { setReason('user', value); }
function setAvoidFullscreen(value) {
  settings.avoidFullscreen = Boolean(value);
  if (settings.avoidFullscreen) fullscreenMonitor.start(win.getNativeWindowHandle());
  else fullscreenMonitor.stop();
  sync(); queueSave();
}
function setWanderEnabled(value) {
  settings.wanderEnabled = Boolean(value); wanderMotion?.setEnabled(settings.wanderEnabled);
  if (!settings.wanderEnabled && !flightMotion?.plan?.manual) flightMotion?.interrupt('disabled');
  sync(); queueSave();
}
function setTop(value) {
  settings.alwaysOnTop = Boolean(value);
  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  speechWin?.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  settingsWin?.setAlwaysOnTop(settings.alwaysOnTop);
  sync(); queueSave();
}
function toggleVisible() {
  wanderMotion?.interrupt('visibility');
  flightMotion?.interrupt('visibility');
  endDrag();
  setReason('hidden', !playbackGate.snapshot().userHidden);
}
function menuModel() {
  const gate = playbackGate.snapshot();
  const movable = !paused && rendererReady && Boolean(win?.isVisible());
  return {
    quick: [
      { id: 'head-touch', label: '摸摸头', icon: 'cap', enabled: !paused },
      { id: 'body-touch', label: '互动回应', icon: 'heart', enabled: !paused },
      { id: 'run', label: '走两步', icon: 'shoe', enabled: movable },
      ...(config.flight ? [{ id: 'flight-up', label: '撑伞上升', icon: 'rise', enabled: movable },
        { id: 'flight-down', label: '撑伞下降', icon: 'fall', enabled: movable }] : []),
    ],
    activities: (config.activities?.items ?? []).map(({ id, label }) => ({ id: `ambient:${id}`, label, enabled: !paused })),
    toggles: [
      { id: 'pause', label: '暂停动画', icon: 'pause', checked: gate.userPaused },
      { id: 'hide', label: '隐藏桌宠', icon: 'eye', checked: gate.userHidden },
    ],
    commands: [
      { id: 'settings', label: '桌宠设置…', icon: 'sliders' },
      { id: 'reset-position', label: '放回屏幕右下角', icon: 'corner' },
      { id: 'quit', label: '退出', icon: 'power', quiet: true },
    ],
  };
}
function chooseMenuItem(id) {
  const model = menuModel();
  const item = [...model.quick, ...model.activities, ...model.toggles, ...model.commands].find(entry => entry.id === id);
  closeMenu();
  if (!item || item.enabled === false) return;
  if (id === 'head-touch') send('pet:head-touch');
  else if (id === 'body-touch') send('pet:body-touch');
  else if (id === 'run') send('pet:manual-run');
  else if (id === 'flight-up' || id === 'flight-down') send('pet:manual-flight', { direction: id.slice(7) });
  else if (id.startsWith('ambient:')) send('pet:ambient', { id: id.slice(8) });
  else if (id === 'pause') setPaused(!playbackGate.snapshot().userPaused);
  else if (id === 'hide') toggleVisible();
  else if (id === 'settings') openSettings().catch(error => log(`Settings failed: ${error.message}`));
  else if (id === 'reset-position') resetPosition();
  else if (id === 'quit') app.quit();
}
function beginMenu() {
  if (menuOpen) return;
  wanderMotion?.interrupt('menu');
  flightMotion?.interrupt('menu');
  hideSpeech(); endDrag(); menuOpen = true; setIgnored(false);
  send('pet:input-blocked', true);
}
function endMenu() {
  if (!menuOpen) return;
  menuOpen = false; lastCursor = null;
  // The renderer reports hit changes only. A miss reported while the menu was
  // open was refused by setIgnored, so restore click-through from the latest report.
  setIgnored(!hovered);
  send('pet:input-blocked', false);
}
// The menu is its own transparent window: the page renders and measures the
// card, then the window is placed beside the cursor, flipping at screen edges.
async function popup(point = screen.getCursorScreenPoint()) {
  if (!menuWin || menuWin.isDestroyed() || shuttingDown) return;
  beginMenu();
  const token = ++menuToken; menuPoint = point;
  await menuReady;
  if (token !== menuToken || !menuOpen || menuWin.isDestroyed()) return;
  menuWin.webContents.send('pet-menu:open', { token, model: menuModel() });
}
function placeMenu(token, width, height) {
  if (token !== menuToken || !menuOpen || !menuWin || menuWin.isDestroyed()) return;
  const area = screen.getDisplayNearestPoint(menuPoint).workArea;
  width = Math.min(Math.ceil(width), area.width + MENU_MARGIN * 2);
  height = Math.min(Math.ceil(height), area.height + MENU_MARGIN * 2);
  const left = menuPoint.x + width - MENU_MARGIN > area.x + area.width;
  const up = menuPoint.y + height - MENU_MARGIN > area.y + area.height;
  const x = left ? menuPoint.x - width + MENU_MARGIN : menuPoint.x - MENU_MARGIN;
  const y = up ? menuPoint.y - height + MENU_MARGIN : menuPoint.y - MENU_MARGIN;
  menuWin.setBounds({ width, height,
    x: Math.round(Math.max(area.x - MENU_MARGIN, Math.min(x, area.x + area.width - width + MENU_MARGIN))),
    y: Math.round(Math.max(area.y - MENU_MARGIN, Math.min(y, area.y + area.height - height + MENU_MARGIN))) }, false);
  menuWin.show(); menuWin.moveTop(); menuWin.focus();
  menuWin.webContents.send('pet-menu:show', { token, origin: `${left ? 'right' : 'left'} ${up ? 'bottom' : 'top'}` });
  // Windows can refuse focus right after a tray click; ask once more.
  clearTimeout(menuFocusTimer);
  menuFocusTimer = setTimeout(() => { if (menuOpen && menuWin && !menuWin.isDestroyed() && !menuWin.isFocused()) menuWin.focus(); }, 120);
}
function closeMenu() {
  if (!menuOpen) return;
  ++menuToken; clearTimeout(menuFocusTimer);
  if (menuWin && !menuWin.isDestroyed()) {
    if (menuWin.isVisible()) menuWin.hide();
    menuWin.webContents.send('pet-menu:hide');
  }
  endMenu();
}
function updateTray() {
  if (!tray) return;
  const state = playbackGate.snapshot();
  tray.setToolTip(config.title + (state.userHidden ? '（已隐藏，单击显示）' : state.userPaused ? '（已暂停）' : ''));
}
function trayClicked() {
  // Wait briefly so a double-click toggles visibility without opening the menu first.
  clearTimeout(trayClickTimer);
  trayClickTimer = setTimeout(() => {
    if (!tray) return;
    if (playbackGate.snapshot().userHidden) toggleVisible(); else popup();
  }, 260);
}
function trayDoubleClicked() { clearTimeout(trayClickTimer); toggleVisible(); }
function trusted(event) { return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame; }
function trustedMenu(event) { return menuWin && !menuWin.isDestroyed() && event.sender === menuWin.webContents && event.senderFrame === menuWin.webContents.mainFrame; }

function settingsModel() {
  return { settings: { ...settings, launchAtLogin: launchAtLogin() }, activityIdleChoices, minHeight: config.minHeight, maxHeight: config.maxHeight, defaultHeight: config.defaultHeight,
    timeProfiles: config.randomPolicy.timeProfiles, defaults: config.randomPolicy.defaults,
    actions: [...(config.activities?.items ?? []).map(({ id, label }) => ({ id, label })),
      { id: 'run', label: '走两步' }, { id: 'flight', label: '撑伞移动' }],
  };
}
function trustedSettings(event) {
  return settingsWin && event.sender === settingsWin.webContents && event.senderFrame === settingsWin.webContents.mainFrame;
}
async function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show(); settingsWin.focus(); return settingsWin;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  settingsWin = new BrowserWindow({ title: '桌宠设置', width: Math.min(440, area.width), height: Math.min(700, area.height - 24),
    minWidth: Math.min(390, area.width), minHeight: Math.min(480, area.height - 24),
    show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1a21' : '#f2f1f5', alwaysOnTop: settings.alwaysOnTop, autoHideMenuBar: true,
    icon: path.join(root, 'assets/icons/app.png'),
    webPreferences: { preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const panel = settingsWin;
  panel.setMenu(null);
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  panel.webContents.on('will-navigate', event => event.preventDefault());
  panel.on('closed', () => { if (settingsWin === panel) settingsWin = null; });
  await panel.loadFile(path.join(__dirname, 'settings.html'));
  if (!panel.isDestroyed()) {
    panel.show();
    if (!panel.isVisible()) panel.show();
    panel.focus();
  }
  return panel;
}
function updateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return settingsModel();
  if (typeof patch.height === 'number' && Number.isFinite(patch.height)) {
    const now = performance.now(), bounds = win.getBounds();
    if (!settingsResizeAnchor || now - settingsResizeAnchor.at > 450) {
      settingsResizeAnchor = { x: bounds.x + size.anchorX, y: bounds.y + size.footY };
    }
    settingsResizeAnchor.at = now;
    setHeight(patch.height, settingsResizeAnchor);
  }
  for (const [key, setter] of [['alwaysOnTop', setTop], ['avoidFullscreen', setAvoidFullscreen], ['wanderEnabled', setWanderEnabled]]) {
    if (typeof patch[key] === 'boolean' && patch[key] !== settings[key]) setter(patch[key]);
  }
  if (typeof patch.launchAtLogin === 'boolean') setLaunchAtLogin(patch.launchAtLogin);
  if (typeof patch.hoverGreetingEnabled === 'boolean') settings.hoverGreetingEnabled = patch.hoverGreetingEnabled;
  if (activityIdleChoices.includes(patch.activityIdleSec)) settings.activityIdleSec = patch.activityIdleSec;
  if (typeof patch.roamNearHome === 'boolean' && patch.roamNearHome !== settings.roamNearHome) {
    settings.roamNearHome = patch.roamNearHome;
    if (settings.roamNearHome) rememberHome();
  }
  if (typeof patch.randomEnabled === 'boolean') settings.randomEnabled = patch.randomEnabled;
  if (typeof patch.conditionalRandomEnabled === 'boolean') settings.conditionalRandomEnabled = patch.conditionalRandomEnabled;
  if (patch.randomActions && typeof patch.randomActions === 'object' && !Array.isArray(patch.randomActions)) {
    const rules = Object.fromEntries(Object.entries(config.randomPolicy.defaults).map(([id]) =>
      [id, { ...settings.randomActions[id], ...(patch.randomActions[id] ?? {}) }]));
    settings.randomActions = sanitizeSettings({ ...settings, randomActions: rules }, config).randomActions;
  }
  sync(); queueSave();
  return settingsModel();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, commandLine) => {
    if (!win) return;
    setReason('hidden', false);
    win.setBounds(recoverBounds(win.getBounds()));
    applyPlaybackGate();
    lastCursor = null;
    if (commandLine.includes('--settings')) openSettings().catch(error => log(`Settings failed: ${error.message}`));
  });
  app.whenReady().then(async () => {
    refreshAreas();
    size = geometry(settings.height, config.idle);
    win = new BrowserWindow({ title: config.title, width: size.width, height: size.height,
      frame: false, transparent: true, backgroundColor: '#00000000', show: false, opacity: 0,
      paintWhenInitiallyHidden: true,
      hasShadow: false, resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop, autoHideMenuBar: true,
      icon: path.join(root, 'assets/icons/app.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.setMenu(null);
    speechWin = new BrowserWindow({ width: 270, height: 104, frame: false, transparent: true,
      backgroundColor: '#00000000', show: false, focusable: false, hasShadow: false,
      resizable: false, skipTaskbar: true, alwaysOnTop: settings.alwaysOnTop,
      webPreferences: { preload: path.join(__dirname, 'speech-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    speechWin.setMenu(null); speechWin.setIgnoreMouseEvents(true);
    speechWin.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    speechWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    speechWin.webContents.on('will-navigate', event => event.preventDefault());
    speechReady = speechWin.loadFile(path.join(__dirname, 'speech.html'));
    menuWin = new BrowserWindow({ width: 308, height: 480, frame: false, transparent: true,
      backgroundColor: '#00000000', show: false, hasShadow: false, resizable: false, maximizable: false,
      minimizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'menu-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true } });
    menuWin.setMenu(null); menuWin.setAlwaysOnTop(true, 'screen-saver');
    menuWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    menuWin.webContents.on('will-navigate', event => event.preventDefault());
    menuWin.on('blur', closeMenu);
    menuReady = menuWin.loadFile(path.join(__dirname, 'menu.html'));
    startupPresentation = new StartupPresentation({ window: win,
      allowed: () => rendererReady && playbackGate.snapshot().visible && !shuttingDown,
      painted: () => firstPagePainted });
    win.once('ready-to-show', () => { firstPagePainted = true; applyPlaybackGate(); });
    const available = () => Boolean(win && !win.isDestroyed() && rendererReady && win.isVisible() &&
      !paused && !menuOpen && !dragMotion.active && !interactionBusy && !shuttingDown);
    wanderMotion = new WanderMotion({ readBounds: () => win.getBounds(), readAreas: motionAreas(body),
      readScale: () => size.scale, readBody: body, canStart: manual => available() && !flightMotion?.active && (manual || !hovered), canContinue: available,
      durationMs: config.run.durationSec * 1000, leadInMs: config.run.leadInMs,
      leadOutMs: config.run.leadOutMs ?? 0,
      restMinMs: config.run.restMinMs, restMaxMs: config.run.restMaxMs,
      autoStart: !config.activities,
      move: (x, y) => { win.setBounds({ x, y, width: size.width, height: size.height }, false); lastCursor = null; },
      onStart: payload => send('pet:run', payload),
      onStop: payload => { send('pet:run-stop', payload); lastCursor = null; if (!shuttingDown) queueSave(); },
    });
    flightMotion = new FlightMotion({ readBounds: () => win.getBounds(), readAreas: motionAreas(flightBody),
      readScale: () => size.scale, readBody: flightBody,
      canStart: manual => available() && !wanderMotion.active && (manual || !hovered), canContinue: available,
      durationMs: config.flight.durationSec * 1000, leadInMs: config.flight.leadInMs, leadOutMs: config.flight.leadOutMs,
      move: (x, y) => { win.setBounds({ x, y, width: size.width, height: size.height }, false); lastCursor = null; },
      onStart: payload => send('pet:flight', payload),
      onStop: payload => { send('pet:flight-stop', payload); lastCursor = null; if (!shuttingDown) queueSave(); },
    });
    win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    if (settings.position) win.setBounds(recoverBounds({ ...settings.position,
      y: Math.round(settings.position.y - ((config.idle.topPadding ?? 0) - savedTopPadding) * size.scale),
      width: size.width, height: size.height }));
    else resetPosition();
    if (!settings.home) rememberHome();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.on('render-process-gone', (_event, details) => {
      log(`Renderer stopped: ${details.reason}`); app.quit();
    });
    win.on('blur', endDrag);
    win.on('move', () => { positionSpeech(); if (!dragMotion.active && !wanderMotion.active && !flightMotion.active) queueSave(); });
    win.on('closed', () => { dragMotion.stop(); wanderMotion.dispose(); flightMotion.dispose(); win = null; app.quit(); });
    ipcMain.handle('pet:initialize', event => trusted(event) ? model() : null);
    ipcMain.handle('pet:settings-read', event => trustedSettings(event) ? settingsModel() : null);
    ipcMain.handle('pet:settings-update', (event, patch) => trustedSettings(event) ? updateSettings(patch) : null);
    ipcMain.on('pet:hit', (event, hit) => { if (trusted(event) && typeof hit === 'boolean') { hovered = hit; setIgnored(!hit); } });
    ipcMain.on('pet:speech', (event, value) => { if (trusted(event)) showSpeech(value).catch(error => log(`Speech failed: ${error.message}`)); });
    ipcMain.on('pet:activity', (event, busy) => {
      if (!trusted(event) || typeof busy !== 'boolean') return;
      interactionBusy = busy; if (busy) wanderMotion.interrupt('interaction');
      if (busy) flightMotion.interrupt('interaction');
    });
    ipcMain.on('pet:run-status', (event, id, ready, completed) => {
      if (!trusted(event) || !Number.isInteger(id) || typeof ready !== 'boolean' || typeof completed !== 'boolean') return;
      if (ready) wanderMotion.confirm(id, true);
      else if (wanderMotion.active && wanderMotion.plan.id === id) wanderMotion.stop(completed ? 'completed' : 'renderer-finished');
    });
    ipcMain.on('pet:run-request', (event, manual) => {
      if (trusted(event) && (settings.wanderEnabled || manual === true)) wanderMotion.request(undefined, manual === true);
    });
    ipcMain.on('pet:flight-status', (event, id, ready, completed) => {
      if (!trusted(event) || !Number.isInteger(id) || typeof ready !== 'boolean' || typeof completed !== 'boolean') return;
      if (ready) flightMotion.confirm(id, true);
      else if (flightMotion.active && flightMotion.plan.id === id) flightMotion.stop(completed ? 'completed' : 'renderer-finished');
    });
    ipcMain.on('pet:flight-request', (event, direction, manual) => {
      if (!trusted(event) || (direction !== undefined && direction !== 'up' && direction !== 'down')) return;
      if (settings.wanderEnabled || manual === true) flightMotion.request(direction, manual === true);
    });
    ipcMain.on('pet:drag-start', (event, point, cursor) => {
      // Dragging only moves the window, so it stays available while animation is paused.
      if (!trusted(event) || menuOpen || !win.isVisible() || !validPoint(point)) return;
      wanderMotion.interrupt('drag');
      flightMotion.interrupt('drag');
      hideSpeech();
      const bounds = win.getBounds();
      if (point.x < bounds.x - 4 || point.x > bounds.x + bounds.width + 4 ||
        point.y < bounds.y - 4 || point.y > bounds.y + bounds.height + 4) return;
      if (dragMotion.begin(point, validPoint(cursor) ? cursor : screen.getCursorScreenPoint())) {
        clearTimeout(saveTimer);
        setIgnored(false); send('pet:dragging', true);
      }
    });
    ipcMain.on('pet:drag-end', (event, point) => { if (trusted(event)) endDrag(point); });
    ipcMain.on('pet:menu', event => { if (trusted(event)) popup(); });
    ipcMain.on('pet-menu:measured', (event, token, width, height) => {
      if (trustedMenu(event) && Number.isInteger(token) && Number.isFinite(width) && Number.isFinite(height)) placeMenu(token, width, height);
    });
    ipcMain.on('pet-menu:choose', (event, token, id) => {
      if (trustedMenu(event) && token === menuToken && typeof id === 'string') chooseMenuItem(id);
    });
    ipcMain.on('pet-menu:close', (event, token) => { if (trustedMenu(event) && token === menuToken) closeMenu(); });
    ipcMain.on('pet:ready', event => {
      if (!trusted(event) || rendererReady) return;
      rendererReady = true; applyPlaybackGate(); lastCursor = null;
      wanderMotion.setEnabled(settings.wanderEnabled);
    });
    ipcMain.on('pet:error', (event, message) => {
      if (trusted(event) && typeof message === 'string') log(message.slice(0, 1000));
    });
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/icons/tray.png')));
    tray.setToolTip(config.title);
    tray.on('click', trayClicked);
    tray.on('double-click', trayDoubleClicked);
    tray.on('right-click', () => { clearTimeout(trayClickTimer); popup(); });
    updateTray();
    pointerTimer = setInterval(() => {
      if (!win || win.isDestroyed() || !rendererReady || !win.isVisible() || dragMotion.active) return;
      const cursor = screen.getCursorScreenPoint();
      if (!lastCursor || cursor.x !== lastCursor.x || cursor.y !== lastCursor.y) {
        const bounds = win.getBounds();
        send('pet:pointer', { x: cursor.x - bounds.x, y: cursor.y - bounds.y });
      }
      lastCursor = cursor;
    }, 60);
    const recover = () => {
      wanderMotion.interrupt('display-change');
      flightMotion.interrupt('display-change');
      refreshAreas();
      endDrag(); win.setBounds(recoverBounds(win.getBounds())); rememberHome(); lastCursor = null; queueSave();
    };
    screen.on('display-added', recover);
    screen.on('display-removed', recover);
    screen.on('display-metrics-changed', recover);
    for (const [event, reason, value] of [
      ['lock-screen', 'lock', true], ['unlock-screen', 'lock', false],
      ['suspend', 'suspend', true], ['resume', 'suspend', false],
    ]) {
      const listener = () => setReason(reason, value);
      powerMonitor.on(event, listener); systemListeners.push([event, listener]);
    }
    if (powerMonitor.getSystemIdleState(1) === 'locked') setReason('lock', true);
    displayMonitor.start();
    if (settings.avoidFullscreen) fullscreenMonitor.start(win.getNativeWindowHandle());
    await win.loadFile(path.join(__dirname, 'index.html'));
    if (process.argv.includes('--settings')) openSettings().catch(error => log(`Settings failed: ${error.message}`));
    log(`Started Electron ${process.versions.electron}; material ${config.idle.materialId}`);
    if (diagnostics) {
      diagnosticsTimer = setInterval(async () => {
        try {
          const renderer = await win.webContents.executeJavaScript('window.petDiagnostics()');
          fs.writeFileSync(path.join(app.getPath('userData'), 'diagnostics.json'), JSON.stringify({
            pid: process.pid, bounds: win.getBounds(), ignored, dragging: dragMotion.active,
            dragMotion: dragMotion.diagnostics(),
            wanderMotion: wanderMotion.diagnostics(),
            flightMotion: flightMotion.diagnostics(),
            movement: { drag: 'free', automatic: 'visible-character', body: body() },
            startup: startupPresentation.snapshot(), opacity: win.getOpacity(),
            paused, visible: win.isVisible(), lifecycle: playbackGate.snapshot(),
            speech: { visible: speechWin?.isVisible() ?? false, text: speechText, below: speechBelow },
            fullscreenMonitor: fullscreenMonitor.snapshot(), settings, renderer,
            displayMonitor: displayMonitor.snapshot(),
          }, null, 2));
        } catch (error) { if (!shuttingDown) log(`Diagnostics unavailable: ${error.message}`); }
      }, 1000);
    }
  }).catch(error => {
    log(error.stack || error.message);
    dialog.showErrorBox(config.title, `桌宠启动失败，详情见运行日志：\n${logFile}`);
    app.exit(1);
  });
}
app.on('before-quit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  settingsWin?.destroy(); settingsWin = null;
  hideSpeech(); speechWin?.destroy(); speechWin = null;
  closeMenu(); menuWin?.destroy(); menuWin = null;
  startupPresentation?.cancel();
  fullscreenMonitor.stop();
  displayMonitor.stop();
  for (const [event, listener] of systemListeners) powerMonitor.removeListener(event, listener);
  wanderMotion?.dispose();
  flightMotion?.dispose();
  if (win && !win.isDestroyed()) endDrag();
  else dragMotion.stop();
  clearInterval(pointerTimer); clearInterval(diagnosticsTimer); clearTimeout(saveTimer); clearTimeout(trayClickTimer);
  saveNow(); tray?.destroy(); tray = null;
});
app.on('window-all-closed', () => app.quit());
