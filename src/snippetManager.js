'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let snippets = [];
let isDirty = false;
let nextId = 100;

// ─── DOM References ───────────────────────────────────────────────────────────

const snippetsList = document.getElementById('snippetsList');
const emptyState   = document.getElementById('emptyState');
const snippetCount = document.getElementById('snippetCount');
const btnAdd       = document.getElementById('btnAdd');
const btnSave      = document.getElementById('btnSave');
const btnClose     = document.getElementById('btnClose');
const btnHelp      = document.getElementById('btnHelp');
const hotkeyPanel  = document.getElementById('hotkeyPanel');
const toast        = document.getElementById('toast');

// Phase 5b: hotkey customization elements
const btnCustomize     = document.getElementById('btnCustomize');
const customizePanel   = document.getElementById('customizePanel');
const hotkeyStatusIcon = document.getElementById('hotkeyStatusIcon');

// ─── Platform-aware hotkey labels ────────────────────────────────────────────

const isMac  = window.electronAPI.platform === 'darwin';
const modKey = isMac ? '⌘' : 'Ctrl';

const optKey = isMac ? '⌥' : 'Alt';
document.getElementById('kbSnippet1').textContent  = `${modKey}+${optKey}+B`;
document.getElementById('kbSnippet2').textContent  = `${modKey}+${optKey}+E`;
document.getElementById('kbSnippet3').textContent  = `${modKey}+${optKey}+F`;
document.getElementById('kbSonar').textContent     = `${modKey}+Shift+X`;
document.getElementById('kbSelect').textContent    = `${modKey}+Shift+D`;
document.getElementById('kbHighlight').textContent = `${modKey}+Shift+H`;
document.getElementById('kbManager').textContent    = `${modKey}+Shift+S`;
document.getElementById('kbSpotlight').textContent  = `${modKey}+Shift+L`;
document.getElementById('kbFreeze').textContent     = `${modKey}+Shift+Z`;
document.getElementById('kbAnnotate').textContent   = `${modKey}+Shift+A`;
document.getElementById('kbAnnClear').textContent   = `${modKey}+Shift+C`;
document.getElementById('kbZoomLens').textContent   = `${modKey}+Shift+M`;
document.getElementById('kbCueCard').textContent    = `${modKey}+Shift+N`;
document.getElementById('kbCueNext').textContent    = `${modKey}+Shift+→`;
document.getElementById('kbCuePrev').textContent    = `${modKey}+Shift+←`;

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  try {
    snippets = await window.electronAPI.getSnippets();
    renderAll();
  } catch (e) {
    showToast('Failed to load snippets', 'error');
    console.error(e);
  }

  // Phase 5b: load hotkey config and status
  await refreshHotkeyUI();

  // Load initial recording state for the controls
  loadRecordingState();
}

init();

// ─── Phase 5b: Hotkey Customization UI ───────────────────────────────────────

const HOTKEY_LABELS = {
  sonar:           'Sonar Blip',
  selection:       'Selection Box',
  cursorHighlight: 'Cursor Highlight',
  snippetManager:  'Snippet Manager',
  spotlight:       'Spotlight',
  freezeFrame:     'Freeze Frame',
  annotation:      'Annotation Mode',
  annotationClear: 'Clear Annotations',
  zoomLens:        'Zoom Lens',
  cueCard:         'Cue Cards',
  cueCardNext:     'Next Cue Card',
  cueCardPrev:     'Previous Cue Card',
  recordToggle:    'Record Toggle'
};

function formatAccelForDisplay(accel) {
  if (!accel) return '(none)';
  return accel
    .replace('CommandOrControl', modKey)
    .replace(/\+/g, ' + ');
}

async function refreshHotkeyUI() {
  try {
    const [config, status, defaults] = await Promise.all([
      window.electronAPI.getHotkeyConfig(),
      window.electronAPI.getHotkeyStatus(),
      window.electronAPI.getDefaultHotkeys()
    ]);

    // Update status indicator
    if (hotkeyStatusIcon) {
      hotkeyStatusIcon.textContent = status.allHealthy ? '✓' : '⚠';
      hotkeyStatusIcon.className = 'hotkey-status-icon ' + (status.allHealthy ? 'healthy' : 'unhealthy');
      hotkeyStatusIcon.title = status.allHealthy
        ? 'All hotkeys are active'
        : `${status.entries.filter(e => !e.healthy).length} hotkey(s) need attention`;
    }

    // Populate customize panel
    if (customizePanel) {
      const grid = customizePanel.querySelector('.customize-grid');
      if (grid) {
        grid.innerHTML = '';

        for (const [action, label] of Object.entries(HOTKEY_LABELS)) {
          const currentAccel = config[action] || defaults[action] || '';
          const entry = status.entries.find(e => e.label === label);
          const isHealthy = entry ? entry.healthy : true;

          const row = document.createElement('div');
          row.className = 'customize-row';
          row.innerHTML = `
            <span class="customize-label">${label}</span>
            <span class="customize-status ${isHealthy ? 'ok' : 'fail'}">${isHealthy ? '✓' : '✗'}</span>
            <input
              type="text"
              class="customize-input"
              data-action="${action}"
              value="${formatAccelForDisplay(currentAccel)}"
              readonly
              title="Click to record a new shortcut"
            />
            <button class="btn btn-icon btn-record" data-action="${action}" title="Record new shortcut">⌨</button>
            <button class="btn btn-icon btn-reset" data-action="${action}" title="Reset to default">↺</button>
          `;
          grid.appendChild(row);
        }

        // Attach event handlers
        grid.querySelectorAll('.btn-record').forEach(btn => {
          btn.addEventListener('click', () => startRecording(btn.dataset.action));
        });

        grid.querySelectorAll('.btn-reset').forEach(btn => {
          btn.addEventListener('click', () => resetHotkey(btn.dataset.action));
        });
      }
    }

    // Update the quick-reference hotkey labels too
    const kbSonar     = document.getElementById('kbSonar');
    const kbSelect    = document.getElementById('kbSelect');
    const kbHighlight = document.getElementById('kbHighlight');
    const kbManager   = document.getElementById('kbManager');

    if (kbSonar)     kbSonar.textContent     = formatAccelForDisplay(config.sonar).replace(/ \+ /g, '+');
    if (kbSelect)    kbSelect.textContent    = formatAccelForDisplay(config.selection).replace(/ \+ /g, '+');
    if (kbHighlight) kbHighlight.textContent = formatAccelForDisplay(config.cursorHighlight).replace(/ \+ /g, '+');
    if (kbManager)   kbManager.textContent   = formatAccelForDisplay(config.snippetManager).replace(/ \+ /g, '+');

    const kbSpotlight = document.getElementById('kbSpotlight');
    const kbFreeze    = document.getElementById('kbFreeze');
    const kbAnnotate  = document.getElementById('kbAnnotate');
    const kbAnnClear  = document.getElementById('kbAnnClear');
    if (kbSpotlight) kbSpotlight.textContent = formatAccelForDisplay(config.spotlight).replace(/ \+ /g, '+');
    if (kbFreeze)    kbFreeze.textContent    = formatAccelForDisplay(config.freezeFrame).replace(/ \+ /g, '+');
    if (kbAnnotate)  kbAnnotate.textContent  = formatAccelForDisplay(config.annotation).replace(/ \+ /g, '+');
    if (kbAnnClear)  kbAnnClear.textContent  = formatAccelForDisplay(config.annotationClear).replace(/ \+ /g, '+');

    const kbZoomLens = document.getElementById('kbZoomLens');
    const kbCueCard  = document.getElementById('kbCueCard');
    const kbCueNext  = document.getElementById('kbCueNext');
    const kbCuePrev  = document.getElementById('kbCuePrev');
    if (kbZoomLens) kbZoomLens.textContent = formatAccelForDisplay(config.zoomLens).replace(/ \+ /g, '+');
    if (kbCueCard)  kbCueCard.textContent  = formatAccelForDisplay(config.cueCard).replace(/ \+ /g, '+');
    if (kbCueNext)  kbCueNext.textContent  = formatAccelForDisplay(config.cueCardNext).replace(/ \+ /g, '+').replace('Right', '→');
    if (kbCuePrev)  kbCuePrev.textContent  = formatAccelForDisplay(config.cueCardPrev).replace(/ \+ /g, '+').replace('Left', '←');

    const kbRecordToggle = document.getElementById('kbRecordToggle');
    if (kbRecordToggle) kbRecordToggle.textContent = formatAccelForDisplay(config.recordToggle).replace(/ \+ /g, '+');

  } catch (e) {
    console.error('[snippetManager] Failed to load hotkey config:', e);
  }
}

// ─── Shortcut Recording ──────────────────────────────────────────────────────

let recordingAction = null;
let recordingInput  = null;

function startRecording(action) {
  // Cancel any existing recording
  stopRecording();

  recordingAction = action;
  recordingInput  = customizePanel.querySelector(`.customize-input[data-action="${action}"]`);

  if (recordingInput) {
    recordingInput.value = 'Press shortcut...';
    recordingInput.classList.add('recording');
  }

  document.addEventListener('keydown', handleRecordKeydown);
  document.addEventListener('keyup', handleRecordKeyup);
}

function stopRecording() {
  if (recordingInput) {
    recordingInput.classList.remove('recording');
  }
  recordingAction = null;
  recordingInput  = null;
  document.removeEventListener('keydown', handleRecordKeydown);
  document.removeEventListener('keyup', handleRecordKeyup);
}

function handleRecordKeydown(e) {
  e.preventDefault();
  e.stopPropagation();

  // Ignore bare modifier presses — wait for a non-modifier key
  if (['Control', 'Shift', 'Alt', 'Meta', 'Command'].includes(e.key)) return;

  // Escape cancels recording
  if (e.key === 'Escape') {
    stopRecording();
    refreshHotkeyUI();
    return;
  }

  // Build the accelerator string
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  // Require at least one modifier
  if (parts.length === 0) {
    if (recordingInput) recordingInput.value = 'Need modifier key...';
    return;
  }

  // Map the key to Electron accelerator format
  let keyName = e.key;
  if (keyName.length === 1) keyName = keyName.toUpperCase();
  if (keyName === ' ') keyName = 'Space';
  if (keyName.startsWith('Arrow')) keyName = keyName.replace('Arrow', '');
  parts.push(keyName);

  const accel = parts.join('+');

  // Apply the new shortcut
  applyHotkeyChange(recordingAction, accel);
  stopRecording();
}

function handleRecordKeyup(e) {
  // Not used currently but reserved for future use
}

async function applyHotkeyChange(action, accelerator) {
  try {
    const result = await window.electronAPI.setHotkeyConfig({ action, accelerator });
    if (result.success) {
      showToast(`${HOTKEY_LABELS[action]} shortcut updated`, 'success');
    }
  } catch (e) {
    showToast('Failed to update shortcut', 'error');
    console.error(e);
  }

  // Refresh UI to show new state
  setTimeout(refreshHotkeyUI, 1500);
}

async function resetHotkey(action) {
  try {
    const defaults = await window.electronAPI.getDefaultHotkeys();
    const defaultAccel = defaults[action];
    if (defaultAccel) {
      await applyHotkeyChange(action, defaultAccel);
    }
  } catch (e) {
    showToast('Failed to reset shortcut', 'error');
    console.error(e);
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  const cards = snippetsList.querySelectorAll('.snippet-card');
  cards.forEach(c => c.remove());

  if (snippets.length === 0) {
    emptyState.style.display = 'flex';
  } else {
    emptyState.style.display = 'none';
    snippets.forEach((snippet, index) => {
      const card = createSnippetCard(snippet, index);
      snippetsList.appendChild(card);
    });
  }

  updateCount();
}

function createSnippetCard(snippet, index) {
  const card = document.createElement('div');
  card.className = 'snippet-card';
  card.dataset.id = snippet.id;

  const SNIPPET_KEY_LETTERS = ['B', 'E', 'F', 'G', 'I', 'J', 'K', 'O', 'P'];
  const optKeyLabel = isMac ? '⌥' : 'Alt';
  const isHotkeyed = index < SNIPPET_KEY_LETTERS.length;
  const hotkeyLabel = isHotkeyed
    ? `${modKey}+${optKeyLabel}+${SNIPPET_KEY_LETTERS[index]}`
    : 'No hotkey (max 9)';

  card.innerHTML = `
    <div class="snippet-header">
      <div class="snippet-index ${!isHotkeyed ? 'over-9' : ''}">${index + 1}</div>
      <span class="snippet-hotkey">${hotkeyLabel}</span>
      <div class="snippet-actions">
        <button class="btn btn-icon btn-move-up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-icon btn-move-down" title="Move down" ${index === snippets.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-danger btn-delete" title="Delete snippet">✕</button>
      </div>
    </div>
    <div class="field-row">
      <div class="field-group name-field">
        <label>Name / Alias</label>
        <input
          type="text"
          class="snippet-name"
          value="${escapeHtml(snippet.name)}"
          placeholder="e.g. greeting"
          maxlength="40"
        />
      </div>
      <div class="field-group text-field">
        <label>Text to Type</label>
        <textarea
          class="snippet-text"
          placeholder="Enter the text that will be typed when this snippet is triggered…"
          rows="2"
        >${escapeHtml(snippet.text)}</textarea>
      </div>
    </div>
  `;

  const nameInput = card.querySelector('.snippet-name');
  const textArea  = card.querySelector('.snippet-text');
  const btnUp     = card.querySelector('.btn-move-up');
  const btnDown   = card.querySelector('.btn-move-down');
  const btnDel    = card.querySelector('.btn-delete');

  nameInput.addEventListener('input', () => {
    snippet.name = nameInput.value;
    markDirty();
    card.classList.add('editing');
  });

  nameInput.addEventListener('blur', () => {
    card.classList.remove('editing');
  });

  textArea.addEventListener('input', () => {
    snippet.text = textArea.value;
    markDirty();
    card.classList.add('editing');
    autoResizeTextarea.call(textArea);
  });

  textArea.addEventListener('blur', () => {
    card.classList.remove('editing');
  });

  btnUp.addEventListener('click', () => {
    const idx = snippets.indexOf(snippet);
    if (idx > 0) {
      [snippets[idx - 1], snippets[idx]] = [snippets[idx], snippets[idx - 1]];
      markDirty();
      renderAll();
    }
  });

  btnDown.addEventListener('click', () => {
    const idx = snippets.indexOf(snippet);
    if (idx < snippets.length - 1) {
      [snippets[idx], snippets[idx + 1]] = [snippets[idx + 1], snippets[idx]];
      markDirty();
      renderAll();
    }
  });

  btnDel.addEventListener('click', () => {
    if (confirm(`Delete snippet "${snippet.name || 'Untitled'}"?`)) {
      snippets = snippets.filter(s => s.id !== snippet.id);
      markDirty();
      renderAll();
    }
  });

  // Initial auto-resize
  setTimeout(() => autoResizeTextarea.call(textArea), 0);

  return card;
}

function autoResizeTextarea() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function addSnippet() {
  const newSnippet = {
    id: nextId++,
    name: '',
    text: ''
  };
  snippets.push(newSnippet);
  markDirty();
  renderAll();

  const cards = snippetsList.querySelectorAll('.snippet-card');
  const lastCard = cards[cards.length - 1];
  if (lastCard) {
    const nameInput = lastCard.querySelector('.snippet-name');
    if (nameInput) {
      nameInput.focus();
      lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

async function saveSnippets() {
  syncFromDOM();

  const errors = [];
  snippets.forEach((s, i) => {
    if (!s.text.trim()) {
      errors.push(`Snippet ${i + 1}: text cannot be empty.`);
    }
  });

  if (errors.length > 0) {
    showToast(errors[0], 'error');
    return;
  }

  try {
    await window.electronAPI.saveSnippets(snippets);
    isDirty = false;
    updateSaveButton();
    showToast('Snippets saved successfully!', 'success');
  } catch (e) {
    showToast('Failed to save snippets', 'error');
    console.error(e);
  }
}

function syncFromDOM() {
  const cards = snippetsList.querySelectorAll('.snippet-card');
  cards.forEach((card) => {
    const id = parseInt(card.dataset.id, 10);
    const snippet = snippets.find(s => s.id === id);
    if (!snippet) return;
    const nameInput = card.querySelector('.snippet-name');
    const textArea  = card.querySelector('.snippet-text');
    if (nameInput) snippet.name = nameInput.value.trim();
    if (textArea)  snippet.text = textArea.value;
  });
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function markDirty() {
  isDirty = true;
  updateSaveButton();
}

function updateSaveButton() {
  btnSave.textContent = isDirty ? 'Save Changes *' : 'Save Changes';
  btnSave.style.borderColor = isDirty ? 'var(--warning)' : '';
  btnSave.style.color = isDirty ? 'var(--warning)' : '';
}

function updateCount() {
  const n = snippets.length;
  snippetCount.textContent = `${n} snippet${n !== 1 ? 's' : ''}`;
}

let toastTimer = null;

function showToast(message, type) {
  toast.textContent = message;
  toast.className = 'toast' + (type ? ' ' + type : '');
  toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Button Handlers ──────────────────────────────────────────────────────────

btnAdd.addEventListener('click', addSnippet);
btnSave.addEventListener('click', saveSnippets);

if (btnClose) {
  btnClose.addEventListener('click', async () => {
    if (isDirty) {
      const confirmed = confirm('You have unsaved changes. Close without saving?');
      if (!confirmed) return;
    }
    window.electronAPI.closeSnippetManager();
  });
}

btnHelp.addEventListener('click', () => {
  const visible = hotkeyPanel.style.display !== 'none';
  hotkeyPanel.style.display = visible ? 'none' : 'block';
  btnHelp.style.background = visible ? '' : 'var(--accent-dim)';
  btnHelp.style.borderColor = visible ? '' : 'var(--border-focus)';
  btnHelp.style.color = visible ? '' : 'var(--accent)';

  // Hide customize panel when showing help
  if (!visible && customizePanel) {
    customizePanel.style.display = 'none';
    if (btnCustomize) {
      btnCustomize.style.background = '';
      btnCustomize.style.borderColor = '';
      btnCustomize.style.color = '';
    }
  }
});

// Phase 5b: customize hotkeys button
if (btnCustomize) {
  btnCustomize.addEventListener('click', () => {
    const visible = customizePanel.style.display !== 'none';
    customizePanel.style.display = visible ? 'none' : 'block';
    btnCustomize.style.background = visible ? '' : 'var(--accent-dim)';
    btnCustomize.style.borderColor = visible ? '' : 'var(--border-focus)';
    btnCustomize.style.color = visible ? '' : 'var(--accent)';

    // Hide help panel when showing customize
    if (!visible) {
      hotkeyPanel.style.display = 'none';
      btnHelp.style.background = '';
      btnHelp.style.borderColor = '';
      btnHelp.style.color = '';
      refreshHotkeyUI();
    }
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Don't capture shortcuts while recording a new hotkey
  if (recordingAction) return;

  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveSnippets();
  }
  if (e.key === 'Escape') {
    if (btnClose) btnClose.click();
    else window.electronAPI.closeSnippetManager();
  }
});

// ─── Cue Card Editor (Sprint 3 — Task 3.7) ──────────────────────────────────
//
// Adds a "Cue Cards" tab in the Snippet Manager where users can create, edit,
// reorder, and delete cue cards.  The editor lives in a panel toggled via
// tabs at the top of the window.

const cueCardTab     = document.getElementById('tabCueCards');
const snippetTab     = document.getElementById('tabSnippets');
const cueCardSection = document.getElementById('cueCardSection');
const snippetSection = document.getElementById('snippetSection');
const cueCardList    = document.getElementById('cueCardList');
const cueSetSelect   = document.getElementById('cueSetSelect');
const btnAddCueCard  = document.getElementById('btnAddCueCard');
const btnNewSet      = document.getElementById('btnNewSet');

let cueCardData    = null;
let cueCardDirty   = false;

async function loadCueCardEditor() {
  try {
    cueCardData = await window.electronAPI.getCueCards();
  } catch (e) {
    cueCardData = { activeSet: 'Default', sets: { Default: [] } };
  }
  renderCueSetDropdown();
  renderCueCards();
}

function renderCueSetDropdown() {
  if (!cueSetSelect || !cueCardData) return;
  cueSetSelect.innerHTML = '';
  const sets = Object.keys(cueCardData.sets);
  sets.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === cueCardData.activeSet) opt.selected = true;
    cueSetSelect.appendChild(opt);
  });
}

function renderCueCards() {
  if (!cueCardList || !cueCardData) return;
  const setName = cueCardData.activeSet || Object.keys(cueCardData.sets)[0];
  const cards = cueCardData.sets[setName] || [];

  cueCardList.innerHTML = '';

  if (cards.length === 0) {
    cueCardList.innerHTML = '<p style="color:#666;text-align:center;padding:20px 0;">No cue cards yet. Click "Add Card" to create one.</p>';
    return;
  }

  cards.forEach((card, idx) => {
    const el = document.createElement('div');
    el.className = 'cue-card-item';
    el.innerHTML = `
      <div class="cue-card-header">
        <span class="cue-card-num">${idx + 1}</span>
        <input class="cue-card-title-input" type="text" value="${escapeAttr(card.title || '')}" placeholder="Card title" data-idx="${idx}" />
        <button class="cue-card-delete" data-idx="${idx}" title="Delete card">&times;</button>
      </div>
      <textarea class="cue-card-body-input" rows="3" placeholder="Card body (supports **bold** and line breaks)" data-idx="${idx}">${escapeHtml(card.body || '')}</textarea>
    `;
    cueCardList.appendChild(el);
  });

  // Event delegation for inputs
  cueCardList.querySelectorAll('.cue-card-title-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      const set = cueCardData.sets[cueCardData.activeSet];
      if (set && set[i]) {
        set[i].title = e.target.value;
        cueCardDirty = true;
      }
    });
  });

  cueCardList.querySelectorAll('.cue-card-body-input').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      const set = cueCardData.sets[cueCardData.activeSet];
      if (set && set[i]) {
        set[i].body = e.target.value;
        cueCardDirty = true;
      }
    });
  });

  cueCardList.querySelectorAll('.cue-card-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      const set = cueCardData.sets[cueCardData.activeSet];
      if (set) {
        set.splice(i, 1);
        cueCardDirty = true;
        renderCueCards();
        saveCueCardsToMain();
      }
    });
  });
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function saveCueCardsToMain() {
  if (!cueCardData) return;
  try {
    await window.electronAPI.saveCueCards(cueCardData);
    cueCardDirty = false;
  } catch (e) {
    console.error('Failed to save cue cards:', e);
  }
}

// Tab switching
if (cueCardTab) {
  cueCardTab.addEventListener('click', () => {
    cueCardTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    loadCueCardEditor();
  });
}

if (snippetTab) {
  snippetTab.addEventListener('click', () => {
    // Save any pending cue card changes
    if (cueCardDirty) saveCueCardsToMain();

    snippetTab.classList.add('active');
    cueCardTab.classList.remove('active');
    snippetSection.style.display = 'flex';
    cueCardSection.style.display = 'none';
  });
}

// Set selection
if (cueSetSelect) {
  cueSetSelect.addEventListener('change', (e) => {
    if (!cueCardData) return;
    // Save current set changes first
    if (cueCardDirty) saveCueCardsToMain();

    cueCardData.activeSet = e.target.value;
    saveCueCardsToMain();
    renderCueCards();
  });
}

// Add card
if (btnAddCueCard) {
  btnAddCueCard.addEventListener('click', () => {
    if (!cueCardData) return;
    const setName = cueCardData.activeSet;
    if (!cueCardData.sets[setName]) cueCardData.sets[setName] = [];
    const cards = cueCardData.sets[setName];
    const newId = cards.length > 0 ? Math.max(...cards.map(c => c.id || 0)) + 1 : 1;
    cards.push({ id: newId, title: '', body: '' });
    cueCardDirty = true;
    renderCueCards();
    saveCueCardsToMain();

    // Focus the new title input
    const inputs = cueCardList.querySelectorAll('.cue-card-title-input');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });
}

// New set
if (btnNewSet) {
  btnNewSet.addEventListener('click', () => {
    if (!cueCardData) return;
    const name = prompt('New set name:');
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (cueCardData.sets[trimmed]) {
      alert('A set with that name already exists.');
      return;
    }
    cueCardData.sets[trimmed] = [];
    cueCardData.activeSet = trimmed;
    saveCueCardsToMain();
    renderCueSetDropdown();
    renderCueCards();
  });
}

// Auto-save cue cards on blur (when user clicks away from an input)
if (cueCardList) {
  cueCardList.addEventListener('focusout', () => {
    if (cueCardDirty) saveCueCardsToMain();
  });
}

// ─── Accounts Tab (Sprint 1) ─────────────────────────────────────────────
//
// Manages opportunities: add, edit, delete, search, CSV import.

const accountTab     = document.getElementById('tabAccounts');
const accountSection = document.getElementById('accountSection');
const oppList        = document.getElementById('oppList');
const oppEmptyState  = document.getElementById('oppEmptyState');
const oppCount       = document.getElementById('oppCount');
const oppSearchInput = document.getElementById('oppSearchInput');
const btnAddOpp      = document.getElementById('btnAddOpp');
const btnImportCsv   = document.getElementById('btnImportCsv');

// Modal elements
const oppModal       = document.getElementById('oppModal');
const oppModalTitle  = document.getElementById('oppModalTitle');
const oppModalError  = document.getElementById('oppModalError');
const oppModalNumber = document.getElementById('oppModalNumber');
const oppModalAccount= document.getElementById('oppModalAccount');
const oppModalContact= document.getElementById('oppModalContact');
const oppModalNotes  = document.getElementById('oppModalNotes');
const oppModalCancel = document.getElementById('oppModalCancel');
const oppModalSave   = document.getElementById('oppModalSave');

let opportunities  = [];
let filteredOpps   = [];
let editingOppId   = null;   // null = adding, string = editing

async function loadAccountsTab() {
  try {
    opportunities = await window.electronAPI.getOpportunities();
  } catch (e) {
    opportunities = [];
    console.error('[accounts] Failed to load:', e);
  }
  applyOppFilter();
}

function applyOppFilter() {
  const query = (oppSearchInput ? oppSearchInput.value : '').trim().toLowerCase();
  if (!query) {
    filteredOpps = [...opportunities];
  } else {
    filteredOpps = opportunities.filter(o => {
      const haystack = [o.opportunityNumber, o.accountName, o.contactName].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }
  renderOppList();
}

function renderOppList() {
  // Remove existing cards (keep empty state)
  const cards = oppList.querySelectorAll('.opp-card');
  cards.forEach(c => c.remove());

  if (filteredOpps.length === 0) {
    oppEmptyState.style.display = 'flex';
  } else {
    oppEmptyState.style.display = 'none';
    filteredOpps.forEach(opp => {
      const card = createOppCard(opp);
      oppList.appendChild(card);
    });
  }

  const total = opportunities.length;
  oppCount.textContent = `${total} opportunit${total !== 1 ? 'ies' : 'y'}`;
}

function createOppCard(opp) {
  const card = document.createElement('div');
  card.className = 'opp-card';
  card.dataset.id = opp.id;

  const contactHtml = opp.contactName
    ? `<span class="opp-contact">${escapeHtml(opp.contactName)}</span>`
    : '';

  const notesHtml = opp.notes
    ? `<div class="opp-notes">${escapeHtml(opp.notes)}</div>`
    : '';

  card.innerHTML = `
    <div class="opp-header">
      <div class="opp-meta">
        <span class="opp-number">${escapeHtml(opp.opportunityNumber)}</span>
        <span class="opp-account">${escapeHtml(opp.accountName)}</span>
        ${contactHtml}
      </div>
      <div class="opp-actions">
        <button class="btn btn-icon btn-edit-opp" title="Edit">&#x270E;</button>
        <button class="btn btn-icon btn-delete-opp" title="Delete" style="color:var(--danger)">&#x2715;</button>
      </div>
    </div>
    ${notesHtml}
  `;

  const btnEdit = card.querySelector('.btn-edit-opp');
  const btnDel  = card.querySelector('.btn-delete-opp');

  btnEdit.addEventListener('click', () => openOppModal(opp));
  btnDel.addEventListener('click', () => deleteOpp(opp));

  return card;
}

function openOppModal(opp) {
  oppModalError.textContent = '';

  if (opp) {
    editingOppId = opp.id;
    oppModalTitle.textContent = 'Edit Opportunity';
    oppModalNumber.value  = opp.opportunityNumber;
    oppModalAccount.value = opp.accountName;
    oppModalContact.value = opp.contactName || '';
    oppModalNotes.value   = opp.notes || '';
  } else {
    editingOppId = null;
    oppModalTitle.textContent = 'Add Opportunity';
    oppModalNumber.value  = '';
    oppModalAccount.value = '';
    oppModalContact.value = '';
    oppModalNotes.value   = '';
  }

  oppModal.style.display = 'flex';
  oppModalNumber.focus();
}

function closeOppModal() {
  oppModal.style.display = 'none';
  editingOppId = null;
}

async function saveOppFromModal() {
  oppModalError.textContent = '';

  const data = {
    opportunityNumber: oppModalNumber.value.trim(),
    accountName:       oppModalAccount.value.trim(),
    contactName:       oppModalContact.value.trim(),
    notes:             oppModalNotes.value.trim()
  };

  if (!data.opportunityNumber) {
    oppModalError.textContent = 'Opportunity number is required.';
    oppModalNumber.focus();
    return;
  }
  if (!data.accountName) {
    oppModalError.textContent = 'Account name is required.';
    oppModalAccount.focus();
    return;
  }

  try {
    let result;
    if (editingOppId) {
      result = await window.electronAPI.updateOpportunity(editingOppId, data);
    } else {
      result = await window.electronAPI.addOpportunity(data);
    }

    if (result.success) {
      closeOppModal();
      await loadAccountsTab();
      showToast(editingOppId ? 'Opportunity updated' : 'Opportunity added', 'success');
    } else {
      oppModalError.textContent = result.error || 'Save failed.';
    }
  } catch (e) {
    oppModalError.textContent = e.message || 'Save failed.';
  }
}

async function deleteOpp(opp) {
  if (!confirm(`Delete opportunity "${opp.opportunityNumber}" (${opp.accountName})?`)) return;

  try {
    const result = await window.electronAPI.deleteOpportunity(opp.id);
    if (result.success) {
      await loadAccountsTab();
      showToast('Opportunity deleted', 'success');
    } else {
      showToast(result.error || 'Delete failed', 'error');
    }
  } catch (e) {
    showToast('Delete failed', 'error');
  }
}

async function importCsv() {
  try {
    const result = await window.electronAPI.importOpportunitiesCsv();
    if (result.canceled) return;

    if (result.success) {
      const s = result.summary;
      await loadAccountsTab();

      let msg = `Imported ${s.imported} opportunit${s.imported !== 1 ? 'ies' : 'y'}`;
      if (s.duplicates > 0) msg += `, ${s.duplicates} duplicate${s.duplicates !== 1 ? 's' : ''} skipped`;
      if (s.skipped > 0) msg += `, ${s.skipped} row${s.skipped !== 1 ? 's' : ''} skipped`;

      showToast(msg, s.imported > 0 ? 'success' : 'error');

      if (s.errors.length > 0) {
        console.warn('[accounts] CSV import errors:', s.errors);
      }
    } else {
      showToast(result.error || 'CSV import failed', 'error');
    }
  } catch (e) {
    showToast('CSV import failed', 'error');
    console.error(e);
  }
}

// ── Accounts Tab Switching ─────────────────────────────────────────────────

if (accountTab) {
  accountTab.addEventListener('click', () => {
    if (cueCardDirty) saveCueCardsToMain();

    accountTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardTab.classList.remove('active');

    accountSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    cueCardSection.style.display = 'none';

    loadAccountsTab();
  });
}

// Patch existing tab handlers to also hide account section
if (cueCardTab) {
  cueCardTab.addEventListener('click', () => {
    if (accountSection) accountSection.style.display = 'none';
    if (accountTab) accountTab.classList.remove('active');
  });
}

if (snippetTab) {
  snippetTab.addEventListener('click', () => {
    if (accountSection) accountSection.style.display = 'none';
    if (accountTab) accountTab.classList.remove('active');
  });
}

// ── Accounts Button Events ─────────────────────────────────────────────────

if (btnAddOpp) {
  btnAddOpp.addEventListener('click', () => openOppModal(null));
}

if (btnImportCsv) {
  btnImportCsv.addEventListener('click', importCsv);
}

if (oppModalCancel) {
  oppModalCancel.addEventListener('click', closeOppModal);
}

if (oppModalSave) {
  oppModalSave.addEventListener('click', saveOppFromModal);
}

// Close modal on overlay click
if (oppModal) {
  oppModal.addEventListener('click', (e) => {
    if (e.target === oppModal) closeOppModal();
  });
}

// Enter to save in modal, Escape to close
if (oppModal) {
  oppModal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveOppFromModal();
    }
    if (e.key === 'Escape') {
      closeOppModal();
    }
  });
}

// Live search with debounce
let oppSearchTimer = null;
if (oppSearchInput) {
  oppSearchInput.addEventListener('input', () => {
    if (oppSearchTimer) clearTimeout(oppSearchTimer);
    oppSearchTimer = setTimeout(applyOppFilter, 150);
  });
}

// ── Recordings Tab (Sprint 4 + recording controls) ───────────────────────────
//
// Recording controls + list of recorded/transcribed demo sessions.

const transcriptTab         = document.getElementById('tabTranscripts');
const transcriptSection     = document.getElementById('transcriptSection');
const transcriptList        = document.getElementById('transcriptList');
const transcriptEmptyState  = document.getElementById('transcriptEmptyState');
const transcriptCount       = document.getElementById('transcriptCount');
const transcriptSearchInput = document.getElementById('transcriptSearchInput');

// ── Recording Controls ──────────────────────────────────────────────────────
const btnRecStart   = document.getElementById('btnRecStart');
const btnRecPause   = document.getElementById('btnRecPause');
const btnRecResume  = document.getElementById('btnRecResume');
const btnRecStop    = document.getElementById('btnRecStop');
const recordingDot  = document.getElementById('recordingDot');
const recordingStatusLabel = document.getElementById('recordingStatusLabel');
const recordingTimer = document.getElementById('recordingTimer');

let recordingTimerInterval = null;
let localRecordingSeconds = 0;

function formatRecTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateRecordingControlsUI(state) {
  const st = state ? state.state : 'IDLE';
  const dur = state ? (state.durationSeconds || 0) : 0;

  // Update dot
  if (recordingDot) {
    recordingDot.className = 'recording-dot' +
      (st === 'RECORDING' ? ' active' : '') +
      (st === 'PAUSED' ? ' paused' : '');
  }

  // Update label
  if (recordingStatusLabel) {
    const labels = {
      'IDLE': 'Idle',
      'PROMPTING': 'Selecting...',
      'RECORDING': 'Recording',
      'PAUSED': 'Paused',
      'STOPPING': 'Stopping...',
      'PROCESSING': 'Processing...'
    };
    recordingStatusLabel.textContent = labels[st] || st;
  }

  // Update timer display
  if (recordingTimer) {
    recordingTimer.textContent = formatRecTime(dur);
    localRecordingSeconds = dur;
  }

  // Button states
  const isIdle = st === 'IDLE';
  const isRecording = st === 'RECORDING';
  const isPaused = st === 'PAUSED';

  if (btnRecStart)  { btnRecStart.disabled  = !isIdle; }
  if (btnRecPause)  { btnRecPause.disabled  = !isRecording; btnRecPause.style.display  = isPaused ? 'none' : ''; }
  if (btnRecResume) { btnRecResume.disabled = !isPaused;    btnRecResume.style.display = isPaused ? '' : 'none'; }
  if (btnRecStop)   { btnRecStop.disabled   = !(isRecording || isPaused); }

  // Manage the local timer interval
  if (isRecording && !recordingTimerInterval) {
    recordingTimerInterval = setInterval(() => {
      localRecordingSeconds++;
      if (recordingTimer) recordingTimer.textContent = formatRecTime(localRecordingSeconds);
    }, 1000);
  } else if (!isRecording && recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
}

// Button click handlers
if (btnRecStart) {
  btnRecStart.addEventListener('click', async () => {
    const result = await window.electronAPI.startRecording();
    if (!result.success) console.warn('[recordings] Start failed:', result.error);
  });
}

if (btnRecPause) {
  btnRecPause.addEventListener('click', async () => {
    const result = await window.electronAPI.pauseRecording();
    if (!result.success) console.warn('[recordings] Pause failed:', result.error);
  });
}

if (btnRecResume) {
  btnRecResume.addEventListener('click', async () => {
    const result = await window.electronAPI.resumeRecording();
    if (!result.success) console.warn('[recordings] Resume failed:', result.error);
  });
}

if (btnRecStop) {
  btnRecStop.addEventListener('click', async () => {
    const result = await window.electronAPI.stopRecording();
    if (!result.success) console.warn('[recordings] Stop failed:', result.error);
  });
}

// Listen for state changes from main process
if (window.electronAPI && window.electronAPI.onRecordingStateChange) {
  window.electronAPI.onRecordingStateChange((state) => {
    updateRecordingControlsUI(state);
  });
}

// Listen for recording errors from main process
if (window.electronAPI && window.electronAPI.onRecordingError) {
  window.electronAPI.onRecordingError((data) => {
    console.error('[recordings] Error from main:', data.message);
    showToast(data.message, 'error');
  });
}

// Load initial recording state
async function loadRecordingState() {
  try {
    const state = await window.electronAPI.getRecordingState();
    updateRecordingControlsUI(state);
  } catch (e) {
    console.error('[recordings] Failed to get initial state:', e);
  }

  // Also refresh the output folder display
  loadOutputFolderDisplay();
}

// ── Output Folder Selector ──────────────────────────────────────────────────

const outputFolderPath      = document.getElementById('outputFolderPath');
const btnSelectOutputFolder = document.getElementById('btnSelectOutputFolder');
const btnClearOutputFolder  = document.getElementById('btnClearOutputFolder');

async function loadOutputFolderDisplay() {
  try {
    const config = await window.electronAPI.getTranscriptionConfig();
    const dir = config.outputDir || '';
    updateOutputFolderUI(dir);
  } catch (e) {
    console.error('[recordings] Failed to load output folder config:', e);
  }
}

function updateOutputFolderUI(dir) {
  if (outputFolderPath) {
    if (dir) {
      outputFolderPath.textContent = dir;
      outputFolderPath.title = dir;
      outputFolderPath.classList.remove('not-set');
    } else {
      outputFolderPath.textContent = 'Not set (internal only)';
      outputFolderPath.title = 'Click Browse to select a folder';
      outputFolderPath.classList.add('not-set');
    }
  }
  if (btnClearOutputFolder) {
    btnClearOutputFolder.style.display = dir ? '' : 'none';
  }
}

if (btnSelectOutputFolder) {
  btnSelectOutputFolder.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.selectOutputFolder();
      if (!result.canceled && result.path) {
        updateOutputFolderUI(result.path);
        showToast('Output folder set: ' + result.path.split('/').pop());
      }
    } catch (e) {
      showToast('Failed to select folder', 'error');
    }
  });
}

if (btnClearOutputFolder) {
  btnClearOutputFolder.addEventListener('click', async () => {
    try {
      await window.electronAPI.clearOutputFolder();
      updateOutputFolderUI('');
      showToast('Output folder cleared — transcripts saved internally only');
    } catch (e) {
      showToast('Failed to clear folder', 'error');
    }
  });
}

const transcriptionQueueStatus = document.getElementById('transcriptionQueueStatus');

// Detail view elements
const transcriptListView    = document.getElementById('transcriptListView');
const transcriptDetailView  = document.getElementById('transcriptDetailView');
const transcriptDetailTitle = document.getElementById('transcriptDetailTitle');
const transcriptDetailMeta  = document.getElementById('transcriptDetailMeta');
const transcriptDetailContent = document.getElementById('transcriptDetailContent');
const btnBackToList         = document.getElementById('btnBackToList');
const btnExportTxt          = document.getElementById('btnExportTxt');
const btnExportMd           = document.getElementById('btnExportMd');
const btnDeleteTranscript   = document.getElementById('btnDeleteTranscript');

let transcripts = [];
let filteredTranscripts = [];
let viewingTranscriptId = null;
let viewingTranscriptContent = null;

async function loadTranscriptsTab() {
  try {
    transcripts = await window.electronAPI.getTranscripts();
  } catch (e) {
    transcripts = [];
    console.error('[transcripts] Failed to load:', e);
  }
  applyTranscriptFilter();
  updateTranscriptionQueueStatus();
}

async function updateTranscriptionQueueStatus() {
  try {
    const status = await window.electronAPI.getTranscriptionStatus();
    if (transcriptionQueueStatus) {
      const parts = [];
      if (status.pending > 0) parts.push(`${status.pending} pending`);
      if (status.processing) parts.push('1 transcribing');
      transcriptionQueueStatus.textContent = parts.length > 0 ? parts.join(', ') : '';
    }
  } catch (e) {
    // Silently fail
  }
}

function applyTranscriptFilter() {
  const query = (transcriptSearchInput ? transcriptSearchInput.value : '').trim().toLowerCase();
  if (!query) {
    filteredTranscripts = [...transcripts].sort((a, b) =>
      new Date(b.createdAt) - new Date(a.createdAt)
    );
  } else {
    // Use server-side search for content matching
    window.electronAPI.searchTranscripts(query).then(results => {
      filteredTranscripts = results;
      renderTranscriptList();
    });
    return;
  }
  renderTranscriptList();
}

function renderTranscriptList() {
  if (!transcriptList) return;

  // Remove all non-empty-state children
  const children = Array.from(transcriptList.children);
  children.forEach(c => {
    if (c !== transcriptEmptyState) c.remove();
  });

  if (transcriptCount) {
    transcriptCount.textContent = `${transcripts.length} transcript${transcripts.length !== 1 ? 's' : ''}`;
  }

  if (filteredTranscripts.length === 0) {
    if (transcriptEmptyState) transcriptEmptyState.style.display = '';
    return;
  }

  if (transcriptEmptyState) transcriptEmptyState.style.display = 'none';

  for (const t of filteredTranscripts) {
    transcriptList.appendChild(createTranscriptCard(t));
  }
}

function createTranscriptCard(t) {
  const card = document.createElement('div');
  card.className = 'transcript-card';
  card.dataset.id = t.id;

  const date = new Date(t.createdAt);
  const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const durationStr = t.duration > 0
    ? `${Math.floor(t.duration / 60)}m ${Math.round(t.duration % 60)}s`
    : '--';

  const wordStr = t.wordCount > 0 ? `${t.wordCount} words` : '';

  // Find opportunity info
  let oppLabel = t.opportunityId || 'No opportunity';
  const opp = opportunities.find(o => o.id === t.opportunityId);
  if (opp) {
    oppLabel = opp.opportunityNumber + ' — ' + opp.accountName;
  }

  card.innerHTML = `
    <div class="transcript-card-header">
      <span class="transcript-card-opp">${escapeHtml(oppLabel)}</span>
      <span class="transcript-card-status ${t.status}">${t.status}</span>
    </div>
    <div class="transcript-card-meta">
      <span>${dateStr}</span>
      <span>${durationStr}</span>
      ${wordStr ? `<span>${wordStr}</span>` : ''}
    </div>
    ${t.matchSnippet ? `<div class="transcript-card-snippet">"...${escapeHtml(t.matchSnippet)}..."</div>` : ''}
    ${t.status === 'failed' ? `<div class="transcript-card-actions"><button class="btn btn-secondary btn-sm retry-btn" data-id="${t.id}">Retry</button></div>` : ''}
  `;

  // Click to view detail (only for completed transcripts)
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('retry-btn')) return;
    if (t.status === 'completed') {
      openTranscriptDetail(t.id);
    }
  });

  // Retry button
  const retryBtn = card.querySelector('.retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await window.electronAPI.retryTranscription(t.id);
        showToast('Transcription retry queued');
        loadTranscriptsTab();
      } catch (err) {
        showToast('Retry failed', 'error');
      }
    });
  }

  return card;
}

async function openTranscriptDetail(id) {
  viewingTranscriptId = id;

  try {
    viewingTranscriptContent = await window.electronAPI.getTranscriptContent(id);
  } catch (e) {
    showToast('Failed to load transcript', 'error');
    return;
  }

  if (!viewingTranscriptContent) {
    showToast('Transcript content not available', 'error');
    return;
  }

  // Find metadata
  const t = transcripts.find(x => x.id === id);
  if (!t) return;

  // Find opportunity
  let oppLabel = t.opportunityId || 'Unknown';
  const opp = opportunities.find(o => o.id === t.opportunityId);
  if (opp) {
    oppLabel = opp.opportunityNumber + ' — ' + opp.accountName;
  }

  const date = new Date(t.createdAt);
  const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  const durationStr = t.duration > 0 ? `${Math.floor(t.duration / 60)}m ${Math.round(t.duration % 60)}s` : 'N/A';

  if (transcriptDetailTitle) {
    transcriptDetailTitle.textContent = oppLabel;
  }

  if (transcriptDetailMeta) {
    transcriptDetailMeta.innerHTML = `
      <span>Date: ${dateStr}</span>
      <span>Duration: ${durationStr}</span>
      <span>Words: ${viewingTranscriptContent.fullText.split(/\s+/).length}</span>
      <span>Language: ${viewingTranscriptContent.language || 'english'}</span>
    `;
  }

  // Render segments
  if (transcriptDetailContent) {
    if (viewingTranscriptContent.segments && viewingTranscriptContent.segments.length > 0) {
      transcriptDetailContent.innerHTML = viewingTranscriptContent.segments.map(seg => {
        const startMin = Math.floor(seg.start / 60);
        const startSec = Math.round(seg.start % 60);
        const endMin = Math.floor(seg.end / 60);
        const endSec = Math.round(seg.end % 60);
        const timeStr = `${startMin}:${String(startSec).padStart(2, '0')} — ${endMin}:${String(endSec).padStart(2, '0')}`;

        return `
          <div class="transcript-segment">
            <div class="transcript-segment-time">${timeStr}</div>
            <div class="transcript-segment-text">${escapeHtml(seg.text)}</div>
          </div>
        `;
      }).join('');
    } else {
      transcriptDetailContent.innerHTML = `<p style="color: var(--text-secondary); padding: 20px;">${escapeHtml(viewingTranscriptContent.fullText)}</p>`;
    }
  }

  // Toggle views
  if (transcriptListView) transcriptListView.style.display = 'none';
  if (transcriptDetailView) transcriptDetailView.style.display = 'flex';
}

function closeTranscriptDetail() {
  viewingTranscriptId = null;
  viewingTranscriptContent = null;

  if (transcriptListView) transcriptListView.style.display = '';
  if (transcriptDetailView) transcriptDetailView.style.display = 'none';
}

function exportTranscript(format) {
  if (!viewingTranscriptContent || !viewingTranscriptId) return;

  const t = transcripts.find(x => x.id === viewingTranscriptId);
  if (!t) return;

  let content = '';
  let filename = '';

  const opp = opportunities.find(o => o.id === t.opportunityId);
  const oppLabel = opp ? `${opp.opportunityNumber} - ${opp.accountName}` : 'transcript';
  const date = new Date(t.createdAt).toISOString().split('T')[0];

  if (format === 'txt') {
    filename = `${oppLabel}_${date}.txt`;
    content = viewingTranscriptContent.fullText;
  } else if (format === 'md') {
    filename = `${oppLabel}_${date}.md`;
    const lines = [`# Transcript: ${oppLabel}`, `**Date:** ${date}`, ''];
    if (viewingTranscriptContent.segments) {
      for (const seg of viewingTranscriptContent.segments) {
        const startMin = Math.floor(seg.start / 60);
        const startSec = Math.round(seg.start % 60);
        lines.push(`**[${startMin}:${String(startSec).padStart(2, '0')}]** ${seg.text}`);
        lines.push('');
      }
    } else {
      lines.push(viewingTranscriptContent.fullText);
    }
    content = lines.join('\n');
  }

  // Create a download via Blob
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`Exported as ${format.toUpperCase()}`);
}

async function deleteCurrentTranscript() {
  if (!viewingTranscriptId) return;

  if (!confirm('Delete this transcript and its audio file? This cannot be undone.')) return;

  try {
    const result = await window.electronAPI.deleteTranscript(viewingTranscriptId);
    if (result.success) {
      showToast('Transcript deleted');
      closeTranscriptDetail();
      loadTranscriptsTab();
    } else {
      showToast('Delete failed', 'error');
    }
  } catch (e) {
    showToast('Delete failed', 'error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Transcript Tab Switching & Events ─────────────────────────────────────────

if (transcriptTab) {
  transcriptTab.addEventListener('click', () => {
    if (cueCardDirty) saveCueCardsToMain();

    transcriptTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardTab.classList.remove('active');
    if (accountTab) accountTab.classList.remove('active');

    transcriptSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    cueCardSection.style.display = 'none';
    if (accountSection) accountSection.style.display = 'none';

    loadTranscriptsTab();
    loadRecordingState();
  });
}

// Patch existing tab handlers to also hide transcript section
if (accountTab) {
  accountTab.addEventListener('click', () => {
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (transcriptTab) transcriptTab.classList.remove('active');
  });
}

if (cueCardTab) {
  cueCardTab.addEventListener('click', () => {
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (transcriptTab) transcriptTab.classList.remove('active');
  });
}

if (snippetTab) {
  snippetTab.addEventListener('click', () => {
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (transcriptTab) transcriptTab.classList.remove('active');
  });
}

// Detail view events
if (btnBackToList) {
  btnBackToList.addEventListener('click', closeTranscriptDetail);
}

if (btnExportTxt) {
  btnExportTxt.addEventListener('click', () => exportTranscript('txt'));
}

if (btnExportMd) {
  btnExportMd.addEventListener('click', () => exportTranscript('md'));
}

if (btnDeleteTranscript) {
  btnDeleteTranscript.addEventListener('click', deleteCurrentTranscript);
}

// Transcript search with debounce
let transcriptSearchTimer = null;
if (transcriptSearchInput) {
  transcriptSearchInput.addEventListener('input', () => {
    if (transcriptSearchTimer) clearTimeout(transcriptSearchTimer);
    transcriptSearchTimer = setTimeout(applyTranscriptFilter, 250);
  });
}

// Listen for transcription progress updates
if (window.electronAPI.onTranscriptionProgress) {
  window.electronAPI.onTranscriptionProgress((data) => {
    // Refresh transcript list when a transcription completes or fails
    if (data.status === 'completed' || data.status === 'failed') {
      if (transcriptSection && transcriptSection.style.display !== 'none') {
        loadTranscriptsTab();
      }
    }
  });
}

// ── Settings Tab (Sprint 6) ───────────────────────────────────────────────────

const settingsTab     = document.getElementById('tabSettings');
const settingsSection = document.getElementById('settingsSection');

const settingModelId          = document.getElementById('settingModelId');
const settingAutoTranscribe   = document.getElementById('settingAutoTranscribe');
const settingStorageUsage     = document.getElementById('settingStorageUsage');
const settingCleanupDays      = document.getElementById('settingCleanupDays');
const settingMaxRecordingMins = document.getElementById('settingMaxRecordingMins');
const btnRunCleanup           = document.getElementById('btnRunCleanup');
const modelStatusLabel        = document.getElementById('modelStatusLabel');
const btnDownloadModel        = document.getElementById('btnDownloadModel');
const btnCancelDownload       = document.getElementById('btnCancelDownload');
const modelHubLink            = document.getElementById('modelHubLink');
const modelProgressRow        = document.getElementById('modelProgressRow');
const modelProgressFill       = document.getElementById('modelProgressFill');
const modelProgressText       = document.getElementById('modelProgressText');
const modelProgressDetail     = document.getElementById('modelProgressDetail');

let modelDownloading = false;

async function loadSettingsTab() {
  try {
    const config = await window.electronAPI.getTranscriptionConfig();

    if (settingModelId)          settingModelId.value = config.modelId || 'Xenova/whisper-base.en';
    if (settingAutoTranscribe)   settingAutoTranscribe.checked = config.autoTranscribe !== false;
    if (settingCleanupDays)      settingCleanupDays.value = config.cleanupDays || 90;
    if (settingMaxRecordingMins) settingMaxRecordingMins.value = config.maxRecordingMins || 240;

    // Load storage usage
    const usage = await window.electronAPI.getStorageUsage();
    if (settingStorageUsage) {
      settingStorageUsage.textContent = `Recordings: ${usage.recordingsMB} MB | Transcripts: ${usage.transcriptsMB} MB | Total: ${usage.totalMB} MB`;
    }

    // Check model status
    updateModelHubLink();
    await checkModelStatus();

    // Check architecture / Rosetta warning
    try {
      const archInfo = await window.electronAPI.getArchInfo();
      const warningEl = document.getElementById('rosettaWarning');
      const warningTextEl = document.getElementById('rosettaWarningText');
      if (archInfo && archInfo.isRosetta && warningEl) {
        warningEl.style.display = 'block';
        if (warningTextEl && archInfo.recommendation) {
          warningTextEl.textContent = archInfo.recommendation;
        }
      } else if (warningEl) {
        warningEl.style.display = 'none';
      }
    } catch (_) {}
  } catch (e) {
    console.error('[settings] Failed to load:', e);
  }
}

async function checkModelStatus() {
  if (!settingModelId) return;
  const modelId = settingModelId.value;

  if (modelStatusLabel) {
    modelStatusLabel.textContent = 'Checking...';
    modelStatusLabel.className = 'settings-value';
  }

  try {
    const status = await window.electronAPI.checkModelStatus(modelId);
    if (status.ready) {
      if (modelStatusLabel) {
        modelStatusLabel.textContent = `Ready (${status.cachedSizeMB} MB cached)`;
        modelStatusLabel.className = 'settings-value model-status-ready';
      }
      if (btnDownloadModel) btnDownloadModel.textContent = 'Re-download Model';
    } else {
      if (modelStatusLabel) {
        modelStatusLabel.textContent = 'Not downloaded — download required before transcription';
        modelStatusLabel.className = 'settings-value model-status-missing';
      }
      if (btnDownloadModel) btnDownloadModel.textContent = 'Download Selected Model';
    }
  } catch (e) {
    if (modelStatusLabel) {
      modelStatusLabel.textContent = 'Error checking status';
      modelStatusLabel.className = 'settings-value model-status-error';
    }
  }
}

function updateModelHubLink() {
  if (!modelHubLink || !settingModelId) return;
  const modelId = settingModelId.value;
  modelHubLink.href = `https://huggingface.co/${modelId}`;
  modelHubLink.title = `View ${modelId} on Hugging Face`;
}

function saveSettingsField(key, value) {
  const partial = {};
  partial[key] = value;
  window.electronAPI.setTranscriptionConfig(partial).catch(e => {
    console.error('[settings] Save failed:', e);
  });
}

// Models larger than this threshold get a warning under Rosetta
const LARGE_MODEL_IDS = [
  'Xenova/whisper-small', 'Xenova/whisper-small.en',
  'Xenova/whisper-medium', 'Xenova/whisper-medium.en',
  'Xenova/whisper-large-v3', 'Xenova/whisper-large-v2', 'Xenova/whisper-large'
];

let _cachedArchInfo = null;

async function getCachedArchInfo() {
  if (!_cachedArchInfo) {
    try { _cachedArchInfo = await window.electronAPI.getArchInfo(); } catch (_) {}
  }
  return _cachedArchInfo;
}

if (settingModelId) {
  settingModelId.addEventListener('change', () => {
    saveSettingsField('modelId', settingModelId.value);
    updateModelHubLink();
    checkModelStatus();
  });
}

// ── Model Download ─────────────────────────────────────────────────────────

if (btnDownloadModel) {
  btnDownloadModel.addEventListener('click', async () => {
    if (modelDownloading) return;
    const modelId = settingModelId ? settingModelId.value : 'Xenova/whisper-base.en';

    // Warn about large models under Rosetta
    const archInfo = await getCachedArchInfo();
    if (archInfo && archInfo.isRosetta && LARGE_MODEL_IDS.includes(modelId)) {
      const proceed = confirm(
        'Warning: You are running the Intel (x86_64) build on Apple Silicon via Rosetta.\n\n' +
        'The selected model (' + modelId.split('/').pop() + ') is large and may crash ' +
        'the transcription engine under Rosetta translation.\n\n' +
        'Recommended: Use "whisper-base.en" (the smallest model) while on this build, ' +
        'or switch to the native Apple Silicon (arm64) build.\n\n' +
        'Download anyway?'
      );
      if (!proceed) return;
    }

    modelDownloading = true;
    btnDownloadModel.disabled = true;
    btnDownloadModel.textContent = 'Downloading...';
    if (modelProgressRow) modelProgressRow.style.display = 'flex';
    if (modelProgressFill) modelProgressFill.style.width = '0%';
    if (modelProgressText) modelProgressText.textContent = '0%';
    if (modelProgressDetail) { modelProgressDetail.style.display = ''; modelProgressDetail.textContent = 'Initializing...'; }
    if (modelStatusLabel) {
      modelStatusLabel.textContent = 'Downloading...';
      modelStatusLabel.className = 'settings-value model-status-downloading';
    }

    try {
      const result = await window.electronAPI.downloadModel(modelId);
      if (result.success) {
        showToast('Model downloaded successfully — ready to transcribe');
        if (modelStatusLabel) {
          modelStatusLabel.textContent = 'Ready';
          modelStatusLabel.className = 'settings-value model-status-ready';
        }
        if (modelProgressDetail) modelProgressDetail.textContent = 'Download complete';
      } else {
        showToast('Download failed: ' + (result.error || 'Unknown error'), 'error');
        if (modelStatusLabel) {
          modelStatusLabel.textContent = 'Download failed — ' + (result.error || '').substring(0, 60);
          modelStatusLabel.className = 'settings-value model-status-error';
        }
      }
    } catch (e) {
      showToast('Download failed: ' + e.message, 'error');
      if (modelStatusLabel) {
        modelStatusLabel.textContent = 'Download error';
        modelStatusLabel.className = 'settings-value model-status-error';
      }
    } finally {
      modelDownloading = false;
      btnDownloadModel.disabled = false;
      btnDownloadModel.textContent = 'Download Selected Model';
      // Hide progress bar after a delay
      setTimeout(() => {
        if (!modelDownloading) {
          if (modelProgressRow) modelProgressRow.style.display = 'none';
          if (modelProgressDetail) modelProgressDetail.style.display = 'none';
        }
      }, 3000);
      // Refresh status
      await checkModelStatus();
    }
  });
}

// Listen for download progress events from main process
if (window.electronAPI.onModelDownloadProgress) {
  window.electronAPI.onModelDownloadProgress((data) => {
    if (modelProgressFill) modelProgressFill.style.width = `${data.progress || 0}%`;
    if (modelProgressText) modelProgressText.textContent = `${data.progress || 0}%`;
    if (modelProgressDetail) {
      let detail = data.status || '';
      if (data.file) detail += `: ${data.file}`;
      modelProgressDetail.textContent = detail;
      modelProgressDetail.style.display = '';
    }
  });
}

if (settingAutoTranscribe) {
  settingAutoTranscribe.addEventListener('change', () => {
    saveSettingsField('autoTranscribe', settingAutoTranscribe.checked);
  });
}

if (settingCleanupDays) {
  settingCleanupDays.addEventListener('change', () => {
    const val = parseInt(settingCleanupDays.value, 10);
    if (val > 0) saveSettingsField('cleanupDays', val);
  });
}

if (settingMaxRecordingMins) {
  settingMaxRecordingMins.addEventListener('change', () => {
    const val = parseInt(settingMaxRecordingMins.value, 10);
    if (val >= 5) saveSettingsField('maxRecordingMins', val);
  });
}

if (btnRunCleanup) {
  btnRunCleanup.addEventListener('click', async () => {
    const days = parseInt(settingCleanupDays ? settingCleanupDays.value : 90, 10);
    try {
      const result = await window.electronAPI.cleanupOldRecordings(days);
      showToast(`Cleaned up ${result.deleted} old recording${result.deleted !== 1 ? 's' : ''}`);
      // Refresh storage usage
      const usage = await window.electronAPI.getStorageUsage();
      if (settingStorageUsage) {
        settingStorageUsage.textContent = `Recordings: ${usage.recordingsMB} MB | Transcripts: ${usage.transcriptsMB} MB | Total: ${usage.totalMB} MB`;
      }
    } catch (e) {
      showToast('Cleanup failed', 'error');
    }
  });
}

// Settings tab switching
if (settingsTab) {
  settingsTab.addEventListener('click', () => {
    if (cueCardDirty) saveCueCardsToMain();

    settingsTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardTab.classList.remove('active');
    if (accountTab) accountTab.classList.remove('active');
    if (transcriptTab) transcriptTab.classList.remove('active');
    if (txnTab) txnTab.classList.remove('active');

    settingsSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    cueCardSection.style.display = 'none';
    if (accountSection) accountSection.style.display = 'none';
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (txnSection) txnSection.style.display = 'none';

    loadSettingsTab();
  });
}

// Patch other tab handlers to hide settings
if (accountTab) {
  accountTab.addEventListener('click', () => {
    if (settingsSection) settingsSection.style.display = 'none';
    if (settingsTab) settingsTab.classList.remove('active');
  });
}

if (cueCardTab) {
  cueCardTab.addEventListener('click', () => {
    if (settingsSection) settingsSection.style.display = 'none';
    if (settingsTab) settingsTab.classList.remove('active');
  });
}

if (snippetTab) {
  snippetTab.addEventListener('click', () => {
    if (settingsSection) settingsSection.style.display = 'none';
    if (settingsTab) settingsTab.classList.remove('active');
  });
}

if (transcriptTab) {
  transcriptTab.addEventListener('click', () => {
    if (settingsSection) settingsSection.style.display = 'none';
    if (settingsTab) settingsTab.classList.remove('active');
  });
}

// ── Transcription Tab ────────────────────────────────────────────────────────
//
// Shows saved transcription output folder, a list of completed/in-progress
// transcriptions, a live transcription viewer, and detail view for reading
// completed transcriptions.

const txnTab             = document.getElementById('tabTranscription');
const txnSection         = document.getElementById('transcriptionTabSection');
const txnOutputPath      = document.getElementById('txnOutputPath');
const btnTxnSelectFolder = document.getElementById('btnTxnSelectFolder');
const btnTxnClearFolder  = document.getElementById('btnTxnClearFolder');
const txnCount           = document.getElementById('txnCount');
const txnQueueLabel      = document.getElementById('txnQueueLabel');
const txnSearchInput     = document.getElementById('txnSearchInput');
const btnTxnRefresh      = document.getElementById('btnTxnRefresh');
const txnLivePanel       = document.getElementById('txnLivePanel');
const txnLivePulse       = document.getElementById('txnLivePulse');
const txnLiveLabel       = document.getElementById('txnLiveLabel');
const txnProgressFill    = document.getElementById('txnProgressFill');
const txnLiveBody        = document.getElementById('txnLiveBody');
const btnTxnLiveClose    = document.getElementById('btnTxnLiveClose');
const txnHistoryList     = document.getElementById('txnHistoryList');
const txnListContainer   = document.getElementById('txnListContainer');
const txnEmptyState      = document.getElementById('txnEmptyState');
const txnDetailView      = document.getElementById('txnDetailView');
const txnDetailTitle     = document.getElementById('txnDetailTitle');
const txnDetailMeta      = document.getElementById('txnDetailMeta');
const txnDetailContent   = document.getElementById('txnDetailContent');
const btnTxnBack         = document.getElementById('btnTxnBack');
const btnTxnCopyAll      = document.getElementById('btnTxnCopyAll');
const btnTxnExportTxt    = document.getElementById('btnTxnExportTxt');
const btnTxnExportMd     = document.getElementById('btnTxnExportMd');

let txnAllTranscripts = [];
let txnCurrentDetailId = null;
let txnLiveMinimized = false;
let txnLiveTranscriptId = null;

// ── Output folder controls ─────────────────────────────────────────────────

async function loadTxnOutputFolder() {
  try {
    const config = await window.electronAPI.getTranscriptionConfig();
    const dir = config.outputDir || '';
    updateTxnOutputFolderUI(dir);
  } catch (e) {
    console.error('[txn] Failed to load output folder:', e);
  }
}

function updateTxnOutputFolderUI(dir) {
  if (!txnOutputPath) return;
  if (dir) {
    txnOutputPath.textContent = dir;
    txnOutputPath.title = dir;
    txnOutputPath.classList.add('has-path');
  } else {
    txnOutputPath.textContent = 'Not set (internal only)';
    txnOutputPath.title = '';
    txnOutputPath.classList.remove('has-path');
  }
  if (btnTxnClearFolder) btnTxnClearFolder.style.display = dir ? '' : 'none';
}

if (btnTxnSelectFolder) {
  btnTxnSelectFolder.addEventListener('click', async () => {
    const result = await window.electronAPI.selectOutputFolder();
    if (!result.canceled && result.path) {
      updateTxnOutputFolderUI(result.path);
      showToast('Transcription output folder set: ' + result.path.split('/').pop());
    }
  });
}

if (btnTxnClearFolder) {
  btnTxnClearFolder.addEventListener('click', async () => {
    await window.electronAPI.clearOutputFolder();
    updateTxnOutputFolderUI('');
    showToast('Output folder cleared');
  });
}

// ── Load transcription list ────────────────────────────────────────────────

async function loadTranscriptionTab() {
  await loadTxnOutputFolder();
  await refreshTxnList();
  await refreshTxnQueueStatus();
}

async function refreshTxnList() {
  try {
    const searchQuery = txnSearchInput ? txnSearchInput.value.trim() : '';
    let transcripts;
    if (searchQuery) {
      transcripts = await window.electronAPI.searchTranscripts(searchQuery);
    } else {
      transcripts = await window.electronAPI.getTranscripts();
    }

    // Filter to only show transcripts that have completed or are in progress
    txnAllTranscripts = transcripts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (txnCount) txnCount.textContent = `${txnAllTranscripts.length} transcription${txnAllTranscripts.length !== 1 ? 's' : ''}`;

    renderTxnList();
  } catch (e) {
    console.error('[txn] Failed to load transcripts:', e);
  }
}

function renderTxnList() {
  if (!txnListContainer) return;

  // Clear existing cards (keep empty state)
  const cards = txnListContainer.querySelectorAll('.txn-card');
  cards.forEach(c => c.remove());

  const completed = txnAllTranscripts.filter(t => t.status === 'completed');
  const inProgress = txnAllTranscripts.filter(t => t.status === 'transcribing' || t.status === 'pending');
  const failed = txnAllTranscripts.filter(t => t.status === 'failed');

  if (txnEmptyState) {
    txnEmptyState.style.display = txnAllTranscripts.length === 0 ? '' : 'none';
  }

  // Show in-progress at top, then completed, then failed
  const ordered = [...inProgress, ...completed, ...failed];
  ordered.forEach(t => {
    const card = createTxnCard(t);
    txnListContainer.appendChild(card);
  });

  // If there's an active transcription, show the live panel
  if (inProgress.length > 0 && !txnLiveMinimized) {
    txnLiveTranscriptId = inProgress[0].id;
    if (txnLivePanel) txnLivePanel.style.display = 'flex';
    if (txnLiveLabel) txnLiveLabel.textContent = `Transcribing: ${inProgress[0].audioFilename || 'recording'}`;
  }
}

function createTxnCard(t) {
  const card = document.createElement('div');
  card.className = 'txn-card';
  card.dataset.transcriptId = t.id;

  const dateStr = t.createdAt ? new Date(t.createdAt).toLocaleString() : 'Unknown';
  const statusClass = t.status || 'pending';
  const statusLabel = t.status === 'completed' ? 'Completed'
    : t.status === 'transcribing' ? 'Transcribing...'
    : t.status === 'pending' ? 'Queued'
    : t.status === 'failed' ? 'Failed'
    : t.status;

  let preview = '';
  if (t.matchSnippet) {
    preview = `<div class="txn-card-preview">${escapeHtml(t.matchSnippet)}</div>`;
  } else if (t.wordCount > 0) {
    preview = `<div class="txn-card-preview">${t.wordCount} words</div>`;
  }

  const durationStr = t.duration > 0 ? `${Math.round(t.duration)}s` : '';
  const wordStr = t.wordCount > 0 ? `${t.wordCount} words` : '';

  card.innerHTML = `
    <div class="txn-card-header">
      <span class="txn-card-title">${escapeHtml(t.audioFilename || t.id)}</span>
      <span class="txn-card-status ${statusClass}">${statusLabel}</span>
    </div>
    <div class="txn-card-meta">
      <span>${dateStr}</span>
      ${durationStr ? `<span>${durationStr}</span>` : ''}
      ${wordStr ? `<span>${wordStr}</span>` : ''}
    </div>
    ${preview}
    <div class="txn-card-actions">
      ${t.status === 'completed' ? '<button class="btn btn-secondary btn-sm txn-view-btn">View</button>' : ''}
      ${t.status === 'failed' ? '<button class="btn btn-secondary btn-sm txn-retry-btn">Retry</button>' : ''}
    </div>
  `;

  // Click card to view completed transcript
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('txn-retry-btn')) {
      retryTranscription(t.id);
      return;
    }
    if (t.status === 'completed') {
      openTxnDetail(t.id);
    }
  });

  return card;
}

// escapeHtml is already defined earlier in this file

// ── Detail View ────────────────────────────────────────────────────────────

async function openTxnDetail(transcriptId) {
  try {
    const content = await window.electronAPI.getTranscriptContent(transcriptId);
    if (!content) {
      showToast('Transcription content not found', 'error');
      return;
    }

    txnCurrentDetailId = transcriptId;
    const entry = txnAllTranscripts.find(t => t.id === transcriptId);

    if (txnDetailTitle) txnDetailTitle.textContent = entry ? (entry.audioFilename || transcriptId) : transcriptId;

    if (txnDetailMeta) {
      const parts = [];
      if (entry && entry.createdAt) parts.push(new Date(entry.createdAt).toLocaleString());
      if (entry && entry.duration > 0) parts.push(`${Math.round(entry.duration)}s audio`);
      if (content.language) parts.push(`Language: ${content.language}`);
      if (entry && entry.wordCount > 0) parts.push(`${entry.wordCount} words`);
      txnDetailMeta.textContent = parts.join('  |  ');
    }

    if (txnDetailContent) {
      if (content.segments && content.segments.length > 0) {
        txnDetailContent.innerHTML = content.segments.map(seg => {
          const start = formatSegTime(seg.start);
          const end = formatSegTime(seg.end);
          return `<div class="txn-live-segment">
            <div class="txn-live-segment-time">${start} — ${end}</div>
            <div>${escapeHtml(seg.text)}</div>
          </div>`;
        }).join('');
      } else if (content.fullText) {
        txnDetailContent.innerHTML = `<div style="line-height:1.7">${escapeHtml(content.fullText)}</div>`;
      } else {
        txnDetailContent.innerHTML = '<p style="color:var(--text-muted)">No transcription text available.</p>';
      }
    }

    // Show detail, hide list
    if (txnDetailView) txnDetailView.style.display = 'flex';
    if (txnHistoryList) txnHistoryList.style.display = 'none';
    if (txnLivePanel) txnLivePanel.style.display = 'none';
  } catch (e) {
    console.error('[txn] Failed to open detail:', e);
    showToast('Failed to load transcription', 'error');
  }
}

function formatSegTime(seconds) {
  if (typeof seconds !== 'number') return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Back from detail ───────────────────────────────────────────────────────

if (btnTxnBack) {
  btnTxnBack.addEventListener('click', () => {
    txnCurrentDetailId = null;
    if (txnDetailView) txnDetailView.style.display = 'none';
    if (txnHistoryList) txnHistoryList.style.display = '';
    refreshTxnList();
  });
}

// ── Copy / Export ──────────────────────────────────────────────────────────

if (btnTxnCopyAll) {
  btnTxnCopyAll.addEventListener('click', async () => {
    if (!txnCurrentDetailId) return;
    try {
      const content = await window.electronAPI.getTranscriptContent(txnCurrentDetailId);
      if (content && content.fullText) {
        await navigator.clipboard.writeText(content.fullText);
        showToast('Transcription copied to clipboard');
      }
    } catch (e) {
      showToast('Copy failed', 'error');
    }
  });
}

if (btnTxnExportTxt) {
  btnTxnExportTxt.addEventListener('click', async () => {
    if (!txnCurrentDetailId) return;
    try {
      const content = await window.electronAPI.getTranscriptContent(txnCurrentDetailId);
      if (content && content.fullText) {
        const result = await window.electronAPI.exportTranscript(txnCurrentDetailId, 'txt');
        if (result && result.filePath) {
          showToast('Exported: ' + result.filePath.split('/').pop());
        }
      }
    } catch (e) {
      showToast('Export failed', 'error');
    }
  });
}

if (btnTxnExportMd) {
  btnTxnExportMd.addEventListener('click', async () => {
    if (!txnCurrentDetailId) return;
    try {
      const result = await window.electronAPI.exportTranscript(txnCurrentDetailId, 'md');
      if (result && result.filePath) {
        showToast('Exported: ' + result.filePath.split('/').pop());
      }
    } catch (e) {
      showToast('Export failed', 'error');
    }
  });
}

// ── Retry failed transcription ─────────────────────────────────────────────

async function retryTranscription(transcriptId) {
  try {
    await window.electronAPI.retryTranscription(transcriptId);
    showToast('Transcription re-queued');
    await refreshTxnList();
  } catch (e) {
    showToast('Retry failed', 'error');
  }
}

// ── Queue status ───────────────────────────────────────────────────────────

async function refreshTxnQueueStatus() {
  try {
    const status = await window.electronAPI.getTranscriptionStatus();
    if (txnQueueLabel) {
      if (status.processing > 0) {
        txnQueueLabel.textContent = `(${status.processing} processing, ${status.pending} queued)`;
      } else if (status.pending > 0) {
        txnQueueLabel.textContent = `(${status.pending} queued)`;
      } else {
        txnQueueLabel.textContent = '';
      }
    }
  } catch (_) {}
}

// ── Live transcription progress streaming ──────────────────────────────────

if (window.electronAPI.onTranscriptionProgress) {
  window.electronAPI.onTranscriptionProgress((data) => {
    // data: { transcriptId, status, progress, segments, fullText }
    console.log('[txn] Progress event:', data.status, data.progress);

    if (data.status === 'transcribing') {
      txnLiveTranscriptId = data.transcriptId;

      // Auto-switch to Transcription tab if not already there
      if (txnSection && txnSection.style.display === 'none') {
        if (txnTab) txnTab.click();
      }

      // Show live panel
      if (!txnLiveMinimized) {
        if (txnLivePanel) txnLivePanel.style.display = 'flex';
      }

      if (txnLivePulse) txnLivePulse.style.display = '';
      if (txnLiveLabel) txnLiveLabel.textContent = 'Transcribing...';

      // Update progress bar
      if (txnProgressFill && typeof data.progress === 'number') {
        txnProgressFill.style.width = `${Math.min(data.progress, 100)}%`;
      }

      // Update live body with segments
      if (txnLiveBody && data.segments && data.segments.length > 0) {
        txnLiveBody.innerHTML = data.segments.map((seg, i) => {
          const isNew = i === data.segments.length - 1;
          const start = formatSegTime(seg.start);
          const end = formatSegTime(seg.end);
          return `<div class="txn-live-segment ${isNew ? 'new' : ''}">
            <div class="txn-live-segment-time">${start} — ${end}</div>
            <div>${escapeHtml(seg.text)}</div>
          </div>`;
        }).join('');
        // Auto-scroll to bottom
        txnLiveBody.scrollTop = txnLiveBody.scrollHeight;
      } else if (txnLiveBody && data.fullText) {
        txnLiveBody.innerHTML = `<div style="line-height:1.7">${escapeHtml(data.fullText)}</div>`;
        txnLiveBody.scrollTop = txnLiveBody.scrollHeight;
      }
    }

    if (data.status === 'completed' || data.status === 'failed') {
      if (txnLivePulse) txnLivePulse.style.display = 'none';
      if (txnLiveLabel) txnLiveLabel.textContent = data.status === 'completed' ? 'Transcription complete' : 'Transcription failed';
      if (txnProgressFill) txnProgressFill.style.width = data.status === 'completed' ? '100%' : '0%';

      txnLiveMinimized = false;
      txnLiveTranscriptId = null;

      // Refresh list to show the newly completed transcript
      refreshTxnList();
      refreshTxnQueueStatus();

      // Auto-hide live panel after a moment
      setTimeout(() => {
        if (txnLivePanel && txnLiveTranscriptId === null) {
          txnLivePanel.style.display = 'none';
          if (txnLiveBody) txnLiveBody.innerHTML = '<div class="txn-live-placeholder">Waiting for transcription to begin...</div>';
        }
      }, 3000);
    }
  });
}

// ── Live panel minimize ────────────────────────────────────────────────────

if (btnTxnLiveClose) {
  btnTxnLiveClose.addEventListener('click', () => {
    txnLiveMinimized = true;
    if (txnLivePanel) txnLivePanel.style.display = 'none';
  });
}

// ── Search ─────────────────────────────────────────────────────────────────

if (txnSearchInput) {
  let txnSearchTimeout = null;
  txnSearchInput.addEventListener('input', () => {
    clearTimeout(txnSearchTimeout);
    txnSearchTimeout = setTimeout(() => refreshTxnList(), 300);
  });
}

if (btnTxnRefresh) {
  btnTxnRefresh.addEventListener('click', () => {
    refreshTxnList();
    refreshTxnQueueStatus();
  });
}

// ── Tab switching for Transcription tab ────────────────────────────────────

if (txnTab) {
  txnTab.addEventListener('click', () => {
    if (cueCardDirty) saveCueCardsToMain();

    txnTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardTab.classList.remove('active');
    if (accountTab) accountTab.classList.remove('active');
    if (transcriptTab) transcriptTab.classList.remove('active');
    if (settingsTab) settingsTab.classList.remove('active');
    if (logsTab) logsTab.classList.remove('active');

    if (txnSection) txnSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    cueCardSection.style.display = 'none';
    if (accountSection) accountSection.style.display = 'none';
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (settingsSection) settingsSection.style.display = 'none';
    if (logsSection) logsSection.style.display = 'none';

    loadTranscriptionTab();
  });
}

// Patch all other tabs to hide the Transcription section
// Note: logsTab may not be defined yet, so we query the DOM directly
[snippetTab, cueCardTab, accountTab, transcriptTab, settingsTab, document.getElementById('tabLogs')].forEach(tab => {
  if (tab) {
    tab.addEventListener('click', () => {
      if (txnSection) txnSection.style.display = 'none';
      if (txnTab) txnTab.classList.remove('active');
    });
  }
});

// ── Logs Tab ─────────────────────────────────────────────────────────────────
//
// Displays structured application log entries with filtering and search.

const logsTab           = document.getElementById('tabLogs');
const logsSection       = document.getElementById('logsSection');
const logsList          = document.getElementById('logsList');
const logsEmptyState    = document.getElementById('logsEmptyState');
const logCount          = document.getElementById('logCount');
const logLevelFilter    = document.getElementById('logLevelFilter');
const logCategoryFilter = document.getElementById('logCategoryFilter');
const logSearchInput    = document.getElementById('logSearchInput');
const btnRefreshLogs    = document.getElementById('btnRefreshLogs');
const btnClearLogs      = document.getElementById('btnClearLogs');
const logDetailOverlay  = document.getElementById('logDetailOverlay');
const logDetailTitle    = document.getElementById('logDetailTitle');
const logDetailBody     = document.getElementById('logDetailBody');
const btnCloseLogDetail = document.getElementById('btnCloseLogDetail');

let logEntries = [];

function formatLogTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function loadLogsTab() {
  try {
    const filters = {
      level: logLevelFilter ? logLevelFilter.value : 'all',
      category: logCategoryFilter ? logCategoryFilter.value : 'all',
      search: logSearchInput ? logSearchInput.value.trim() : '',
      limit: 500
    };

    const result = await window.electronAPI.getLogEntries(filters);
    logEntries = result.entries || [];

    // Update category filter options (preserve current selection)
    const cats = await window.electronAPI.getLogCategories();
    if (logCategoryFilter) {
      const current = logCategoryFilter.value;
      logCategoryFilter.innerHTML = '<option value="all">All Categories</option>';
      cats.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
        logCategoryFilter.appendChild(opt);
      });
      logCategoryFilter.value = current;
    }

    renderLogsList();
  } catch (e) {
    console.error('[logs] Failed to load:', e);
    logEntries = [];
    renderLogsList();
  }
}

function renderLogsList() {
  if (!logsList) return;

  // Remove all non-empty-state children
  const children = Array.from(logsList.children);
  children.forEach(c => {
    if (c !== logsEmptyState) c.remove();
  });

  if (logCount) {
    logCount.textContent = `${logEntries.length} entr${logEntries.length === 1 ? 'y' : 'ies'}`;
  }

  if (logEntries.length === 0) {
    if (logsEmptyState) logsEmptyState.style.display = 'block';
    return;
  }

  if (logsEmptyState) logsEmptyState.style.display = 'none';

  for (const entry of logEntries) {
    const el = createLogEntryElement(entry);
    logsList.appendChild(el);
  }
}

function createLogEntryElement(entry) {
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.dataset.logId = entry.id;

  const hasDetail = entry.detail && Object.keys(entry.detail).length > 0;

  el.innerHTML = `
    <span class="log-level-badge ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span>
    <div class="log-entry-body">
      <div class="log-entry-message">${escapeHtml(entry.message)}</div>
      <div class="log-entry-meta">
        <span class="log-category-tag">${escapeHtml(entry.category)}</span>
        <span class="log-timestamp">${formatLogTimestamp(entry.timestamp)}</span>
        ${hasDetail ? '<span style="color:var(--accent)">&#9432; detail</span>' : ''}
      </div>
    </div>
  `;

  el.addEventListener('click', () => openLogDetail(entry));
  return el;
}

function openLogDetail(entry) {
  if (!logDetailOverlay || !logDetailBody) return;

  if (logDetailTitle) {
    logDetailTitle.textContent = `${entry.level.toUpperCase()} — ${entry.category}`;
  }

  let html = '';
  html += `<div class="log-detail-row"><div class="log-detail-label">Timestamp</div><div>${formatLogTimestamp(entry.timestamp)}</div></div>`;
  html += `<div class="log-detail-row"><div class="log-detail-label">Level</div><div><span class="log-level-badge ${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span></div></div>`;
  html += `<div class="log-detail-row"><div class="log-detail-label">Category</div><div><span class="log-category-tag">${escapeHtml(entry.category)}</span></div></div>`;
  html += `<div class="log-detail-row"><div class="log-detail-label">Message</div><div>${escapeHtml(entry.message)}</div></div>`;

  if (entry.detail) {
    html += `<div class="log-detail-row"><div class="log-detail-label">Detail</div><pre>${escapeHtml(JSON.stringify(entry.detail, null, 2))}</pre></div>`;
  }

  html += `<div class="log-detail-row"><div class="log-detail-label">ID</div><div style="font-family:monospace;font-size:11px;color:var(--text-muted)">${escapeHtml(entry.id)}</div></div>`;

  logDetailBody.innerHTML = html;
  logDetailOverlay.style.display = 'flex';
}

function closeLogDetail() {
  if (logDetailOverlay) logDetailOverlay.style.display = 'none';
}

// Event listeners for log controls
if (btnCloseLogDetail) btnCloseLogDetail.addEventListener('click', closeLogDetail);
if (logDetailOverlay) {
  logDetailOverlay.addEventListener('click', (e) => {
    if (e.target === logDetailOverlay) closeLogDetail();
  });
}

if (btnRefreshLogs) btnRefreshLogs.addEventListener('click', loadLogsTab);

if (btnClearLogs) {
  btnClearLogs.addEventListener('click', async () => {
    if (confirm('Clear all log entries? This cannot be undone.')) {
      await window.electronAPI.clearLogs();
      loadLogsTab();
    }
  });
}

if (logLevelFilter) logLevelFilter.addEventListener('change', loadLogsTab);
if (logCategoryFilter) logCategoryFilter.addEventListener('change', loadLogsTab);

let logSearchDebounce = null;
if (logSearchInput) {
  logSearchInput.addEventListener('input', () => {
    clearTimeout(logSearchDebounce);
    logSearchDebounce = setTimeout(loadLogsTab, 300);
  });
}

// Live log streaming — append new entries as they arrive
if (window.electronAPI && window.electronAPI.onLogEntry) {
  window.electronAPI.onLogEntry((entry) => {
    // Only append if logs tab is visible and entry matches current filters
    if (logsSection && logsSection.style.display !== 'none') {
      const levelOk = !logLevelFilter || logLevelFilter.value === 'all' || logLevelFilter.value === entry.level;
      const catOk = !logCategoryFilter || logCategoryFilter.value === 'all' || logCategoryFilter.value === entry.category;
      const searchOk = !logSearchInput || !logSearchInput.value.trim() ||
        entry.message.toLowerCase().includes(logSearchInput.value.trim().toLowerCase());

      if (levelOk && catOk && searchOk) {
        logEntries.unshift(entry);
        if (logEntries.length > 500) logEntries.pop();

        // Prepend to DOM
        if (logsList && logsEmptyState) {
          logsEmptyState.style.display = 'none';
          const el = createLogEntryElement(entry);
          logsList.insertBefore(el, logsEmptyState.nextSibling || logsList.firstChild);
        }
        if (logCount) {
          logCount.textContent = `${logEntries.length} entr${logEntries.length === 1 ? 'y' : 'ies'}`;
        }
      }
    }
  });
}

// ── Logs Tab Switching ──────────────────────────────────────────────────────

if (logsTab) {
  logsTab.addEventListener('click', () => {
    if (cueCardDirty) saveCueCardsToMain();

    logsTab.classList.add('active');
    snippetTab.classList.remove('active');
    cueCardTab.classList.remove('active');
    if (accountTab) accountTab.classList.remove('active');
    if (transcriptTab) transcriptTab.classList.remove('active');
    if (settingsTab) settingsTab.classList.remove('active');
    if (txnTab) txnTab.classList.remove('active');

    logsSection.style.display = 'flex';
    snippetSection.style.display = 'none';
    cueCardSection.style.display = 'none';
    if (accountSection) accountSection.style.display = 'none';
    if (transcriptSection) transcriptSection.style.display = 'none';
    if (settingsSection) settingsSection.style.display = 'none';
    if (txnSection) txnSection.style.display = 'none';

    loadLogsTab();
  });
}

// Patch other tabs to hide logs section
[snippetTab, cueCardTab, accountTab, transcriptTab, settingsTab, txnTab].forEach(tab => {
  if (tab) {
    tab.addEventListener('click', () => {
      if (logsSection) logsSection.style.display = 'none';
      if (logsTab) logsTab.classList.remove('active');
    });
  }
});

// ── Deep link from tray: open a specific transcript ───────────────────────────
if (window.electronAPI.onOpenTranscript) {
  window.electronAPI.onOpenTranscript(({ transcriptId }) => {
    // Switch to transcripts tab
    if (transcriptTab) transcriptTab.click();

    // Wait for transcripts to load, then open detail
    setTimeout(() => {
      if (transcriptId) {
        openTranscriptDetail(transcriptId);
      }
    }, 300);
  });
}

// ── Warn on unload if dirty ───────────────────────────────────────────────────

window.addEventListener('beforeunload', (e) => {
  if (isDirty || cueCardDirty) {
    if (cueCardDirty) saveCueCardsToMain();
    e.preventDefault();
    e.returnValue = '';
  }
});
