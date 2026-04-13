'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioCaptureAPI', {
  /**
   * onStartCapture(callback)
   * Receives { sourceId } from main process
   */
  onStartCapture: (callback) => {
    ipcRenderer.on('audio-capture-start', (_event, data) => callback(data));
  },

  /**
   * onStopCapture(callback)
   * Receives no args - signal to stop recording
   */
  onStopCapture: (callback) => {
    ipcRenderer.on('audio-capture-stop', () => callback());
  },

  /**
   * sendAudioData(arrayBuffer)
   * Sends the recorded audio buffer back to main (legacy fallback)
   */
  sendAudioData: (arrayBuffer) => {
    ipcRenderer.send('audio-capture-data', arrayBuffer);
  },

  /**
   * sendAudioChunk(arrayBuffer)
   * Streams a single ondataavailable chunk to main for immediate disk write.
   * Uses structured-clone transfer so the ArrayBuffer is zero-copy.
   */
  sendAudioChunk: (arrayBuffer) => {
    ipcRenderer.send('audio-chunk', arrayBuffer);
  },

  /**
   * sendCaptureStop()
   * Tells main that the MediaRecorder has fully stopped and all chunks have been sent.
   */
  sendCaptureStop: () => {
    ipcRenderer.send('audio-capture-stopped');
  },

  /**
   * sendError(message)
   * Sends error message back to main
   */
  sendError: (message) => {
    ipcRenderer.send('audio-capture-error', message);
  },

  /**
   * sendReady()
   * Signals that the capture window is ready
   */
  sendReady: () => {
    ipcRenderer.send('audio-capture-ready');
  }
});
