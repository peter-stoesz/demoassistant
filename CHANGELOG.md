# Demo Assistant — Change Log

**IMPORTANT: Review this log before making any code changes.** Understanding recent changes prevents regressions and duplicate work. Each entry documents what changed, why, and which files were affected.

---

## 2026-04-13 — Fix Recording Stop Failure and State Machine Deadlock

**Problem:** Clicking "Stop" would fail silently, leaving the state machine stuck at `STOPPING`. Because `onProcessingComplete()` only transitions from `PROCESSING` → `IDLE`, and a failed `stopCapture()` never reaches `PROCESSING`, the state was permanently stuck — blocking all future recordings.
**Root causes:**
1. `main.js` `stopRecordingFlow()` catch block called `recordingManager.onProcessingComplete()` which requires `PROCESSING` state — but a failed stop is still in `STOPPING` state. Replaced with `recordingManager.cancelRecording()` which handles `STOPPING` properly.
2. `audioCapture.js` `stopCapture()` only cleaned up `captureWindow` on the success path of `_finaliseFile()`. If finalisation failed, the destroyed window reference was never nulled — causing `isCapturing()` to return stale results.
3. The timeout handler in `stopCapture()` did not reset `isReady = false`.
4. No error was surfaced to the user — failures were only logged to console.

**Changes:**
- `src/main.js`: Changed catch block to use `cancelRecording()` instead of `onProcessingComplete()`, added `recording-error` IPC message to surface errors as a toast
- `src/audioCapture.js`: Moved `captureWindow` cleanup into `.finally()` so it runs on both success and failure; added `isReady = false` to the timeout handler

**Files modified:** `src/main.js`, `src/audioCapture.js`

---

## 2026-04-13 — Fix @xenova/transformers ESM Import Error

**Problem:** Both model download and transcription failed with "Transcription engine not found" because the code used `require('@xenova/transformers')` but the package declares `"type": "module"` in its package.json, making it ESM-only. Node's `require()` cannot load ESM packages and throws MODULE_NOT_FOUND or ERR_REQUIRE_ESM.
**Changes:**
- Changed `require('@xenova/transformers')` to `await import('@xenova/transformers')` in `whisperProvider.js` `setup()` method (line 170) and `isReady()` method (line 152)
- Changed `require('@xenova/transformers')` to `await import('@xenova/transformers')` in `main.js` startup pre-flight check (line 1678)
- Made `app.whenReady()` callback `async` so `await import()` is valid in the pre-flight block
- Added `ERR_REQUIRE_ESM` to the error code check in `setup()` catch block for better error detection

**Files modified:** `src/transcription/whisperProvider.js`, `src/main.js`

---

## 2026-04-13 — Sprint 3: Wire appLogger into Core Modules

**Commit:** `302e00b`
**Problem:** The Logs tab in the snippet manager was always empty because no application code called the appLogger. Every module used `console.log` instead.
**Changes:**
- Added `appLogger.info/error/success` calls to main.js for recording start/stop, capture errors, post-processing results, transcription enqueue/complete/fail, model download start/complete/fail, and startup pre-flight results
- Added `appLogger` import and calls to `src/transcription/queue.js` for job enqueue and job start events
- Added `appLogger` import and calls to `src/opportunityStore.js` for opportunity creation
- Enabled DevTools in the snippet manager window unconditionally (was restricted to development mode)

**Files modified:** `src/main.js`, `src/transcription/queue.js`, `src/opportunityStore.js`

---

## 2026-04-13 — Sprint 2: Transcription Pre-flight Checks and Download Progress

**Commit:** `56726ab`
**Problem:** Transcription failures were silent — missing ffmpeg or missing model produced no user-facing feedback. Model download progress jumped from 0% to 100% with no intermediate updates.
**Changes:**
- Added startup pre-flight checks in main.js boot sequence that log whether ffmpeg and @xenova/transformers are available
- Exposed `_resolveFfmpegPath` from audioCapture.js exports so main.js can call it at startup
- Added file-existence validation before enqueuing transcription jobs — sends error toast if recording file is missing
- Fixed model download progress: passed `progress_callback` to the `@xenova/transformers` `pipeline()` call so real download percentages are forwarded to the UI
- Added `env.cacheDir` alongside `env.localModelPath` for @xenova/transformers v2.x compatibility

**Files modified:** `src/main.js`, `src/audioCapture.js`, `src/transcription/whisperProvider.js`

---

## 2026-04-13 — Sprint 1: Fix Recording Pipeline (Track Validation, Race Condition, MIME Selection)

**Commit:** `6f17644`
**Problem:** Three critical bugs prevented recording from working: (1) if screen video capture failed, combining null videoStream with audio tracks crashed; (2) the capture window ready signal could fire before the listener was set up; (3) MIME type cascade always tried video codecs first even when only audio tracks were present.
**Changes:**
- Added `combinedTracks.length === 0` guard in audioCapture.html — surfaces a clear error if no tracks are available instead of crashing
- Made MIME type candidates track-aware: checks `hasVideo` and only uses video codecs when video tracks exist, falls back to audio-only codecs otherwise
- Fixed race condition in audioCapture.js: ready listener is now registered via `ipcMain.once()` BEFORE `captureWindow.loadFile()` instead of after, and timeout increased from 5s to 15s
- Removed duplicate `audio-capture-ready` handler from `setupIpcHandlers()` since it is now handled inside `startCapture()`

**Files modified:** `src/audioCapture.html`, `src/audioCapture.js`

---

## 2026-04-13 — Fix Recording: Quick Record, Permission Check, Error Surfacing

**Commit:** `4d2af7d`
**Problem:** Recording modal required selecting an opportunity before Start would enable. If no opportunities existed, recording was impossible. Screen Recording permission denials were silent. Recording errors never reached the UI.
**Changes:**
- Added green "Quick Record" button to recordingModal.html that bypasses opportunity selection (sends `__quick__` sentinel, normalised to null in main.js)
- Added macOS Screen Recording permission check via `systemPreferences.getMediaAccessStatus('screen')` before attempting capture, with notification linking to System Settings
- Added `recording-error` IPC channel: main.js sends errors to snippet manager, preload.js exposes `onRecordingError`, snippetManager.js shows them as toast notifications
- Widened recording modal window to accommodate the third button

**Files modified:** `src/main.js`, `src/preload.js`, `src/snippetManager.js`, `src/recordingModal.html`

---

## 2026-04-13 — Add Screen+Audio Recording Pipeline with MP4/WAV Export

**Commit:** `b774e62`
**Problem:** Recording was audio-only (no screen video). No post-processing produced MP4 or WAV files. Pause/resume was not wired through the capture pipeline.
**Changes:**
- Rewrote audioCapture.html to capture screen video + system audio + microphone, combine via AudioContext, and record as video/webm with 1-second chunk streaming
- Added `convertToOutputFormats(webmPath)` in audioCapture.js — runs ffmpeg to produce MP4 (H.264/AAC) and WAV (16kHz mono PCM for Whisper)
- Added `_resolveFfmpegPath()` in audioCapture.js — checks ffmpeg-static, /opt/homebrew/bin/ffmpeg, /usr/local/bin/ffmpeg, /usr/bin/ffmpeg
- Added pause/resume IPC wiring: audioCapturePreload.js listeners, audioCapture.js forwarding, MediaRecorder.pause()/resume() in renderer
- Updated stopRecordingFlow() in main.js to run conversion and use WAV file for transcription queue
- Module-level variables in audioCapture.html to prevent AudioContext garbage collection
- Added `isReady = false` reset at start of `startCapture()` to prevent stale state

**Files modified:** `src/audioCapture.html`, `src/audioCapture.js`, `src/audioCapturePreload.js`, `src/main.js`, `src/recordingManager.js`

---

## 2026-04-13 — Initial Commit

**Commit:** `39ec537`
**Description:** Demo Assistant Electron app with long-recording hardening. Full overlay toolkit, snippet manager, recording pipeline, transcription queue, and structured logging infrastructure.

---

## How to Use This Log

1. **Before any code change**, read the most recent entries to understand what was modified and why
2. **After making changes**, add a new entry at the top with: commit hash, problem description, list of changes, and files modified
3. Keep entries concise but specific — future you needs file names and the reasoning, not a novel
