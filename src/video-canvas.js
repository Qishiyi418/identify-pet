'use strict';

// The video is a muted decoder outside the viewport. Chromium's VideoWakeLock
// only needs a display wake lock for visible/big video or audible playback.
// A canvas presents the same alpha frames without becoming a media player.
window.PetVideoCanvas = {
  attach(video, stage) {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    canvas.setAttribute('aria-hidden', 'true');
    const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!context) throw new Error('无法创建桌宠动画画布');
    video.muted = true;
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.classList.add('pet-video-source');
    let disposed = false;
    let frame = null;
    let lastTime = null;
    let posterUrl = null;
    let poster = null;
    let restarting = false;
    const fit = (width, height) => {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    const drawPoster = (force = false) => {
      if (!disposed && poster?.complete && poster.naturalWidth && (force || video.readyState < 2)) {
        fit(poster.naturalWidth, poster.naturalHeight);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(poster, 0, 0, canvas.width, canvas.height);
      }
    };
    const sync = () => {
      canvas.className = video.className.replace(/\bpet-video-source\b/g, '').trim();
      canvas.style.cssText = video.style.cssText;
      const nextPoster = video.getAttribute('poster');
      if (nextPoster !== posterUrl) {
        if (poster) poster.onload = null;
        posterUrl = nextPoster;
        poster = null;
        if (nextPoster) {
          poster = new Image();
          poster.onload = () => drawPoster();
          poster.src = nextPoster;
          drawPoster();
        }
      }
    };
    const paint = (force = false) => {
      if (disposed) return;
      // Keep the first frame visible while the decoder seeks. A click must not
      // leave the previous petting pose on screen until the seek completes.
      if (restarting && (video.seeking || video.readyState < 2)) {
        drawPoster(true);
        return;
      }
      restarting = false;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        drawPoster();
        return;
      }
      if (!force && lastTime === video.currentTime) return;
      fit(video.videoWidth, video.videoHeight);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      lastTime = video.currentTime;
    };
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const tick = () => {
      frame = null;
      if (disposed || video.paused || video.ended) return;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      paint(true);
      if (frame === null && !video.paused && !disposed) frame = requestAnimationFrame(tick);
    };
    const emptied = () => {
      stop();
      lastTime = null;
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawPoster();
    };
    const pause = () => {
      stop();
      paint(true);
    };
    const redraw = () => paint(true);
    const events = [
      ['playing', start],
      ['play', start],
      ['pause', pause],
      ['ended', pause],
      ['loadeddata', redraw],
      ['seeked', redraw],
      ['emptied', emptied],
    ];
    for (const [name, listener] of events) video.addEventListener(name, listener);
    const observer = new MutationObserver(sync);
    observer.observe(video, { attributes: true, attributeFilter: ['class', 'style', 'poster'] });
    sync();
    stage.appendChild(canvas);
    start();
    return {
      canvas,
      restartFromFirstFrame() {
        if (disposed) return;
        restarting = true;
        lastTime = null;
        drawPoster(true);
        video.currentTime = 0;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stop();
        observer.disconnect();
        if (poster) poster.onload = null;
        for (const [name, listener] of events) video.removeEventListener(name, listener);
        canvas.width = canvas.height = 0;
        canvas.remove();
      },
    };
  },
};
