'use strict';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function sanitizeRandomActions(input, policy = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(Object.entries(policy.defaults ?? {}).map(([id, defaults]) => {
    const rule = value[id] && typeof value[id] === 'object' ? value[id] : {};
    return [id, {
      enabled: typeof rule.enabled === 'boolean' ? rule.enabled : defaults.enabled !== false,
      weight: finite(rule.weight) ? Math.round(clamp(rule.weight, 0, 10)) : defaults.weight,
      timeProfile: Object.hasOwn(policy.timeProfiles ?? {}, rule.timeProfile) ? rule.timeProfile : defaults.timeProfile,
      cooldownMs: finite(rule.cooldownMs) ? Math.round(clamp(rule.cooldownMs, 0, 3600000)) : defaults.cooldownMs,
    }];
  }));
}

function sanitizeSettings(input, config) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    schemaVersion: 1,
    height: finite(value.height) ? Math.round(clamp(value.height, config.minHeight, config.maxHeight)) : config.defaultHeight,
    alwaysOnTop: typeof value.alwaysOnTop === 'boolean' ? value.alwaysOnTop : true,
    avoidFullscreen: typeof value.avoidFullscreen === 'boolean' ? value.avoidFullscreen : true,
    wanderEnabled: typeof value.wanderEnabled === 'boolean' ? value.wanderEnabled : true,
    randomEnabled: typeof value.randomEnabled === 'boolean' ? value.randomEnabled : true,
    conditionalRandomEnabled: typeof value.conditionalRandomEnabled === 'boolean' ? value.conditionalRandomEnabled : true,
    randomActions: sanitizeRandomActions(value.randomActions, config.randomPolicy),
    hoverGreetingEnabled: typeof value.hoverGreetingEnabled === 'boolean' ? value.hoverGreetingEnabled : true,
    activityIdleSec: activityIdleChoices.includes(value.activityIdleSec) ? value.activityIdleSec : defaultActivityIdleSec,
    roamNearHome: typeof value.roamNearHome === 'boolean' ? value.roamNearHome : true,
    position: point(value.position),
    home: point(value.home),
  };
}
const activityIdleChoices = [15, 60, 180], defaultActivityIdleSec = 60;
const point = value => finite(value?.x) && finite(value?.y) ? { x: Math.round(value.x), y: Math.round(value.y) } : null;

function geometry(height, idle) {
  const scale = height / idle.visibleHeight;
  const { viewport, foot } = idle;
  return {
    width: Math.ceil(viewport.width * scale),
    height: Math.ceil((viewport.height + (idle.topPadding ?? 0)) * scale),
    scale,
    anchorX: (foot[0] - viewport.x) * scale,
    footY: (foot[1] - viewport.y + (idle.topPadding ?? 0)) * scale,
  };
}

function nearestArea(bounds, areas) {
  if (!areas.length) throw new Error('No available display work area');
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const distance = area => {
    const x = clamp(center.x, area.x, area.x + area.width);
    const y = clamp(center.y, area.y, area.y + area.height);
    return (center.x - x) ** 2 + (center.y - y) ** 2;
  };
  return areas.reduce((best, item) => distance(item) < distance(best) ? item : best);
}

function constrain(bounds, areas) {
  const area = nearestArea(bounds, areas);
  return {
    x: Math.round(clamp(bounds.x, area.x, Math.max(area.x, area.x + area.width - bounds.width))),
    y: Math.round(clamp(bounds.y, area.y, Math.max(area.y, area.y + area.height - bounds.height))),
    width: bounds.width, height: bounds.height,
  };
}

function movementBody(size, idle, movement) {
  const [left, top, right, bottom] = movement.visibleBounds;
  return { x: (left - idle.viewport.x) * size.scale, y: (top - idle.viewport.y + (idle.topPadding ?? 0)) * size.scale,
    width: (right - left) * size.scale, height: (bottom - top) * size.scale };
}
function contentBounds(bounds, body) {
  return { x: bounds.x + body.x, y: bounds.y + body.y, width: body.width, height: body.height };
}
function contentLimits(area, body) {
  return { minX: Math.ceil(area.x - body.x), maxX: Math.floor(area.x + area.width - body.x - body.width),
    minY: Math.ceil(area.y - body.y), maxY: Math.floor(area.y + area.height - body.y - body.height) };
}
function constrainContent(bounds, areas, body) {
  const limits = contentLimits(nearestArea(contentBounds(bounds, body), areas), body);
  return { ...bounds,
    x: Math.round(clamp(bounds.x, limits.minX, Math.max(limits.minX, limits.maxX))),
    y: Math.round(clamp(bounds.y, limits.minY, Math.max(limits.minY, limits.maxY))) };
}
function recoverPosition(bounds, areas, body) {
  const visible = contentBounds(bounds, body);
  // Preserve deliberate edge placements, including positions spanning displays.
  // Only rescue a character which is wholly outside every remaining display.
  if (areas.some(area => visible.x < area.x + area.width && visible.x + visible.width > area.x &&
    visible.y < area.y + area.height && visible.y + visible.height > area.y)) return { ...bounds };
  return constrainContent(bounds, areas, body);
}

// Limit automatic running and flying to a box around the position the user chose,
// so the character does not slowly drift over the middle of the desktop.
function roamArea(home, body, areas, scale, reach = { x: 360, y: 160 }) {
  const display = nearestArea(contentBounds({ ...home, width: 0, height: 0 }, body), areas);
  const box = { x: home.x + body.x - reach.x * scale, y: home.y + body.y - reach.y * scale,
    right: home.x + body.x + body.width + reach.x * scale, bottom: home.y + body.y + body.height + reach.y * scale };
  const x = Math.max(box.x, display.x), y = Math.max(box.y, display.y);
  const right = Math.min(box.right, display.x + display.width), bottom = Math.min(box.bottom, display.y + display.height);
  if (right - x < body.width || bottom - y < body.height) return display;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}

// Use the stored home while the character is still inside its roaming box.
// Anything else that placed it outside (not a drag) becomes the new home.
function roamingArea(home, bounds, body, areas, scale) {
  const content = contentBounds(bounds, body);
  const contains = area => content.x >= area.x - 1 && content.y >= area.y - 1 &&
    content.x + content.width <= area.x + area.width + 1 && content.y + content.height <= area.y + area.height + 1;
  if (home) {
    const area = roamArea(home, body, areas, scale);
    if (contains(area)) return { area, home };
  }
  const next = { x: bounds.x, y: bounds.y };
  return { area: roamArea(next, body, areas, scale), home: next };
}

function resizeAtFeet(bounds, before, after) {
  return {
    x: Math.round(bounds.x + before.anchorX - after.anchorX),
    y: Math.round(bounds.y + before.footY - after.footY),
    width: after.width, height: after.height,
  };
}

module.exports = { sanitizeSettings, sanitizeRandomActions, activityIdleChoices, roamArea, roamingArea, geometry, constrain, resizeAtFeet, nearestArea,
  movementBody, contentBounds, contentLimits, constrainContent, recoverPosition };
