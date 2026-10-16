'use strict';
const bubble = document.getElementById('speech');
let shown = null;
window.speech.onMessage(({ text, below, revision }) => {
  bubble.textContent = text;
  document.body.classList.toggle('below', below);
  // Repositioning while she moves resends the same message; only a new one pops in.
  if (revision === shown) return;
  shown = revision;
  bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
});
