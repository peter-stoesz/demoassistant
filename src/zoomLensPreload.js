'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoomLensAPI', {
  onFrame: (callback) => {
    ipcRenderer.on('zoom-lens-frame', (_event, data) => callback(data));
  },
  onMagnificationChanged: (callback) => {
    ipcRenderer.on('zoom-lens-magnification', (_event, data) => callback(data));
  }
});
