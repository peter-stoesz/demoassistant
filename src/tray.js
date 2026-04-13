'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');

let trayInstance = null;

function buildTrayIcon() {
  const iconPaths = [
    path.join(__dirname, '..', 'assets', 'tray-icon.png'),
    path.join(process.resourcesPath || '', 'assets', 'tray-icon.png')
  ];

  for (const p of iconPaths) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          if (process.platform === 'darwin') {
            return img.resize({ width: 16, height: 16 });
          }
          return img.resize({ width: 32, height: 32 });
        }
      }
    } catch (_) {}
  }

  return generateFallbackIcon();
}

function generateFallbackIcon() {
  const size = process.platform === 'darwin' ? 16 : 32;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="#00BCD4" opacity="0.9"/>
      <text x="${size / 2}" y="${size / 2 + Math.round(size * 0.15)}" text-anchor="middle" font-size="${Math.round(size * 0.55)}" font-family="Arial" fill="white" font-weight="bold">D</text>
    </svg>
  `;
  const svgBase64 = Buffer.from(svg.trim()).toString('base64');
  try {
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${svgBase64}`);
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

function buildContextMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit, getRecentTranscripts, onOpenTranscript }) {
  const check = (enabled) => enabled ? '✓ ' : '✗ ';
  const isMac = process.platform === 'darwin';
  const mod   = isMac ? '⌘' : 'Ctrl';

  // Phase 3c: hotkey health status
  let hotkeyStatusLabel = '✓ All Hotkeys Active';
  let hotkeyStatusColor = true; // enabled = dimmed (informational)
  if (hotkeyManager) {
    const status = hotkeyManager.getStatus();
    if (!status.allHealthy) {
      const failedCount = status.entries.filter(e => !e.healthy).length;
      hotkeyStatusLabel = `⚠ ${failedCount} Hotkey${failedCount !== 1 ? 's' : ''} Failed`;
    }
  }

  // Build dynamic hotkey labels from config
  const hotkeys = hotkeyManager ? hotkeyManager.getFeatureHotkeys() : {};
  const formatAccel = (accel) => {
    if (!accel) return '';
    return accel
      .replace('CommandOrControl', mod)
      .replace(/\+/g, '+');
  };

  const menu = Menu.buildFromTemplate([
    {
      label: 'Demo Assistant',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Snippet Manager',
      accelerator: isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S',
      click: onOpenSnippetManager
    },
    { type: 'separator' },
    {
      label: 'Features',
      enabled: false
    },
    {
      label: `${check(featureState.sonarEnabled)}Sonar Blip`,
      click: () => {
        onToggleFeature('sonarEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.selectionBoxEnabled)}Yellow Selection Box`,
      click: () => {
        onToggleFeature('selectionBoxEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.autofillEnabled)}Smart Paste Autofill`,
      click: () => {
        onToggleFeature('autofillEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.cursorHighlightEnabled)}Cursor Highlighter`,
      click: () => {
        onToggleFeature('cursorHighlightEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.spotlightEnabled)}Spotlight / Dim`,
      click: () => {
        onToggleFeature('spotlightEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.freezeFrameEnabled)}Freeze Frame`,
      click: () => {
        onToggleFeature('freezeFrameEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.annotationEnabled)}On-Screen Annotations`,
      click: () => {
        onToggleFeature('annotationEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.zoomLensEnabled)}Zoom Lens`,
      click: () => {
        onToggleFeature('zoomLensEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.cueCardEnabled)}Cue Cards`,
      click: () => {
        onToggleFeature('cueCardEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    {
      label: `${check(featureState.recordingEnabled)}Recording`,
      click: () => {
        onToggleFeature('recordingEnabled');
        rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
      }
    },
    { type: 'separator' },
    {
      label: 'Hotkeys',
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.snippetManager || 'CommandOrControl+Shift+S')}  — Snippet Manager`,
      enabled: false
    },
    {
      label: `${mod}+Shift+F1-F9 — Type Snippet`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.sonar || 'CommandOrControl+Shift+X')}  — Sonar Blip`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.selection || 'CommandOrControl+Shift+D')}  — Draw Selection Box`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.cursorHighlight || 'CommandOrControl+Shift+H')}  — Toggle Cursor Highlight`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.spotlight || 'CommandOrControl+Shift+L')}  — Toggle Spotlight`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.freezeFrame || 'CommandOrControl+Shift+Z')}  — Freeze / Unfreeze Screen`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.annotation || 'CommandOrControl+Shift+A')}  — Toggle Annotation Mode`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.annotationClear || 'CommandOrControl+Shift+C')}  — Clear Annotations`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.zoomLens || 'CommandOrControl+Shift+M')}  — Toggle Zoom Lens`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.cueCard || 'CommandOrControl+Shift+N')}  — Toggle Cue Cards`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.cueCardNext || 'CommandOrControl+Shift+Right')}  — Next Cue Card`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.cueCardPrev || 'CommandOrControl+Shift+Left')}  — Previous Cue Card`,
      enabled: false
    },
    {
      label: `${formatAccel(hotkeys.recordToggle || 'CommandOrControl+Shift+R')}  — Start/Stop Recording`,
      enabled: false
    },
    { type: 'separator' },
    // Phase 3c: hotkey health indicator + manual re-register
    {
      label: hotkeyStatusLabel,
      enabled: false
    },
    {
      label: 'Re-register Hotkeys',
      click: () => {
        if (onReregisterHotkeys) onReregisterHotkeys();
        // Rebuild menu after a short delay to reflect new status
        setTimeout(() => {
          rebuildMenu({ featureState, hotkeyManager, onOpenSnippetManager, onToggleFeature, onReregisterHotkeys, onQuit });
        }, 2000);
      }
    },
    { type: 'separator' },
    // Sprint 6 — Recent Transcripts
    {
      label: 'Recent Transcripts',
      enabled: false
    },
    ...buildRecentTranscriptsItems(getRecentTranscripts, onOpenTranscript),
    { type: 'separator' },
    {
      label: 'Quit Demo Assistant',
      accelerator: isMac ? 'Cmd+Q' : 'Alt+F4',
      click: onQuit
    }
  ]);

  return menu;
}

function buildRecentTranscriptsItems(getRecentTranscripts, onOpenTranscript) {
  if (typeof getRecentTranscripts !== 'function') {
    return [{ label: '  (none)', enabled: false }];
  }

  try {
    const recent = getRecentTranscripts();
    if (!recent || recent.length === 0) {
      return [{ label: '  (none)', enabled: false }];
    }

    return recent.slice(0, 5).map(t => {
      const date = new Date(t.createdAt);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const durationMin = t.duration > 0 ? `${Math.round(t.duration / 60)} min` : '';
      const label = `  ${t.oppLabel || 'Recording'} — ${dateStr}${durationMin ? ` (${durationMin})` : ''}`;

      return {
        label,
        click: () => {
          if (typeof onOpenTranscript === 'function') onOpenTranscript(t.id);
        }
      };
    });
  } catch (e) {
    return [{ label: '  (error loading)', enabled: false }];
  }
}

function rebuildMenu(opts) {
  if (trayInstance) {
    trayInstance.setContextMenu(buildContextMenu(opts));
  }
}

function setupTray(opts) {
  const icon = buildTrayIcon();
  trayInstance = new Tray(icon);

  trayInstance.setToolTip('Demo Assistant — Running');

  if (process.platform === 'darwin') {
    trayInstance.setTitle('');
  }

  const menu = buildContextMenu(opts);
  trayInstance.setContextMenu(menu);

  if (process.platform !== 'darwin') {
    trayInstance.on('click', () => {
      opts.onOpenSnippetManager();
    });
  }

  trayInstance.on('double-click', () => {
    opts.onOpenSnippetManager();
  });

  return trayInstance;
}

module.exports = { setupTray, rebuildMenu };
