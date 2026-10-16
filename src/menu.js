'use strict';
(() => {
  const card = document.getElementById('card');
  const MARGIN = 12; // body padding that leaves room for the card shadow
  let token = 0, items = [], active = null, closing = false, leaveTimer = null;

  function node(tag, className, attrs = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  }
  function button(entry, className, role = 'menuitem') {
    const element = node('button', 'item ' + className, { type: 'button', role, tabindex: '-1' });
    element.dataset.id = entry.id; element.disabled = entry.enabled === false;
    if (entry.icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-' + entry.icon);
      svg.append(use); element.append(svg);
    }
    const label = node('span'); label.textContent = entry.label; element.append(label);
    return element;
  }
  function render(model) {
    const quick = node('div', 'quick', { role: 'group', 'aria-label': '互动' });
    for (const entry of model.quick) quick.append(button(entry, 'tile'));
    const heading = node('p', 'label', { 'aria-hidden': 'true' }); heading.textContent = '做点什么';
    const acts = node('div', 'acts', { role: 'group', 'aria-label': '做点什么' });
    for (const entry of model.activities) acts.append(button(entry, 'chip'));
    const toggles = node('div', 'rows', { role: 'group' });
    for (const entry of model.toggles) {
      const element = button(entry, 'row', 'menuitemcheckbox');
      element.setAttribute('aria-checked', String(entry.checked));
      element.append(node('i', 'switch', { 'aria-hidden': 'true' })); toggles.append(element);
    }
    const commands = node('div', 'rows', { role: 'group' });
    for (const entry of model.commands) commands.append(button(entry, entry.quiet ? 'row quiet' : 'row'));
    const stitch = () => node('div', 'stitch', { role: 'separator' });
    card.replaceChildren(quick, stitch(), heading, acts, stitch(), toggles, stitch(), commands);
    items = [...card.querySelectorAll('.item')];
  }
  function setActive(element, focus = true) {
    if (active === element) return;
    active?.classList.remove('active');
    active = element; element?.classList.add('active');
    if (element && focus) element.focus({ preventScroll: true });
    else if (!element) card.focus({ preventScroll: true });
  }
  function choose(element) {
    if (closing || !element || element.disabled) return;
    closing = true;
    if (element.getAttribute('role') !== 'menuitemcheckbox') { window.petMenu.choose(token, element.dataset.id); return; }
    // Let the switch visibly flip before the menu goes away.
    element.setAttribute('aria-checked', String(element.getAttribute('aria-checked') !== 'true'));
    const sent = token; setTimeout(() => window.petMenu.choose(sent, element.dataset.id), 140);
  }
  // Up/down move to the nearest item in the next row; left/right walk the list in reading order.
  function vertical(list, from, direction) {
    const a = from.getBoundingClientRect(), center = a.left + a.width / 2;
    let best = null, score = Infinity;
    for (const element of list) {
      const b = element.getBoundingClientRect();
      const gap = direction > 0 ? b.top - a.bottom : a.top - b.bottom;
      if (gap < -1 || Math.abs(b.top - a.top) < 2) continue;
      const value = gap * 4 + Math.abs(b.left + b.width / 2 - center);
      if (value < score) { score = value; best = element; }
    }
    return best ?? list[direction > 0 ? 0 : list.length - 1];
  }

  card.addEventListener('pointermove', event => {
    document.body.classList.remove('keyboard');
    const element = event.target.closest('.item');
    setActive(element && !element.disabled ? element : null);
  });
  card.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
  card.addEventListener('pointerleave', () => {
    if (!document.body.classList.contains('keyboard')) setActive(null);
    // Normally losing focus closes the menu. If Windows refused to focus it, close once the pointer wanders off.
    clearTimeout(leaveTimer);
    if (!document.hasFocus()) leaveTimer = setTimeout(() => { if (!document.hasFocus()) window.petMenu.close(token); }, 1200);
  });
  card.addEventListener('click', event => choose(event.target.closest('.item')));
  document.addEventListener('contextmenu', event => event.preventDefault());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); window.petMenu.close(token); return; }
    if ((event.key === 'Enter' || event.key === ' ') && active) { event.preventDefault(); choose(active); return; }
    const enabled = items.filter(element => !element.disabled), index = enabled.indexOf(active);
    if (!enabled.length) return;
    const forward = event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey);
    const backward = event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey);
    let next = null;
    if (forward) next = enabled[(index + 1) % enabled.length];
    else if (backward) next = index < 0 ? enabled.at(-1) : enabled.at(index - 1);
    else if (event.key === 'ArrowDown') next = active ? vertical(enabled, active, 1) : enabled[0];
    else if (event.key === 'ArrowUp') next = active ? vertical(enabled, active, -1) : enabled.at(-1);
    else if (event.key === 'Home') next = enabled[0];
    else if (event.key === 'End') next = enabled.at(-1);
    if (!next) return;
    event.preventDefault(); document.body.classList.add('keyboard'); setActive(next);
  });

  window.petMenu.onOpen(({ token: next, model }) => {
    token = next; closing = false; active = null; clearTimeout(leaveTimer);
    card.classList.remove('open'); document.body.classList.remove('keyboard');
    render(model);
    // offsetWidth ignores the closed-state scale transform, so this is the settled size.
    window.petMenu.measured(token, card.offsetWidth + MARGIN * 2, card.offsetHeight + MARGIN * 2);
  });
  window.petMenu.onShow(({ token: shown, origin }) => {
    if (shown !== token) return;
    card.style.transformOrigin = origin;
    card.focus({ preventScroll: true });
    requestAnimationFrame(() => card.classList.add('open'));
  });
  window.petMenu.onHide(() => {
    // Empty the card so a reopened window never flashes the previous menu.
    clearTimeout(leaveTimer); card.classList.remove('open'); card.replaceChildren(); items = []; active = null;
  });
})();
