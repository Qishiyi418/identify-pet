'use strict';
(async () => {
  const stage = document.getElementById('stage');
  let state = await window.pet.initialize();
  if (!state) return;
  document.title = state.title;
  const { aboveNeck } = window.HeadTouchInput;
  const { ActionController } = window.PetActions;
  const { DragFeedback } = window.PetDragFeedback;
  const { HoverInteractions, GreetingMessages } = window.PetHover;
  const { HoldIntent } = window.PetHold;
  const { MediaCache } = window.PetMediaCache;
  const presenter = new window.PetFramePresenter.FramePresenter(stage);
  const greetingMessages = new GreetingMessages();
  const hoverCounters = { greet: 0, fall: 0 };
  let greeting = null;
  const { ActivitySequencer, planLoopExit, LoopExitClock } = window.PetActivities;
  let dragFeedback;
  let activitySequencer = null, automaticActivities = state.activitySchedulingEnabled, manualActivity = false;
  let activityLoops = 0, dragLoops = 0;
  const activityHistory = [];
  const activityLoopExits = [];
  const counters = { started: 0, restarted: 0, completed: 0, cancelled: 0 };
  const bodyCounters = { started: 0, completed: 0, cancelled: 0 };
  const runCounters = { started: 0, completed: 0, cancelled: 0 };
  let runActive = false, runId = null, runDirection = 'left', activityState;
  let flightActive = false, flightId = null, flightDirection = 'up';
  const flightCounters = { started: 0, completed: 0, cancelled: 0 };
  let fallDirection = 'left';
  let activeId = 'idle', phase = 'idle', switching = 0, down = null, held = false;
  let pixels = null, pointer = null, lastHit = null, ready = false, hidden = false, blocked = false;
  let disposed = false, lastTime = 0, loops = 0, paints = 0, maskTimer, holdTimer = null;
  const holdCounters = { hold: 0, drag: 0 };
  const listeners = [], timers = new Set();
  const on = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  const later = callback => {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) callback(); }, 110);
    timers.add(timer);
  };
  function makeSurface(id, file, poster, loop, existing) {
    const video = existing || document.createElement('video');
    video.id = id === 'idle' ? 'decoder' : `${id}-decoder`;
    video.className = 'pet-surface pet-video-source'; video.muted = true; video.loop = loop;
    video.preload = 'none'; video.setAttribute('playsinline', ''); video.tabIndex = -1;
    if (!existing) stage.appendChild(video);
    return { id, video, file, poster, player: null, context: null, failure: null, hot: !id.startsWith('activity-') };
  }
  const surfaces = {
    idle: makeSurface('idle', state.idle.file, state.idle.poster, true, document.getElementById('decoder')),
    head: makeSurface('head', state.headTouch.file, state.headTouch.poster, false),
    body: makeSurface('body', state.bodyTouch.file, state.bodyTouch.poster, false),
    run: makeSurface('run', state.run.file, state.run.poster, false),
  };
  if (state.flight) surfaces.flight = makeSurface('flight', state.flight.file, state.flight.poster, false);
  for (const id of ['greet', 'fall']) {
    const clip = state.hover?.[id];
    if (clip) surfaces[id] = makeSurface(id, clip.file, clip.poster, false);
  }
  if (state.dragFeedback) {
    surfaces.dragHold = makeSurface('dragHold', state.dragFeedback.hold.file, state.dragFeedback.hold.poster, true);
    surfaces.dragRelease = makeSurface('dragRelease', state.dragFeedback.release.file, state.dragFeedback.release.poster, false);
  }
  const activityItems = state.activities?.items ?? [];
  for (const item of activityItems) {
    const segments = item.type === 'group' ? ['start', 'loop', 'end'] : ['segment'];
    for (const part of segments) {
      const clip = item[part], id = `activity-${item.id}-${part}`;
      surfaces[id] = makeSurface(id, clip.file, clip.poster, part === 'loop');
      surfaces[id].activityId = item.id;
      surfaces[id].activityPhase = part === 'segment' ? 'single' : part;
    }
  }
  function loadSurface(entry, signal) {
    const { video } = entry;
    video.poster = entry.poster;
    entry.player = window.PetVideoCanvas.attach(video, stage, () => presenter.painted(entry));
    entry.player.canvas.id = `${entry.id}-canvas`;
    entry.context = entry.player.canvas.getContext('2d');
    video.preload = 'auto';
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error(`${entry.id} media error ${video.error?.code ?? 'unknown'}`)); };
      const aborted = () => { cleanup(); reject(new DOMException('Media loading cancelled', 'AbortError')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`${entry.id} load timeout`)); }, 15000);
      video.addEventListener('loadeddata', loaded); video.addEventListener('error', failed);
      signal.addEventListener('abort', aborted, { once: true });
      video.src = entry.file; video.load();
    });
  }
  const mediaCache = new MediaCache({ entries: surfaces, load: loadSurface,
    unload: entry => {
      entry.video.pause(); entry.player?.dispose(); entry.player = null; entry.context = null;
      entry.video.removeAttribute('src'); entry.video.removeAttribute('poster');
      entry.video.preload = 'none'; entry.video.load(); entry.video.playbackRate = 1;
      entry.exitClock = null; entry.exitPlan = null;
    },
    failed: entry => { window.pet.error(entry.failure);
      if (entry.activityId && activitySequencer?.current?.activity.id === entry.activityId) activitySequencer.cancel('failed'); },
  });
  const groupIds = id => Object.values(surfaces).filter(entry => entry.activityId === id).map(entry => entry.id);
  function refreshResidency() {
    mediaCache.retain([activeId, ...(activitySequencer?.current ? groupIds(activitySequencer.current.activity.id) : [])]);
  }
  const actions = new ActionController({ ...state.actionPolicy,
    available: id => Boolean(surfaces[id] && !surfaces[id].failure),
    start: activate,
    stop: (request, completed) => {
      actionCounters(request.id)[completed ? 'completed' : 'cancelled']++;
      surfaces[request.id].video.pause();
      if (request.id === 'greet') window.pet.speech(null);
      if (request.id === 'run') {
        runActive = false; runId = null;
        window.pet.runStatus(request.payload.id, false, completed);
      }
      if (request.id === 'flight') {
        flightActive = false; flightId = null;
        window.pet.flightStatus(request.payload.id, false, completed);
      }
    },
    idle: () => { if (!dragFeedback?.active && !activitySequencer?.current) { switching++; phase = 'idle'; select('idle'); playback(); } reportActivity(); },
  });
  dragFeedback = new DragFeedback({
    available: id => Boolean(surfaces[id] && !surfaces[id].failure && !state.paused && !hidden && !blocked),
    start: async (id, token) => {
      const revision = ++switching, entry = surfaces[id];
      entry.player.restartFromFirstFrame();
      select(id); phase = id === 'dragHold' ? 'drag-hold' : 'drag-release';
      const started = await play(entry, () => dragFeedback.isCurrent(token, id) && revision === switching);
      if (!dragFeedback.isCurrent(token, id) || revision !== switching || disposed) return true;
      return started;
    },
    stop: id => surfaces[id]?.video.pause(),
    idle: () => { switching++; phase = 'idle'; select('idle'); playback(); },
    changed: reportActivity,
  });
  if (activityItems.length) activitySequencer = new ActivitySequencer({
    activities: [...activityItems, { id: 'run', type: 'single', segment: { kind: 'run', durationSec: state.run.durationSec } },
      ...(state.flight ? [{ id: 'flight', type: 'single', segment: { kind: 'flight', durationSec: state.flight.durationSec } }] : [])],
    idleMs: state.activities.idleMs, groupMs: state.activities.groupDurationMs,
    rules: item => {
      if (!state.conditionalRandomEnabled) return {};
      const rule = state.randomActions?.rules[item.id];
      if (!rule) return {};
      const profile = state.randomActions.timeProfiles[rule.timeProfile];
      return { ...rule, windows: profile?.windows ?? [], offHoursWeight: profile?.offHoursWeight };
    },
    available: item => item.id === 'flight' ? state.wanderEnabled && !surfaces.flight.failure && !lastHit :
      item.id === 'run' ? state.wanderEnabled && !surfaces.run.failure && !lastHit :
      Object.values(surfaces).filter(entry => entry.activityId === item.id).every(entry => !entry.failure),
    onStartActivity: () => reportActivity(),
    onSegment: activateActivity,
    onComplete: (item, reason) => {
      // Cancellation can happen before play() resolves and before select().
      // Stop every decoder belonging to that item, including a pending one.
      for (const entry of Object.values(surfaces)) if (entry.activityId === item.id) entry.video.pause();
      activityHistory.push({ id: item.id, reason, elapsedMs: activitySequencer.lastCompletion?.elapsedMs ?? 0 });
      if (activityHistory.length > 32) activityHistory.shift();
      if (reason !== 'replaced') manualActivity = false;
      if (activeId.startsWith('activity-') && !dragFeedback.active && !actions.current) {
        switching++; phase = 'idle'; select('idle'); playback();
      }
      if (reason !== 'replaced') reportActivity();
      refreshResidency();
    },
  });
  const hasAction = () => Boolean(actions.current);
  const extraCounters = { greet: { started: 0, completed: 0, cancelled: 0 }, fall: { started: 0, completed: 0, cancelled: 0 } };
  const hover = new HoverInteractions({ ...state.hover,
    trigger: id => {
      if (!state.hover?.enabled || !surfaces[id] || surfaces[id].failure || down || held || state.paused || hidden || blocked) return false;
      if (id === 'greet' && (activeId !== 'idle' || hasAction() || activitySequencer?.current || dragFeedback.active)) return false;
      if (id === 'fall' && (!runActive || actions.current?.id !== 'run')) return false;
      activitySequencer?.setIdle(false, id);
      const result = actions.request(id, 'hover', id === 'fall' ? { direction: runDirection } : null);
      if (result !== 'start') return false;
      hoverCounters[id]++; reportActivity(); return true;
    },
  });
  function actionCounters(id) { return id === 'flight' ? flightCounters : id === 'head' ? counters : id === 'body' ? bodyCounters : extraCounters[id] ?? runCounters; }
  const current = () => surfaces[activeId];
  function reportActivity() {
    activitySequencer?.setIdle(ready && !disposed && !down && !held && !dragFeedback?.active && !hasAction() &&
      !blocked && !hidden && !state.paused && (automaticActivities || manualActivity));
    const busy = Boolean(down || held || dragFeedback?.active || (activitySequencer?.current && !['run', 'flight'].includes(activitySequencer.current.activity.id)) || (actions.current && !['run', 'flight'].includes(actions.current.id)) || blocked || hidden || state.paused || surfaces.run.failure);
    if (busy !== activityState) { activityState = busy; window.pet.activity(busy); }
  }
  function layout() {
    const { scale } = state.size, { viewport } = state.idle;
    for (const entry of Object.values(surfaces)) {
      const clip = entry.id === 'flight' ? state.flight : null;
      entry.video.style.cssText = `width:${(clip?.width ?? 640) * scale}px;height:${(clip?.height ?? 360) * scale}px;left:${-viewport.x * scale}px;top:${((state.idle.topPadding ?? 0) - viewport.y + (clip?.offsetY ?? 0)) * scale}px;opacity:${entry.id === activeId ? 1 : 0}`;
      if ((entry.id === 'run' && state.run.mirrorAllowed && runDirection === 'right') ||
          (entry.id === 'fall' && state.hover.fall.mirrorAllowed && fallDirection === 'right')) {
        entry.video.style.transform = 'scaleX(-1)';
        entry.video.style.transformOrigin = `${state.idle.foot[0] * scale}px 0`;
      }
    }
    presenter.render();
  }
  function select(id) {
    activeId = id;
    // Keep clicks valid on the very frame where a preloaded surface takes over.
    try { pixels = readPixels(surfaces[id]); } catch { pixels = null; }
    lastTime = surfaces[id].video.currentTime;
    lastHit = null; layout(); presenter.select(surfaces[id]);
    // An older fade-out must not pause a new decoder while play()/seek is pending.
    const revision = switching;
    later(() => { if (activeId === id && switching === revision) {
      for (const entry of Object.values(surfaces)) if (entry.id !== id) entry.video.pause();
      refreshResidency();
    } });
  }
  function sourcePoint(point) {
    if (!point) return null;
    let x = point.x / state.size.scale + state.idle.viewport.x;
    if ((activeId === 'run' && state.run.mirrorAllowed && runDirection === 'right') ||
        (activeId === 'fall' && state.hover.fall.mirrorAllowed && fallDirection === 'right')) x = 2 * state.idle.foot[0] - x;
    return { x, y: point.y / state.size.scale + state.idle.viewport.y - (state.idle.topPadding ?? 0) - (activeId === 'flight' ? state.flight.offsetY ?? 0 : 0) };
  }
  function readPixels(entry) {
    if (!entry.player || !entry.context) return new Uint8ClampedArray(0);
    return entry.context.getImageData(0, 0, entry.player.canvas.width, entry.player.canvas.height).data;
  }
  function isHit(point) {
    if (!pixels || !point || point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) return false;
    const source = sourcePoint(point), x = Math.floor(source.x), y = Math.floor(source.y);
    const { width, height } = current().player.canvas;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(height - 1, y + 2); yy++) {
      for (let xx = Math.max(0, x - 2); xx <= Math.min(width - 1, x + 2); xx++) {
        if (pixels[(yy * width + xx) * 4 + 3] >= 24) return true;
      }
    }
    return false;
  }
  function reportHit(point, moved = false, pressed = false) {
    pointer = point;
    const hit = held || isHit(point);
    if (hit !== lastHit) { lastHit = hit; window.pet.hit(hit); }
    hover.update({ hit, moved, pressed: pressed || Boolean(down || held), action: activeId,
      eligible: state.hover?.enabled && ready && phase !== 'switching' && !disposed && !hidden && !state.paused && !blocked && !dragFeedback.active && !activitySequencer?.current });
  }
  async function play(entry, valid = () => current() === entry) {
    if (disposed || hidden || state.paused) return false;
    try {
      if (entry.residency !== 'ready' && !(await mediaCache.ensure(entry.id))) return false;
      if (!valid() || disposed || hidden || state.paused) return false;
      await entry.video.play();
      if (!valid() || disposed || hidden || state.paused) {
        if (current() !== entry || hidden || state.paused) entry.video.pause();
        return false;
      }
      return true;
    }
    catch (error) {
      if (error.name !== 'AbortError' && !disposed) {
        entry.failure = error.message; window.pet.error(`${entry.id}: ${error.message}`);
      }
      return false;
    }
  }
  async function activate(request, result) {
    const { id, token } = request, revision = ++switching, entry = surfaces[id];
    actionCounters(id)[result === 'restart' ? 'restarted' : 'started']++;
    if (id === 'run') { runActive = true; runId = request.payload.id; runDirection = request.payload.direction; }
    if (id === 'flight') { flightActive = true; flightId = request.payload.id; flightDirection = request.payload.direction; }
    if (id === 'fall') fallDirection = request.payload?.direction === 'right' ? 'right' : 'left';
    phase = 'switching'; entry.player.restartFromFirstFrame();
    const started = await play(entry, () => actions.isCurrent(token) && switching === revision);
    if (!actions.isCurrent(token) || switching !== revision || disposed) return false;
    if ((!started && !state.paused) || entry.video.readyState < 2) return false;
    select(id); phase = id === 'head' ? 'full' : id;
    if (id === 'run' || id === 'flight') activitySequencer?.markStarted(id);
    if (id === 'run') window.pet.runStatus(runId, true);
    if (id === 'flight') window.pet.flightStatus(flightId, true);
    if (id === 'greet') {
      greeting = greetingMessages.next();
      window.pet.speech({ text: greeting.text, durationMs: state.hover.speechDurationMs });
    }
    reportActivity();
    return true;
  }
  async function activateActivity(segment, part, token, item) {
    if (item.id === 'run' || item.id === 'flight') {
      queueMicrotask(() => {
        if (!activitySequencer.isCurrent(token)) return;
        activitySequencer.cancel(`${item.id}-transfer`);
        if (item.id === 'flight') window.pet.requestFlight();
        else window.pet.requestRun();
      });
      return true;
    }
    const id = `activity-${item.id}-${part === 'single' ? 'segment' : part}`;
    const entry = surfaces[id], revision = ++switching;
    if (!entry || entry.failure) return false;
    refreshResidency();
    const prepared = await mediaCache.prepare(groupIds(item.id));
    if (!activitySequencer.isCurrent(token) || switching !== revision || disposed) return true;
    if (!prepared || state.paused || hidden || blocked) return false;
    if (part === 'end') {
      const previous = current();
      if (previous.activityId === item.id && previous.activityPhase === 'loop') {
        previous.video.pause();
        if (previous.exitPlan) {
          const duration = previous.video.duration, time = previous.video.currentTime;
          const offset = Math.abs(time - previous.exitPlan.exitAtSec) % duration;
          activityLoopExits.push({ id: item.id, time, duration, phaseErrorSec: Math.min(offset, duration - offset),
            playbackRate: previous.video.playbackRate, plan: { ...previous.exitPlan },
            completedCycles: previous.exitClock?.cycles ?? null, mediaTime: previous.exitClock?.mediaTime ?? null });
          if (activityLoopExits.length > 32) activityLoopExits.shift();
        }
      }
    }
    entry.video.playbackRate = 1; entry.exitPlan = null; entry.exitClock = null;
    entry.segmentToken = token;
    entry.player.restartFromFirstFrame();
    const started = await play(entry, () => activitySequencer.isCurrent(token) && switching === revision);
    if (!activitySequencer.isCurrent(token) || switching !== revision || disposed) return true;
    if (!started || entry.video.readyState < 2) return false;
    if (part === 'loop' && Number.isFinite(segment.exitAtSec)) {
      const remainingMs = activitySequencer.snapshot().remainingMs - item.end.durationSec * 1000;
      entry.exitPlan = planLoopExit({ remainingMs, durationSec: entry.video.duration,
        exitAtSec: segment.exitAtSec, currentTime: entry.video.currentTime,
        minRate: segment.minExitRate ?? .97, maxRate: segment.maxExitRate ?? 1.03 });
      entry.video.playbackRate = entry.exitPlan.playbackRate;
      if (entry.exitPlan.aligned) entry.exitClock = new LoopExitClock(entry.exitPlan, entry.video.duration, entry.video.currentTime);
    }
    select(id); phase = `activity-${part}`;
    activitySequencer.ready(token); reportActivity();
    return true;
  }
  function requestAmbient(payload) {
    if (!activitySequencer || !payload?.id || disposed || hidden || state.paused || held || down) return;
    // A native menu selection closes its menu; permit its command immediately,
    // just as the existing manual touch commands do.
    blocked = false;
    hover.suspend();
    activitySequencer.setIdle(false, 'replaced');
    dragFeedback.cancel(); actions.cancel();
    manualActivity = true;
    activitySequencer.setIdle(true);
    if (!activitySequencer.start(payload.id)) manualActivity = false;
    reportActivity();
  }
  function requestTouch(point, manual = false) {
    const eligible = !disposed && !hidden && !state.paused && !held &&
      (!blocked || manual) && !surfaces.head.failure &&
      (manual || aboveNeck(sourcePoint(point), isHit(point), neckline()));
    if (!eligible) return;
    activitySequencer?.setIdle(false, 'touch');
    dragFeedback.cancel();
    actions.request('head', manual ? 'menu' : 'click');
    reportActivity();
  }
  function neckline() {
    if (activeId === 'flight') return state.flight.necklineY;
    return activeId === 'head' ? state.headTouch.necklineY : state.bodyTouch.necklineY;
  }
  function requestBody(manual = false) {
    if (disposed || hidden || state.paused || held || (blocked && !manual)) return;
    activitySequencer?.setIdle(false, 'touch');
    dragFeedback.cancel();
    actions.request('body', manual ? 'menu' : 'click');
    reportActivity();
  }
  function requestRun(payload) {
    if (!payload || !Number.isInteger(payload.id)) return;
    if (disposed || hidden || state.paused || held || down || blocked || dragFeedback.active || hasAction() || surfaces.run.failure || (!state.wanderEnabled && !payload.manual)) {
      window.pet.runStatus(payload.id, false); return;
    }
    activitySequencer?.setIdle(false, 'run');
    if (actions.request('run', 'wander', payload) !== 'start') window.pet.runStatus(payload.id, false);
    reportActivity();
  }
  function requestManualRun() {
    if (disposed || hidden || state.paused || held || down || surfaces.run.failure) return;
    blocked = false; hover.suspend(); window.pet.speech(null);
    activitySequencer?.setIdle(false, 'manual-run');
    dragFeedback.cancel(); actions.cancel();
    // The busy report precedes the run request on the same IPC connection.
    // Native movement can start after the previous activity has been cleared.
    reportActivity(); window.pet.requestRun(true);
  }
  function requestFlight(payload) {
    if (!payload || !Number.isInteger(payload.id)) return;
    if (disposed || hidden || state.paused || held || down || blocked || dragFeedback.active || hasAction() ||
        !surfaces.flight || surfaces.flight.failure || (!state.wanderEnabled && !payload.manual)) {
      window.pet.flightStatus(payload.id, false); return;
    }
    activitySequencer?.setIdle(false, 'flight');
    if (actions.request('flight', 'flight', payload) !== 'start') window.pet.flightStatus(payload.id, false);
    reportActivity();
  }
  function requestManualFlight(payload) {
    if (disposed || hidden || state.paused || held || down || !surfaces.flight || surfaces.flight.failure) return;
    blocked = false; hover.suspend(); window.pet.speech(null);
    activitySequencer?.setIdle(false, 'manual-flight');
    dragFeedback.cancel(); actions.cancel();
    reportActivity(); window.pet.requestFlight(payload?.direction, true);
  }
  function requestRegion(point) {
    if (!isHit(point)) return;
    if (aboveNeck(sourcePoint(point), true, neckline())) requestTouch(point);
    else requestBody();
  }
  function playback() {
    if (state.paused || hidden) for (const entry of Object.values(surfaces)) entry.video.pause();
    else play(current());
  }
  function sample() {
    if (disposed) return;
    const entry = current(), video = entry.video;
    try {
      // Dragging holds input capture: avoid copying the whole alpha bitmap
      // while Windows is moving the transparent window. Animation still plays.
      if (!held && (!hidden || !ready)) pixels = readPixels(entry);
      if (!ready && pixels.some((value, index) => index % 4 === 3 && value > 200)) { ready = true; window.pet.ready(); }
      if (activeId === 'idle' && video.currentTime < lastTime - .2) loops++;
      if (entry.activityPhase === 'loop' && video.currentTime < lastTime - .2) activityLoops++;
      if (activeId === 'dragHold' && video.currentTime < lastTime - .2) dragLoops++;
      if (entry.exitClock && activitySequencer?.isCurrent(entry.segmentToken) && activitySequencer.current.ready) {
        const remainingMs = activitySequencer.snapshot().remainingMs - activitySequencer.current.activity.end.durationSec * 1000;
        const rate = entry.exitClock.update(video.currentTime, remainingMs);
        if (rate !== null) video.playbackRate = rate;
      }
      if (video.currentTime !== lastTime) paints++;
      lastTime = video.currentTime; reportHit(pointer);
      reportActivity();
    } catch (error) { window.pet.error(`Alpha read failed: ${error.message}`); }
    maskTimer = setTimeout(sample, 60);
  }
  function release(event) {
    if (!down && !held) return;
    clearTimeout(holdTimer); holdTimer = null;
    const intent = event?.type === 'pointerup' ? holdIntent.release() : (holdIntent.cancel(), null);
    const clicked = down && !held && intent !== 'release' && event?.type === 'pointerup';
    const wasHeld = held;
    const runRegion = down?.runRegion;
    down = null; held = false; stage.classList.remove('pressed', 'dragging');
    window.pet.endDrag(event?.type === 'pointerup' ? { x: event.screenX, y: event.screenY } : null);
    if (event?.pointerId !== undefined && stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (wasHeld) dragFeedback.release(event?.type === 'pointerup');
    if (clicked) {
      if (runRegion === 'head') requestTouch(null, true);
      else if (runRegion === 'body') requestBody(true);
      else requestRegion({ x: event.clientX, y: event.clientY });
    }
    lastHit = null; reportHit(pointer);
    reportActivity();
  }
  function beginDragVisual() {
    hover.suspend(); window.pet.speech(null);
    activitySequencer?.setIdle(false, 'drag');
    held = true; stage.classList.add('dragging'); actions.cancel();
    dragFeedback.begin(); reportActivity();
  }
  const holdIntent = new HoldIntent({ onIntent: (intent, cursor) => {
    if (!down || held || disposed || state.paused || hidden || blocked) return;
    clearTimeout(holdTimer); holdTimer = null; holdCounters[intent]++;
    beginDragVisual(); window.pet.startDrag(down, cursor);
  } });
  function armHold() {
    // Recheck the monotonic deadline if a timer fires slightly early.
    holdTimer = setTimeout(() => { holdTimer = null; holdIntent.tick(); if (down && !held) armHold(); },
      Math.max(1, holdIntent.holdMs - (performance.now() - holdIntent.press.at)));
  }
  on(stage, 'pointerdown', event => {
    if (event.button !== 0 || down || disposed || hidden || state.paused || blocked || !isHit({ x: event.clientX, y: event.clientY })) return;
    hover.suspend(); window.pet.speech(null);
    event.preventDefault(); down = { x: event.screenX, y: event.screenY,
      runRegion: runActive || flightActive ? (aboveNeck(sourcePoint({ x: event.clientX, y: event.clientY }), true, flightActive ? state.flight.necklineY : state.run.necklineY) ? 'head' : 'body') : null };
    stage.classList.add('pressed');
    holdIntent.begin(down); armHold(); stage.setPointerCapture(event.pointerId); reportActivity();
  });
  on(stage, 'pointermove', event => {
    reportHit({ x: event.clientX, y: event.clientY }, true, event.buttons !== 0);
    if (down && !held) holdIntent.move({ x: event.screenX, y: event.screenY });
  });
  on(stage, 'pointerup', release); on(stage, 'pointercancel', release);
  on(stage, 'lostpointercapture', release); on(window, 'blur', () => { release(); dragFeedback.cancel(); });
  on(stage, 'contextmenu', event => {
    event.preventDefault(); release(); dragFeedback.cancel(); if (isHit({ x: event.clientX, y: event.clientY })) window.pet.menu();
  });
  on(surfaces.head.video, 'ended', () => {
    if (actions.current?.id === 'head' && activeId === 'head' && surfaces.head.video.ended && !surfaces.head.video.seeking) actions.complete(actions.current.token);
  });
  on(surfaces.body.video, 'ended', () => { if (actions.current?.id === 'body' && activeId === 'body') actions.complete(actions.current.token); });
  on(surfaces.run.video, 'ended', () => { if (actions.current?.id === 'run' && activeId === 'run' && surfaces.run.video.ended) actions.complete(actions.current.token); });
  if (surfaces.flight) on(surfaces.flight.video, 'ended', () => {
    if (actions.current?.id === 'flight' && activeId === 'flight' && surfaces.flight.video.ended) actions.complete(actions.current.token);
  });
  for (const id of ['greet', 'fall']) if (surfaces[id]) on(surfaces[id].video, 'ended', () => {
    if (actions.current?.id === id && activeId === id && surfaces[id].video.ended && !surfaces[id].video.seeking) actions.complete(actions.current.token);
  });
  if (surfaces.dragRelease) on(surfaces.dragRelease.video, 'ended', () => {
    if (activeId === 'dragRelease' && surfaces.dragRelease.video.ended && !surfaces.dragRelease.video.seeking) dragFeedback.complete('dragRelease');
  });
  for (const entry of Object.values(surfaces)) on(entry.video, 'error', () => {
    if (!entry.video.hasAttribute('src')) return;
    entry.failure = `${entry.id} media error ${entry.video.error?.code ?? 'unknown'}`;
    window.pet.error(entry.failure); if (actions.current?.id === entry.id) actions.cancel();
    if (activeId === entry.id && dragFeedback.active) dragFeedback.cancel();
    if (entry.activityId && activitySequencer?.current?.activity.id === entry.activityId) activitySequencer.cancel('failed');
    reportActivity();
  });
  for (const entry of Object.values(surfaces).filter(value => value.activityId)) on(entry.video, 'ended', () => {
    if (activeId === entry.id && entry.video.ended && !entry.video.seeking) activitySequencer.ended(entry.segmentToken);
  });
  listeners.push(window.pet.onState(next => {
    const policyChanged = next.conditionalRandomEnabled !== state.conditionalRandomEnabled || JSON.stringify(next.randomActions) !== JSON.stringify(state.randomActions);
    state = next;
    automaticActivities = state.activitySchedulingEnabled;
    if (policyChanged) activitySequencer?.refreshPolicy();
    if (state.paused) { hover.suspend(); window.pet.speech(null); release(); dragFeedback.cancel(); }
    actions.setBlocked('paused', state.paused); layout(); playback(); reportActivity();
  }));
  listeners.push(window.pet.onPointer(point => reportHit(point, true)));
  listeners.push(window.pet.onDragging(value => { actions.setBlocked('drag', value, value); if (!value && held) release(); }));
  listeners.push(window.pet.onVisibility(visible => {
    hidden = !visible;
    if (hidden) { hover.suspend(); window.pet.speech(null); release(); dragFeedback.cancel(); }
    actions.setBlocked('hidden', hidden, hidden); playback(); reportActivity();
  }));
  listeners.push(window.pet.onInputBlocked(value => {
    blocked = Boolean(value);
    if (blocked) { hover.suspend(); window.pet.speech(null); release(); dragFeedback.cancel(); }
    reportActivity();
  }));
  listeners.push(window.pet.onRun(requestRun));
  listeners.push(window.pet.onManualRun(requestManualRun));
  listeners.push(window.pet.onFlight(requestFlight));
  listeners.push(window.pet.onManualFlight(requestManualFlight));
  listeners.push(window.pet.onFlightStop(payload => {
    if (actions.current?.id !== 'flight' || flightId !== payload?.id) return;
    if (payload.reason === 'completed') actions.complete(actions.current.token);
    else actions.cancel();
    reportActivity();
  }));
  listeners.push(window.pet.onRunStop(payload => {
    if (actions.current?.id !== 'run' || runId !== payload?.id) return;
    if (payload.reason === 'completed') actions.complete(actions.current.token); else actions.cancel();
  }));
  listeners.push(window.pet.onHeadTouch(() => requestTouch(null, true)));
  listeners.push(window.pet.onBodyTouch(() => requestBody(true)));
  listeners.push(window.pet.onAmbient(requestAmbient));
  window.petDiagnostics = () => {
    const entry = current(), video = entry.video;
    return { currentTime: video.currentTime, duration: video.duration, paused: video.paused, muted: video.muted,
      activeFile: video.currentSrc, colorMatchVersion: state.headTouch.colorVariant ?? null,
      ready, loops, paints, hidden, blocked, failure: surfaces.idle.failure, headFailure: surfaces.head.failure,
      bodyFailure: surfaces.body.failure, runFailure: surfaces.run.failure,
      flightFailure: surfaces.flight?.failure ?? null, flightReady: surfaces.flight?.video.readyState >= 2,
      flightDirection, flightActive, flightCounters: { ...flightCounters }, flightFile: surfaces.flight?.video.currentSrc,
      activity: activitySequencer ? { ...activitySequencer.snapshot(), ...activitySequencer.counters } : null,
      activityHistory: [...activityHistory], activityLoops, dragLoops,
      activityLoopExits: [...activityLoopExits], loopExitPlan: entry.exitPlan ?? null, playbackRate: video.playbackRate,
      activityAvailable: Object.values(surfaces).filter(entry => entry.activityId).every(entry => !entry.failure),
      activityReady: Object.values(surfaces).filter(entry => entry.activityId).every(entry => entry.video.readyState >= 2),
      mediaCache: mediaCache.snapshot(),
      presentation: presenter.snapshot(),
      conditionalRandomEnabled: state.conditionalRandomEnabled,
      activityFailures: Object.values(surfaces).filter(entry => entry.activityId).map(entry => entry.failure),
      dragFeedback: dragFeedback.snapshot(),
      dragReady: Boolean(surfaces.dragHold?.video.readyState >= 2 && surfaces.dragRelease?.video.readyState >= 2),
      dragFailures: { hold: surfaces.dragHold?.failure ?? null, release: surfaces.dragRelease?.failure ?? null },
      dragHeld: held, dragDown: Boolean(down), holdCounters: { ...holdCounters },
      dragHoldLoop: surfaces.dragHold?.video.loop ?? false,
      dragHoldPaused: surfaces.dragHold?.video.paused ?? true, dragReleasePaused: surfaces.dragRelease?.video.paused ?? true,
      activeAction: activeId, phase, counters: { ...counters }, bodyCounters: { ...bodyCounters }, runCounters: { ...runCounters },
      hover: hover.snapshot(), hoverCounters: { ...hoverCounters }, greeting,
      greetReady: surfaces.greet?.video.readyState >= 2, fallReady: surfaces.fall?.video.readyState >= 2,
      greetFile: surfaces.greet?.video.currentSrc, greetNormalization: state.hover?.greet.normalization ?? null,
      greetFailure: surfaces.greet?.failure ?? null, fallFailure: surfaces.fall?.failure ?? null,
      fallDirection, fallTransform: surfaces.fall ? getComputedStyle(surfaces.fall.player.canvas).transform : null,
      runReady: surfaces.run.video.readyState >= 2, runPaused: surfaces.run.video.paused, runDirection,
      runFile: surfaces.run.video.currentSrc, runDuration: surfaces.run.video.duration,
      runTransform: getComputedStyle(surfaces.run.player.canvas).transform,
      headReady: surfaces.head.video.readyState >= 2, headSeeking: surfaces.head.video.seeking,
      bodyReady: surfaces.body.video.readyState >= 2, bodyPaused: surfaces.body.video.paused,
      idlePaused: surfaces.idle.video.paused, headPaused: surfaces.head.video.paused,
      headPlayback: state.headTouch.playback, headSerial: actions.serial, actionController: actions.snapshot(),
      canvas: { width: entry.player.canvas.width, height: entry.player.canvas.height },
      backgroundAlpha: pixels?.[3] ?? null, characterAlpha: pixels?.[(210 * 640 + 320) * 4 + 3] ?? null,
      hitAtCenter: isHit({ x: (320 - state.idle.viewport.x) * state.size.scale, y: (210 - state.idle.viewport.y + (state.idle.topPadding ?? 0)) * state.size.scale }),
      hitAtCorner: isHit({ x: 1, y: 1 }), decoder: { left: getComputedStyle(video).left, width: getComputedStyle(video).width },
      hasNodeAccess: typeof require !== 'undefined' || typeof process !== 'undefined' };
  };
  on(window, 'beforeunload', () => {
    activitySequencer?.dispose();
    dragFeedback.cancel();
    disposed = true; clearTimeout(maskTimer);
    clearTimeout(holdTimer); holdIntent.cancel(); mediaCache.dispose(); presenter.dispose();
    for (const timer of timers) clearTimeout(timer);
    for (const unsubscribe of listeners) if (typeof unsubscribe === 'function') unsubscribe();
    pixels = null;
  });
  actions.setBlocked('paused', state.paused);
  hidden = !state.visible; actions.setBlocked('hidden', hidden);
  for (const entry of Object.values(surfaces)) if (entry.hot) mediaCache.ensure(entry.id);
  layout(); presenter.select(surfaces.idle); play(surfaces.idle); sample(); reportActivity();
})();
