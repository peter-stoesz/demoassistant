'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Feature state ──────────────────────────────────────────────────────────
  getFeatureState: () => ipcRenderer.invoke('get-feature-state'),

  onFeatureToggled: (callback) => {
    ipcRenderer.on('feature-toggled', (_event, data) => callback(data));
  },

  onDisplayChanged: (callback) => {
    ipcRenderer.on('display-changed', (_event, data) => callback(data));
  },

  // ── Sonar blip (from main process hotkey) ──────────────────────────────────
  onSonarBlip: (callback) => {
    ipcRenderer.on('sonar-blip', (_event, data) => callback(data));
  },

  // ── Selection box mode (from main process hotkey) ──────────────────────────
  onSelectionModeEnter: (callback) => {
    ipcRenderer.on('selection-mode-enter', (_event, data) => callback(data));
  },

  onSelectionModeExit: (callback) => {
    ipcRenderer.on('selection-mode-exit', (_event, data) => callback(data));
  },

  // Overlay tells main that drag is complete → return to click-through
  selectionComplete: () => ipcRenderer.send('selection-complete'),

  // Legacy: overlay can also request interactive mode directly
  setSelectionMode: (active) => ipcRenderer.send('set-selection-mode', active),

  // ── Snippets ───────────────────────────────────────────────────────────────
  getSnippets: () => ipcRenderer.invoke('get-snippets'),
  saveSnippets: (snippets) => ipcRenderer.invoke('save-snippets', snippets),

  // ── Window controls ────────────────────────────────────────────────────────
  closeSnippetManager: () => ipcRenderer.send('close-snippet-manager'),
  openSnippetManager: () => ipcRenderer.send('open-snippet-manager'),

  // ── Freeze Frame (Sprint 1) ─────────────────────────────────────────────────
  onFreezeFrameCapture: (callback) => {
    ipcRenderer.on('freeze-frame-capture', (_event, data) => callback(data));
  },
  onFreezeFrameRelease: (callback) => {
    ipcRenderer.on('freeze-frame-release', (_event) => callback());
  },

  // ── Annotation mode (Sprint 2) ──────────────────────────────────────────────
  onAnnotationModeEnter: (callback) => {
    ipcRenderer.on('annotation-mode-enter', (_event, data) => callback(data));
  },
  onAnnotationModeExit: (callback) => {
    ipcRenderer.on('annotation-mode-exit', (_event, data) => callback(data));
  },
  onAnnotationClear: (callback) => {
    ipcRenderer.on('annotation-clear', (_event) => callback());
  },
  onAnnotationUndo: (callback) => {
    ipcRenderer.on('annotation-undo', (_event) => callback());
  },
  onAnnotationTogglePersist: (callback) => {
    ipcRenderer.on('annotation-toggle-persist', (_event) => callback());
  },
  annotationComplete: () => ipcRenderer.send('annotation-complete'),

  // ── Cue Cards (Sprint 3) ────────────────────────────────────────────────────
  getCueCards:      () => ipcRenderer.invoke('get-cue-cards'),
  saveCueCards:     (data) => ipcRenderer.invoke('save-cue-cards', data),
  getCueCardSets:   () => ipcRenderer.invoke('get-cue-card-sets'),
  switchCueCardSet: (setName) => ipcRenderer.invoke('switch-cue-card-set', setName),

  // ── Opportunities (Sprint 1) ────────────────────────────────────────────────
  getOpportunities:      () => ipcRenderer.invoke('get-opportunities'),
  addOpportunity:        (data) => ipcRenderer.invoke('add-opportunity', data),
  updateOpportunity:     (id, fields) => ipcRenderer.invoke('update-opportunity', { id, fields }),
  deleteOpportunity:     (id) => ipcRenderer.invoke('delete-opportunity', id),
  searchOpportunities:   (query) => ipcRenderer.invoke('search-opportunities', query),
  importOpportunitiesCsv: () => ipcRenderer.invoke('import-opportunities-csv'),

  // ── Recording (Sprint 2) ────────────────────────────────────────────────────
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  startRecording:    () => ipcRenderer.invoke('start-recording'),
  stopRecording:     () => ipcRenderer.invoke('stop-recording'),
  pauseRecording:    () => ipcRenderer.invoke('pause-recording'),
  resumeRecording:   () => ipcRenderer.invoke('resume-recording'),
  onRecordingStateChange: (callback) => {
    ipcRenderer.on('recording-state-changed', (_event, data) => callback(data));
  },

  // ── Transcripts (Sprint 3 + Sprint 4) ──────────────────────────────────────
  getTranscripts:            () => ipcRenderer.invoke('get-transcripts'),
  getTranscriptContent:      (id) => ipcRenderer.invoke('get-transcript-content', id),
  deleteTranscript:          (id) => ipcRenderer.invoke('delete-transcript', id),
  searchTranscripts:         (query) => ipcRenderer.invoke('search-transcripts', query),
  getTranscriptionStatus:    () => ipcRenderer.invoke('get-transcription-status'),
  retryTranscription:        (id) => ipcRenderer.invoke('retry-transcription', id),
  getTranscriptsForOpportunity: (oppId) => ipcRenderer.invoke('get-transcripts-for-opportunity', oppId),
  onTranscriptionProgress: (callback) => {
    ipcRenderer.on('transcription-progress', (_event, data) => callback(data));
  },

  // ── Transcription Config (Sprint 6) ────────────────────────────────────────
  getTranscriptionConfig:  () => ipcRenderer.invoke('get-transcription-config'),
  setTranscriptionConfig:  (partial) => ipcRenderer.invoke('set-transcription-config', partial),
  checkDiskSpace:          () => ipcRenderer.invoke('check-disk-space'),
  cleanupOldRecordings:    (days) => ipcRenderer.invoke('cleanup-old-recordings', days),
  getStorageUsage:         () => ipcRenderer.invoke('get-storage-usage'),

  // ── App Logger ──────────────────────────────────────────────────────────────
  getLogEntries:    (filters) => ipcRenderer.invoke('get-log-entries', filters),
  getLogCategories: ()        => ipcRenderer.invoke('get-log-categories'),
  clearLogs:        ()        => ipcRenderer.invoke('clear-logs'),
  onLogEntry: (callback) => {
    ipcRenderer.on('log-entry', (_event, data) => callback(data));
  },

  // ── Model Download ─────────────────────────────────────────────────────────
  downloadModel:    (modelId) => ipcRenderer.invoke('download-model', modelId),
  checkModelStatus: (modelId)  => ipcRenderer.invoke('check-model-status', modelId),
  onModelDownloadProgress: (callback) => {
    ipcRenderer.on('model-download-progress', (_event, data) => callback(data));
  },

  // ── Export / Output Folder ─────────────────────────────────────────────────
  exportTranscript:   (transcriptId, format) => ipcRenderer.invoke('export-transcript', { transcriptId, format }),
  selectOutputFolder: ()      => ipcRenderer.invoke('select-output-folder'),
  clearOutputFolder:  ()      => ipcRenderer.invoke('clear-output-folder'),

  // ── Architecture Info ──────────────────────────────────────────────────────
  getArchInfo: () => ipcRenderer.invoke('get-arch-info'),

  // ── Memory warning (Long-Recording Hardening S1-5) ─────────────────────────
  onMemoryWarning: (callback) => {
    ipcRenderer.on('memory-warning', (_event, data) => callback(data));
  },

  // ── Deep link from tray (Sprint 6) ─────────────────────────────────────────
  onOpenTranscript: (callback) => {
    ipcRenderer.on('open-transcript', (_event, data) => callback(data));
  },

  // ── Hotkey management (Phases 3c, 5a, 5b) ─────────────────────────────────
  getHotkeyStatus: () => ipcRenderer.invoke('get-hotkey-status'),
  getHotkeyConfig: () => ipcRenderer.invoke('get-hotkey-config'),
  getDefaultHotkeys: () => ipcRenderer.invoke('get-default-hotkeys'),
  setHotkeyConfig: ({ action, accelerator }) =>
    ipcRenderer.invoke('set-hotkey-config', { action, accelerator }),
  reregisterHotkeys: () => ipcRenderer.send('reregister-hotkeys'),

  // ── Platform info ──────────────────────────────────────────────────────────
  platform: process.platform
});
