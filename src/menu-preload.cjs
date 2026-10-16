'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = channel => callback => ipcRenderer.on(channel, (_event, value) => callback(value));
contextBridge.exposeInMainWorld('petMenu', {
  onOpen: subscribe('pet-menu:open'),
  onShow: subscribe('pet-menu:show'),
  onHide: subscribe('pet-menu:hide'),
  measured: (token, width, height) => ipcRenderer.send('pet-menu:measured', token, width, height),
  choose: (token, id) => ipcRenderer.send('pet-menu:choose', token, id),
  close: token => ipcRenderer.send('pet-menu:close', token),
});
