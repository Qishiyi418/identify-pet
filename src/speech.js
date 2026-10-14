'use strict';
window.speech.onMessage(({ text, below }) => {
  document.getElementById('speech').textContent = text;
  document.body.classList.toggle('below', below);
});
