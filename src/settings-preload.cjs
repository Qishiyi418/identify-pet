'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petSettings', {
  initialize: () => ipcRenderer.invoke('pet:settings-read'),
  update: patch => ipcRenderer.invoke('pet:settings-update', patch),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pet:settings-state', listener);
    return () => ipcRenderer.removeListener('pet:settings-state', listener);
  },
});
