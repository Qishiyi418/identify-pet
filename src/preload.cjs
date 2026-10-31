'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => {
  if (typeof callback !== 'function') return;
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('pet', {
  initialize: () => ipcRenderer.invoke('pet:initialize'),
  hit: value => ipcRenderer.send('pet:hit', value),
  speech: value => ipcRenderer.send('pet:speech', value),
  startDrag: (point, cursor) => ipcRenderer.send('pet:drag-start', point, cursor),
  endDrag: point => ipcRenderer.send('pet:drag-end', point),
  menu: () => ipcRenderer.send('pet:menu'),
  ready: () => ipcRenderer.send('pet:ready'),
  fallbackReady: () => ipcRenderer.send('pet:fallback-ready'),
  error: message => ipcRenderer.send('pet:error', message),
  activity: busy => ipcRenderer.send('pet:activity', busy),
  runStatus: (id, ready, completed = false) => ipcRenderer.send('pet:run-status', id, ready, completed),
  onRun: subscribe('pet:run'),
  requestRun: manual => ipcRenderer.send('pet:run-request', manual === true),
  onManualRun: subscribe('pet:manual-run'),
  onAmbient: subscribe('pet:ambient'),
  onRunStop: subscribe('pet:run-stop'),
  requestFlight: (direction, manual = false) => ipcRenderer.send('pet:flight-request', direction, manual === true),
  flightStatus: (id, ready, completed = false) => ipcRenderer.send('pet:flight-status', id, ready, completed),
  onFlight: subscribe('pet:flight'),
  onFlightStop: subscribe('pet:flight-stop'),
  onManualFlight: subscribe('pet:manual-flight'),
  onState: subscribe('pet:state'),
  onPointer: subscribe('pet:pointer'),
  onDragging: subscribe('pet:dragging'),
  onVisibility: subscribe('pet:visibility'),
  onHeadTouch: subscribe('pet:head-touch'),
  onBodyTouch: subscribe('pet:body-touch'),
  onInputBlocked: subscribe('pet:input-blocked'),
});
