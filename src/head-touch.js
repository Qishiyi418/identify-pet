'use strict';
(function (scope) {
  class HeadTouch {
    constructor() { this.active = false; this.serial = 0; }
    touch(eligible = true) {
      if (!eligible) return 'ignored';
      const result = this.active ? 'restart' : 'start';
      this.active = true; this.serial++; return result;
    }
    cancel() { this.active = false; this.serial++; }
  }
  function aboveNeck(point, opaque, line = 200) {
    return Boolean(opaque && point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.y < line);
  }
  const api = { HeadTouch, aboveNeck };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.HeadTouchInput = api;
})(globalThis);
