'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const status = $('save-status');
  let model, pending = {}, frame = null, flushing = false;
  const rows = new Map();
  const toggles = ['randomEnabled', 'conditionalRandomEnabled', 'wanderEnabled', 'roamNearHome', 'hoverGreetingEnabled', 'alwaysOnTop', 'avoidFullscreen', 'launchAtLogin'];
  const idleLabels = { 15: '活泼（15 秒）', 60: '适中（1 分钟）', 180: '安静（3 分钟）' };
  function saving(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  function queue(patch) {
    pending = { ...pending, ...patch, randomActions: patch.randomActions
      ? { ...(pending.randomActions ?? {}), ...patch.randomActions } : pending.randomActions };
    if (!pending.randomActions) delete pending.randomActions;
    saving('正在保存');
    if (frame === null) frame = requestAnimationFrame(() => { frame = null; flush(); });
  }
  async function flush() {
    if (flushing || !Object.keys(pending).length) return;
    flushing = true;
    const patch = pending; pending = {};
    try {
      const next = await window.petSettings.update(patch);
      if (!next) throw new Error('Settings unavailable');
      apply(next); saving('已保存');
    } catch { saving('保存失败，请重试', true); }
    finally { flushing = false; if (Object.keys(pending).length) flush(); }
  }
  function option(value, label) { const node = document.createElement('option'); node.value = String(value); node.textContent = label; return node; }
  function makeRows(data) {
    for (const action of data.actions) {
      const row = document.createElement('fieldset'); row.className = 'action-rule'; row.dataset.action = action.id;
      row.setAttribute('aria-label', action.label + '的随机规则');
      row.innerHTML = '<div class="rule-title"><label><input type="checkbox" data-field="enabled"><span></span></label><span class="rule-status"></span></div>' +
        '<div class="rule-controls"><div class="weight-row"><label>权重</label><input data-field="weight" type="range" min="0" max="10" step="1"><output></output></div>' +
        '<div class="rule-options"><label>时段<select data-field="timeProfile"></select></label><label>冷却<select data-field="cooldownMs"></select></label></div><p class="rule-note"></p></div>';
      row.querySelector('.rule-title label span').textContent = action.label;
      const controls = Object.fromEntries([...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input]));
      controls.enabled.setAttribute('aria-label', action.label + '参与随机动作');
      controls.weight.setAttribute('aria-label', action.label + '的权重');
      for (const [id, profile] of Object.entries(data.timeProfiles)) controls.timeProfile.appendChild(option(id, profile.label));
      for (const minutes of [0, 3, 5, 8, 10, 15, 20, 30, 60]) controls.cooldownMs.appendChild(option(minutes * 60000, minutes === 0 ? '无' : minutes + ' 分钟'));
      const change = () => {
        const rule = { enabled: controls.enabled.checked, weight: Number(controls.weight.value),
          timeProfile: controls.timeProfile.value, cooldownMs: Number(controls.cooldownMs.value) };
        updateRow(row, controls, rule, model.settings.randomEnabled && model.settings.conditionalRandomEnabled);
        queue({ randomActions: { [action.id]: rule } });
      };
      for (const [field, input] of Object.entries(controls)) input.addEventListener(field === 'weight' ? 'input' : 'change', change);
      $('action-rules').appendChild(row); rows.set(action.id, { row, controls });
    }
  }
  function updateRow(row, controls, rule, globalEnabled) {
    const disabled = !globalEnabled || !rule.enabled;
    row.classList.toggle('is-disabled', disabled);
    for (const [field, input] of Object.entries(controls)) {
      if (document.activeElement !== input) {
        if (field === 'enabled') input.checked = rule.enabled;
        else {
          if (field === 'cooldownMs' && ![...input.options].some(item => Number(item.value) === rule.cooldownMs)) input.appendChild(option(rule.cooldownMs, Math.round(rule.cooldownMs / 60000) + ' 分钟'));
          input.value = String(rule[field]);
        }
      }
      input.disabled = field === 'enabled' ? !globalEnabled : disabled;
    }
    row.querySelector('output').textContent = String(rule.weight);
    row.querySelector('.rule-status').textContent = !globalEnabled ? '规则未启用' : !rule.enabled || rule.weight === 0 ? '不随机播放' : '参与随机';
    row.querySelector('.rule-note').textContent = model.timeProfiles[rule.timeProfile].description;
  }
  function apply(data) {
    model = data;
    $('height').min = data.minHeight; $('height').max = data.maxHeight; $('height').disabled = false;
    if (document.activeElement !== $('height')) $('height').value = data.settings.height;
    $('height-value').textContent = $('height').value + ' px';
    $('height-min').textContent = data.minHeight; $('height-max').textContent = data.maxHeight;
    for (const id of toggles) { $(id).checked = data.settings[id]; $(id).disabled = false; }
    $('roamNearHome').disabled = !data.settings.wanderEnabled;
    const idle = $('activityIdleSec');
    if (!idle.options.length) for (const seconds of data.activityIdleChoices) idle.appendChild(option(seconds, idleLabels[seconds] ?? seconds + ' 秒'));
    if (document.activeElement !== idle) idle.value = String(data.settings.activityIdleSec);
    idle.disabled = !data.settings.randomEnabled;
    $('random-disabled').hidden = data.settings.randomEnabled;
    $('conditions-disabled').hidden = !data.settings.randomEnabled || data.settings.conditionalRandomEnabled;
    for (const [id, { row, controls }] of rows) updateRow(row, controls, data.settings.randomActions[id], data.settings.randomEnabled && data.settings.conditionalRandomEnabled);
  }
  const tabs = [$('tab-general'), $('tab-random')];
  function selectTab(tab) {
    for (const item of tabs) {
      const selected = item === tab; item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
    document.querySelector('main').scrollTop = 0;
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs.find(item => item !== tab);
      selectTab(next); next.focus();
    });
  }
  $('height').addEventListener('input', () => { $('height-value').textContent = $('height').value + ' px'; queue({ height: Number($('height').value) }); });
  $('reset-size').addEventListener('click', () => { $('height').value = model.defaultHeight; queue({ height: model.defaultHeight }); });
  for (const id of toggles) $(id).addEventListener('change', () => queue({ [id]: $(id).checked }));
  $('activityIdleSec').addEventListener('change', () => queue({ activityIdleSec: Number($('activityIdleSec').value) }));
  $('reset-random').addEventListener('click', () => {
    if (confirm('恢复所有动作的默认随机规则？当前的权重、时段和冷却设置会被替换。')) queue({ randomActions: model.defaults });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !(event.target instanceof HTMLSelectElement)) window.close();
  });
  try {
    const initial = await window.petSettings.initialize();
    if (!initial) throw new Error('Settings unavailable');
    model = initial; makeRows(initial); apply(initial); saving('已保存');
    window.petSettings.onState(apply);
  } catch { saving('读取失败，请重新打开', true); }
})();
