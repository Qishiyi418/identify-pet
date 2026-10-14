'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('speech', {
  onMessage: callback => ipcRenderer.on('pet:speech-message', (_event, value) => callback(value)),
});
