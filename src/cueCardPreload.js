'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cueCardAPI', {
  // Receive card data updates
  onCardsLoaded: (callback) => {
    ipcRenderer.on('cue-cards-loaded', (_event, data) => callback(data));
  },
  onNavigate: (callback) => {
    ipcRenderer.on('cue-card-navigate', (_event, data) => callback(data));
  },
  onSetChanged: (callback) => {
    ipcRenderer.on('cue-card-set-changed', (_event, data) => callback(data));
  }
});
