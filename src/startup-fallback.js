'use strict';
// This small DOM-only view must not depend on the video/canvas renderer. It can
// still show the character if decoder initialization or the main script fails.
(() => {
  let state, overlay, picture, message, active = false;
  const report = text => window.pet.error(`Startup fallback: ${text}`);
  function update(next) {
    state = next;
    active = Boolean(state?.startupFallback);
    if (!active) { overlay?.remove(); overlay = picture = message = null; return; }
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'startup-fallback';
      overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;z-index:100';
      picture = document.createElement('img'); picture.alt = '拉拉队员桌宠'; picture.draggable = false;
      message = document.createElement('div');
      message.textContent = '动画暂时无法加载，右键可重新启动桌宠';
      message.style.cssText = 'position:absolute;left:8px;right:8px;top:8px;padding:8px;border-radius:8px;background:#fff5e8;color:#442c28;font:12px/1.5 sans-serif;text-align:center';
      const image = picture;
      image.onload = () => { if (active && picture === image) window.pet.fallbackReady(); };
      image.onerror = () => {
        if (!active || picture !== image) return;
        report('Poster could not be loaded');
        message.textContent = '人物素材加载失败，请右键重启或重新安装';
        window.pet.fallbackReady();
      };
      overlay.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); window.pet.menu(); });
      // Do not let a partially initialized animation renderer handle these clicks.
      for (const name of ['pointerdown', 'pointerup', 'click']) overlay.addEventListener(name, event => event.stopPropagation());
      overlay.append(image, message); document.getElementById('stage').appendChild(overlay);
      image.src = state.idle.poster;
    }
    const { scale } = state.size, { viewport } = state.idle;
    picture.style.cssText = `position:absolute;pointer-events:none;width:${state.idle.width * scale}px;height:${state.idle.height * scale}px;left:${-viewport.x * scale}px;top:${((state.idle.topPadding ?? 0) - viewport.y) * scale}px`;
  }
  window.pet.onState(update);
  window.pet.initialize().then(initial => { if (!state) update(initial); }).catch(error => report(error.message));
  window.addEventListener('error', event => report(event.message || 'Page resource failed'));
  window.addEventListener('unhandledrejection', event => report(event.reason?.message || String(event.reason)));
})();
