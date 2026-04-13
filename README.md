# Demo Assistant

Cross-platform screen overlay toolkit for live product demonstrations, built with Electron. Runs as a lightweight always-on-top overlay with a full-featured management window for snippets, cue cards, recordings, transcription, and more.

## Features

**Overlay Effects**

- **Sonar Blip** — Expanding coral ring animation on every mouse click (~420ms duration)
- **Selection Box** — Hotkey + drag to draw a highlighted yellow rectangle that persists for 2 seconds then fades
- **Cursor Highlight** — Persistent visual highlight around the mouse cursor
- **Spotlight** — Dims the screen except for a focused area around the cursor
- **Freeze Frame** — Captures and freezes the current screen as a static overlay (requires Screen Recording permission on macOS)
- **Annotations** — Freehand drawing mode on the screen overlay with undo and clear controls
- **Zoom Lens** — Magnified view window that follows the cursor

**Productivity Tools**

- **Smart Paste / Autofill** — Predefined text snippets typed character-by-character (15-70ms adaptive delay) to simulate natural typing. Supports up to 9 hotkey-triggered snippets.
- **Cue Cards** — Floating presentation notes with multiple card sets, navigable via hotkeys (next/previous)
- **Account / Opportunity Tracker** — CRUD interface for demo opportunities with CSV bulk import and flexible column mapping

**Recording and Transcription**

- **Audio Recording** — System audio + microphone capture via a hidden BrowserWindow using MediaRecorder API. Supports full capture (system + mic) with automatic fallback to mic-only when Screen Recording permission is denied.
- **Recording Management** — State machine lifecycle (Idle, Prompting, Recording, Paused, Stopping, Processing) with duration timer, pause/resume, and per-opportunity tagging
- **Whisper Transcription** — Local speech-to-text powered by @xenova/transformers (Whisper ONNX models). Supports multiple model sizes from Tiny (~75 MB) to Large v3 (~3 GB) in both English-only and multilingual variants.
- **Transcription Queue** — FIFO job processing with persistence, progress streaming, and retry support
- **Live Transcription View** — Near-real-time display of transcription segments as they are processed
- **Model Management** — Download and manage Whisper models from the Settings tab with progress tracking and Hugging Face links

**Application**

- **System Tray** — Launches silently to system tray with full tray menu for all features
- **Multi-Display** — One overlay per display, auto-recreates when displays change
- **Customizable Hotkeys** — All shortcuts are configurable via the UI and persisted to hotkeys.json. Includes validation (ASCII-only) and health monitoring with automatic re-registration.
- **Structured Logging** — JSON-lines application logger with ring buffer, level/category filtering, search, and log rotation (5 MB)
- **Disk Management** — Storage usage display, configurable auto-cleanup of old recordings, low-disk warnings

## Project Structure

```
demo-assistant/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main.js                  # Electron main process, IPC handlers, window management
│   ├── preload.js               # Context bridge (IPC security layer)
│   ├── overlay.html             # Transparent fullscreen overlay canvas
│   ├── overlay.js               # Sonar, selection box, annotations, zoom rendering
│   ├── autofill.js              # Smart typing engine with adaptive delays
│   ├── tray.js                  # System tray menu and icon management
│   ├── hotkeyManager.js         # Centralized hotkey registration with health monitoring
│   ├── snippetManager.html      # Main management window UI
│   ├── snippetManager.css       # Styles for the management window
│   ├── snippetManager.js        # Tab-based UI logic (snippets, cue cards, accounts, etc.)
│   ├── recordingManager.js      # Recording state machine
│   ├── audioCapture.js          # Audio capture orchestrator with permission checks
│   ├── audioCapture.html        # Hidden audio capture renderer
│   ├── audioCapturePreload.js   # Preload for audio capture window
│   ├── recordingModal.html      # Opportunity picker for recordings
│   ├── recordingModalPreload.js # Preload for recording modal
│   ├── transcriptStore.js       # Transcript index and file management
│   ├── transcriptionConfig.js   # Transcription settings persistence
│   ├── opportunityStore.js      # Account/opportunity CRUD with duplicate detection
│   ├── csvImporter.js           # CSV parsing with flexible column mapping
│   ├── appLogger.js             # Structured JSON-lines logger
│   ├── cueCard.html             # Cue card display window
│   ├── cueCardPreload.js        # Preload for cue card window
│   ├── cueCards.json            # Default cue card sets
│   ├── zoomLens.html            # Magnified view window
│   ├── zoomLensPreload.js       # Preload for zoom lens
│   ├── floatingPanel.js         # Floating UI panel component
│   └── transcription/
│       ├── provider.js          # Abstract transcription provider base class
│       ├── queue.js             # FIFO transcription job queue with persistence
│       └── whisperProvider.js   # Whisper implementation via @xenova/transformers
├── scripts/
│   ├── afterPack.js             # Build hook: strips macOS xattrs before codesign
│   └── generate-icons.py        # Icon generation script (16px-1024px)
├── build/
│   ├── entitlements_mac.plist   # macOS entitlements (screen capture, JIT)
│   ├── installer.nsh            # NSIS custom install/uninstall with auto-start
│   └── license.txt              # MIT license for installer
└── assets/                      # Icons (icns, ico, png at multiple sizes, tray-icon)
```

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode (enables DevTools)
npm run dev

# Run in production mode
npm start
```

## Building Installers

```bash
# Build both macOS and Windows
npm run build

# macOS only (zip — x64 + arm64)
npm run build:mac

# Windows only (NSIS installer + portable exe)
npm run build:win

# Package without building distributable
npm run pack
```

Output goes to `dist/`.

## Hotkeys

All hotkeys use Cmd (macOS) or Ctrl (Windows/Linux) as the modifier. Hotkeys are fully customizable from the management window.

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+Shift+X | Sonar Blip toggle |
| Cmd/Ctrl+Shift+D | Selection Box toggle |
| Cmd/Ctrl+Shift+H | Cursor Highlight toggle |
| Cmd/Ctrl+Shift+S | Open Management Window |
| Cmd/Ctrl+Shift+L | Spotlight toggle |
| Cmd/Ctrl+Shift+Z | Freeze Frame toggle |
| Cmd/Ctrl+Shift+A | Annotation Mode toggle |
| Cmd/Ctrl+Shift+C | Clear Annotations |
| Cmd/Ctrl+Shift+M | Zoom Lens toggle |
| Cmd/Ctrl+Shift+N | Cue Cards toggle |
| Cmd/Ctrl+Shift+Right | Next Cue Card |
| Cmd/Ctrl+Shift+Left | Previous Cue Card |
| Cmd/Ctrl+Shift+R | Recording toggle |
| Cmd/Ctrl+Alt+B/E/F/G/I/J/K/O/P | Type Snippet 1-9 |

## Management Window Tabs

| Tab | Purpose |
|---|---|
| Snippets | Create, edit, reorder text snippets with hotkey assignments |
| Cue Cards | Manage presentation note sets with card-by-card navigation |
| Accounts | Track demo opportunities with search, CSV import, and notes |
| Recordings | Control audio recording, view history, tag to opportunities |
| Transcription | View live and completed transcriptions, set output folder |
| Settings | Whisper model selection and download, storage management |
| Logs | Filterable application event log with search and detail view |

## Data Storage

All user data is stored in Electron's userData directory:

- **macOS**: `~/Library/Application Support/demo-assistant/`
- **Windows**: `%APPDATA%\demo-assistant\`
- **Linux**: `~/.config/demo-assistant/`

Stored files include: `snippets.json`, `opportunities.json`, `transcription-config.json`, `transcripts.json`, `hotkeys.json`, and subdirectories for `recordings/`, `transcripts/`, and `logs/`.

## Dependencies

| Package | Purpose |
|---|---|
| @xenova/transformers | Local Whisper transcription (ES Module, loaded via dynamic import) |
| papaparse | CSV parsing for opportunity import |
| @jitsi/robotjs (optional) | Native keyboard simulation for character-by-character typing |
| electron | Application framework (v28+) |
| electron-builder | Packaging and distribution |

## Notes

- The overlay is fully click-through by default. It only becomes interactive when specific features (selection box, annotations) are activated.
- The app launches silently to the system tray with no splash screen.
- Without `@jitsi/robotjs`, snippet typing falls back to clipboard paste.
- macOS Screen Recording permission is required for Freeze Frame and full audio capture. The app detects permission status and falls back to mic-only recording when denied.
- Whisper models are downloaded on demand from Hugging Face and cached locally in the models directory.
- Hotkey health is monitored every 60 seconds and shortcuts are automatically re-registered after sleep/wake or display changes.
