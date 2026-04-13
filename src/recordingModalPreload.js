'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recordingModalAPI', {
  /**
   * getOpportunities()
   * Invoke to get opportunities list
   * Returns: Promise<Array>
   */
  getOpportunities: () => {
    return ipcRenderer.invoke('recording-modal-get-opportunities');
  },

  /**
   * onConfirm(callback)
   * Main process asks for confirmation
   */
  onConfirm: (callback) => {
    ipcRenderer.on('recording-modal-confirm', (_event) => callback());
  },

  /**
   * sendSelection(opportunityId)
   * Send the selected opportunity ID back to main
   */
  sendSelection: (opportunityId) => {
    ipcRenderer.send('recording-modal-selected', opportunityId);
  },

  /**
   * sendCancel()
   * Send cancel signal
   */
  sendCancel: () => {
    ipcRenderer.send('recording-modal-cancel');
  },

  /**
   * close()
   * Close the window
   */
  close: () => {
    ipcRenderer.send('recording-modal-close');
  }
});
