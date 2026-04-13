# Demo Assistant — Change Log

**IMPORTANT: Review this log before making any code changes.** Understanding recent changes prevents regressions and duplicate work. Each entry documents what changed, why, and which files were affected.

---

## Session Summary: 2026-04-13 (continued — part 2)

**Focus:** Fix 0-byte recordings caused by renderer crash when screen recording permission is denied.

**Root cause found:** `getUserMedia({ chromeMediaSource: 'desktop' })` for screen video fails with "Could not start video source" when macOS screen recording permission is denied. Chromium then kills the entire renderer process with "bad IPC message, reason 263". This is a Chromium safety mechanism — not a catchable JS error. Once the renderer dies, no MediaRecorder is created, no audio chunks are sent, and the file stays empty.

**What was accomplished:**
1. **Auto-retry with audio-only fallback** — `startCapture()` now attempts "full" mode first (video + system audio + mic). If the renderer crashes, it automatically destroys the window, creates a fresh one, and retries in "audio-only" mode (mic only — no `chromeMediaSource: 'desktop'` calls at all). This completely avoids the Chromium renderer kill.
2. **Capture mode support** — The renderer now receives a `mode` parameter ('full' or 'audio-only') and skips desktop capture API calls in audio-only mode.
3. **Refactored `_createCaptureWindow()` and `_launchCapture(mode)`** — Separated window creation and launch logic so the retry can reuse the same pattern cleanly.
4. **Renderer console forwarding** — All logs from the hidden capture window now appear in the terminal as `[capture-renderer] [LOG/WARN/ERROR] ...`
5. **Chunk flow monitoring** — Module-level counters track chunks received. A 5-second post-start monitor warns if no data is flowing. Stop summary reports final chunk count.
6. **Renderer-side diagnostics** — Logs tracks, MIME type, MediaRecorder state, and per-chunk byte counts.

**Key files modified:** `src/audioCapture.js` (major rewrite of startCapture), `src/audioCapture.html` (mode-aware capture)

**Bug fix (part 2):** The initial retry wasn't triggering because `_launchCapture` resolved after Phase 1 (HTML loaded), but the crash happened during Phase 2 (getUserMedia). Restructured to a two-phase wait:
- Phase 1: Wait for `audio-capture-ready` (HTML loaded, listeners registered)
- Phase 2: Wait for `audio-capture-recording` (MediaRecorder.start() confirmed) — NEW IPC signal
- If the renderer crashes between phases, the promise rejects and the retry fires

**Additional files modified:** `src/audioCapturePreload.js` (added `sendRecordingStarted`)

**What will happen on next recording:**
- If screen recording permission is denied: full mode crashes during Phase 2, auto-retry in audio-only mode captures mic audio successfully
- If screen recording permission is granted: full mode captures video + system audio + mic
- Either way, audio data flows to disk and the transcription pipeline receives a valid file

**Do NOT push to GitHub until explicitly asked.**

---

## Session Summary: 2026-04-13 (continued)

**Focus:** Full pipeline fix — WAV conversion, file validation, and transcription reliability.

**What was accomplished (newest first):**
1. **Created shared `ffmpegHelper.js` module** — consolidates ffmpeg/ffprobe path resolution (was duplicated in 3 files), adds `diagnose()`, `validateMediaFile()`, and `convertToWav()` utilities
2. **Hardened `_finaliseFile()` in audioCapture.js** — added fsync to force OS flush, file-size validation before rename, 10s safety timeout, and handles premature `_closeWriteStream()` calls
3. **Rewrote `convertToOutputFormats()` in audioCapture.js** — WAV conversion now runs first (critical path), pre-validates input WebM and ffmpeg availability, logs detailed diagnostics on failure, uses shared `ffmpegHelper.convertToWav()`
4. **Added file validation before transcription enqueue in main.js** — validates file exists and meets minimum size before enqueuing, warns when falling back to raw WebM
5. **Improved `getDuration()` in audioSplitter.js** — pre-validates input file with actionable error messages, uses shared ffmpegHelper for WAV decode fallback, includes format/size info in all error messages
6. **Eliminated duplicate ffmpeg resolution** — audioCapture.js, audioSplitter.js, and whisperProvider.js all now delegate to ffmpegHelper.js

**New files:** `src/ffmpegHelper.js`

**Key files modified:** `src/audioCapture.js`, `src/main.js`, `src/transcription/audioSplitter.js`, `src/transcription/whisperProvider.js`

**Root cause addressed:** `convertToOutputFormats()` was failing silently (resolving with `wavPath: null`), causing the transcription queue to receive a raw WebM file. The WebM, produced by MediaRecorder without duration headers, then failed in the chunked pipeline's `getDuration()`. The fix ensures WAV conversion either succeeds with validation or fails with clear diagnostics.

**What still needs testing:**
- End-to-end: start recording → stop → WAV conversion → auto-transcription
- Verify ffmpeg-static binary works for WAV extraction
- Check that `_finaliseFile()` fsync doesn't cause slowdowns
- Test with short recordings (< 5s) and long recordings (> 10 min)
- Model download from Settings tab
- Packaged build (`npm run build:mac`)

**Do NOT push to GitHub until explicitly asked.**

---

## Session Summary: 2026-04-13

**Focus:** Fix recording pipeline and transcription engine stability.

**What was accomplished (newest first):**
1. Fixed "Cannot determine duration" for WebM files — added WAV-decode fallback for files without duration headers (MediaRecorder WebM)
2. Added setup (5 min) and transcription (10 min) timeouts to WorkerProvider — prevents queue from hanging forever on slow WASM model loading
2. Pre-installed ONNX runtime shim (`onnxruntime-node` → `onnxruntime-web`) so transcription uses WASM instead of crashing native bindings
2. Fixed false screen recording permission denial (unreliable `getMediaAccessStatus` in dev mode)
3. Rewrote audio capture stop flow to use `executeJavaScript()` instead of unreliable IPC events
4. Moved all ONNX/transcription work to a child process via `WorkerProvider` (crash isolation)
5. Prevented stale transcription queue from auto-processing on startup (crash loop prevention)
6. Fixed startup crash from loading ONNX at boot (`require.resolve` instead of `import`)
7. Fixed audio capture timeout (renderer `sendCaptureStop()` always fires)
8. Fixed recording state machine deadlock (`cancelRecording()` handles STOPPING state)
9. Fixed `@xenova/transformers` ESM import error (`await import()` instead of `require()`)
10. Wired appLogger into core modules for visible log output
11. Added transcription pre-flight checks and download progress forwarding
12. Fixed recording pipeline (track validation, ready-signal race condition, MIME selection)
13. Added Quick Record button, permission checks, error surfacing to UI
14. Implemented screen+audio recording with MP4/WAV export

**Key files modified:** `src/main.js`, `src/audioCapture.js`, `src/audioCapture.html`, `src/transcription/whisperProvider.js`, `src/transcription/queue.js`, `scripts/install-onnx-shim.js` (new), `package.json`

**Do NOT push to GitHub until explicitly asked.**

---

## 2026-04-13 — Fix "Cannot determine duration" for WebM Files

**Problem:** Transcription fails with `Cannot determine duration of .../recording.webm`. The chunked pipeline needs to know the total duration to split the file, but WebM files from MediaRecorder often have no duration header (they're written as a live stream).
**Root cause:** `getDuration()` in `audioSplitter.js` tries ffprobe (not shipped with ffmpeg-static) then `ffmpeg -i` (which can't determine duration for headerless WebM). Both fail, and there's no further fallback.
**Fix:** Added a third fallback in `getDuration()`: convert the file to 16kHz mono WAV via ffmpeg, then calculate duration from the WAV file size (`(fileSize - 44) / 32000`). WAV files always have deterministic size-to-duration mapping. The temp WAV is cleaned up after measurement.

**Files modified:** `src/transcription/audioSplitter.js`

---

## 2026-04-13 — Add Timeouts to WorkerProvider Setup and Transcription

**Problem:** Transcription jobs start but hang forever in "pending" state. The ONNX WASM backend loads successfully (no more SIGTRAP), but `WorkerProvider.setup()` and `_transcribeOnce()` have no timeouts — if the child process stalls during model loading or inference, the queue blocks indefinitely.
**Root cause:** No timeout on the setup or transcription promises in WorkerProvider. The WASM backend is significantly slower than native, and larger models (whisper-medium) may take extremely long or hang entirely under WASM.
**Fix:** Added timeouts to both operations in `workerProvider.js`:
  - `_setupOnce()`: 5-minute timeout, resets on each progress callback (so active downloads don't time out)
  - `_transcribeOnce()`: 10-minute timeout, resets on each chunk callback (so long files making progress don't time out)
  - Both timeouts kill the child process and reject with a helpful error message suggesting a smaller model

**Files modified:** `src/transcription/workerProvider.js`

---

## 2026-04-13 — Pre-install ONNX Runtime Shim to Prevent SIGTRAP in Child Process

**Problem:** Even with WorkerProvider (child process), transcription crashes with SIGTRAP. The child process loads `onnxruntime-node` native bindings which are incompatible with macOS, causing the same crash in the child.
**Root cause:** `@xenova/transformers/src/backends/onnx.js` has a static ESM import `import * as ONNX_NODE from 'onnxruntime-node'` that loads the native addon immediately on import. The runtime shim in `whisperWorker.js` was supposed to intercept this by creating a fake package at `@xenova/transformers/node_modules/onnxruntime-node/`, but the shim wasn't being created (likely a path resolution issue in the forked child process).
**Fix:** Three-part fix:
  1. Pre-created the shim package at `node_modules/@xenova/transformers/node_modules/onnxruntime-node/` that re-exports `onnxruntime-web` (WASM, no native addon). ESM resolution finds this before the real native package.
  2. Added `scripts/install-onnx-shim.js` postinstall script so the shim survives `npm install`.
  3. Updated `whisperProvider.js` to remove the `'cpu'` execution provider that `onnx.js` adds for Node.js environments — `onnxruntime-web` only supports `'wasm'`.

**Files modified:** `src/transcription/whisperProvider.js`, `package.json`, `scripts/install-onnx-shim.js` (new), `node_modules/@xenova/transformers/node_modules/onnxruntime-node/` (new shim)

---

## 2026-04-13 — Fix False Screen Recording Permission Denial

**Problem:** Recording fails immediately with "Screen recording permission: denied" even though the user has granted permission in System Settings.
**Root cause:** `systemPreferences.getMediaAccessStatus('screen')` is unreliable in Electron. It returns `'denied'` when running in dev mode (`npm start`) because the process identity is "Electron" not the signed app bundle. The permission check was a hard gate that blocked recording from even attempting to start.
**Fix:** Changed the screen permission check from a blocking guard to an advisory log. The actual capture APIs (`desktopCapturer.getSources()`, `getUserMedia()`) handle permission enforcement reliably — if permission is truly missing, they will fail with a meaningful error. The pre-check now only logs the status for diagnostics.

**Files modified:** `src/main.js`

---

## 2026-04-13 — Rewrite Audio Capture Stop to Use executeJavaScript

**Problem:** `stopCapture()` times out after 10 seconds with "Audio capture timeout". The IPC event chain (main sends `audio-capture-stop` → renderer listens via `ipcRenderer.on` → renderer sends `audio-capture-stopped` back) is unreliable — the renderer never responds to the stop signal.
**Root cause:** The IPC event-based stop pattern has multiple failure modes: the renderer's `ipcRenderer.on` listener may not fire, the hidden BrowserWindow may be throttled by the OS despite `backgroundThrottling: false`, or the event delivery chain through contextBridge may silently fail.
**Fix:** Complete rewrite of `stopCapture()` in `audioCapture.js`:
  - **Primary mechanism changed from IPC events to `executeJavaScript()`**: Directly invokes the stop sequence in the renderer's JS context, bypassing the entire IPC event delivery chain. This is a direct call that returns a promise.
  - Guard: if the capture window is already destroyed, immediately finalise the file
  - `render-process-gone` listener detects renderer crashes instantly
  - **Always saves the recording**: Even on timeout or crash, the function finalises whatever data was streamed to disk. The function no longer throws on timeout — it always returns `{ filePath, duration }`.
  - Fixed bug where calling `_closeWriteStream()` before `_finaliseFile()` would null the stream reference and skip the temp→final rename

**Files modified:** `src/audioCapture.js`

---

## 2026-04-13 — Fix SIGTRAP Crash: Move ONNX Runtime to Child Process

**Problem:** Any operation that loaded `@xenova/transformers` (model download, transcription) crashed the app with SIGTRAP. The ONNX Runtime native bindings are incompatible with Electron 28's Node.js environment. Loading them in the main process triggered a native assertion failure that kills the entire app.
**Root cause:** `main.js` used `WhisperProvider` directly, which calls `await import('@xenova/transformers')` in the Electron main process. The existing `WorkerProvider` (which runs ONNX in a separate child process via `child_process.fork()`) was already built but not wired in.
**Fix:** Replaced all `WhisperProvider` usage in `main.js` with `WorkerProvider`:
  - Import changed from `whisperProvider` to `workerProvider`
  - `download-model` IPC handler now uses `WorkerProvider` (child process) instead of `WhisperProvider` (main process). The child is disposed after download completes.
  - Transcription queue provider changed from `WhisperProvider` to `WorkerProvider`
  With `WorkerProvider`, ONNX loads in a forked child process (`whisperWorker.js`) which also installs an onnxruntime-node → onnxruntime-web shim. If ONNX still crashes, only the child process dies — the main Electron app stays alive and shows an error message.

**Files modified:** `src/main.js`

---

## 2026-04-13 — Fix SIGTRAP Crash on Startup from ONNX Runtime

**Problem:** The app crashed immediately on launch with `SIGTRAP` (native assertion failure). The ONNX native bindings loaded by `@xenova/transformers` are incompatible with the current Electron version. A stale transcription job persisted in `transcription-queue.json` from a previous crash triggered the queue to auto-process on startup, which called `whisperProvider.setup()` → `import('@xenova/transformers')` → ONNX load → SIGTRAP crash.
**Fix:** Removed automatic queue processing on startup in `queue.js init()`. Persisted jobs are preserved but only processed when new jobs are enqueued during the session or the user manually retries. This prevents ONNX from loading during startup.
**Recovery:** Users who have a stale queue file need to delete it:
  `rm ~/Library/Application\ Support/demo-assistant/transcription-queue.json`

**Files modified:** `src/transcription/queue.js`

---

## 2026-04-13 — Fix Startup Crash from @xenova/transformers Pre-flight Import

**Problem:** The app crashed on launch after the previous ESM import fix. The pre-flight check used `await import('@xenova/transformers')`, which fully loaded the ONNX runtime and its native bindings at startup. If the native bindings were incompatible or threw, the error became an unhandled rejection inside the `async` `.then()` callback, crashing the Electron process.
**Fix:** Replaced `await import()` with `require.resolve()` which only checks that the package exists in `node_modules` without loading it. Reverted `.then(async () => {` back to `.then(() => {`. The actual ESM import still happens lazily in `whisperProvider.js` when transcription is requested — wrapped in proper try/catch.

**Files modified:** `src/main.js`

---

## 2026-04-13 — Fix Audio Capture Timeout on Stop

**Problem:** Clicking Stop produced `"Audio capture timeout"` after 10 seconds. The renderer's `stopCapture()` wrapped the entire function — including the `sendCaptureStop()` IPC call — in a single try/catch. If anything threw (MediaRecorder shutdown, stream cleanup), the catch block sent `audio-capture-error` but never sent `audio-capture-stopped`. The main process only listened for `audio-capture-stopped`, so it waited the full 10s and timed out.
**Secondary issue:** The polling loop waiting for `mediaRecorder.state === 'inactive'` had no timeout — if the MediaRecorder hung, the renderer polled forever.

**Changes:**
- `src/audioCapture.html`: Restructured `stopCapture()` so the `sendCaptureStop()` call is ALWAYS reached regardless of whether MediaRecorder shutdown throws. Added a 5-second safety timeout to the MediaRecorder inactive-polling loop. Stream cleanup is now best-effort in its own try/catch.
- `src/audioCapture.js`: Added `audio-capture-error` as a fallback termination signal in `stopCapture()` so a renderer error triggers cleanup within 500ms instead of waiting the full 10s timeout.

**Files modified:** `src/audioCapture.html`, `src/audioCapture.js`

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
