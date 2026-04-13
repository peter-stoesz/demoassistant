'use strict';

// ─── Canvas Setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('overlayCanvas');
const ctx = canvas.getContext('2d');
const statusBadge = document.getElementById('statusBadge');

let canvasWidth = window.innerWidth;
let canvasHeight = window.innerHeight;

function resizeCanvas() {
  canvasWidth = window.innerWidth;
  canvasHeight = window.innerHeight;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ─── Feature State ────────────────────────────────────────────────────────────

const features = {
  sonarEnabled:            true,
  selectionBoxEnabled:     true,
  autofillEnabled:         true,
  cursorHighlightEnabled:  false,
  spotlightEnabled:        false,
  freezeFrameEnabled:      false,
  annotationEnabled:       false
};

// ─── Animation Data ───────────────────────────────────────────────────────────

const sonarBlips = [];
const selectionBoxes = [];
let currentSelection = null;
let selectionModeActive = false;
let isDragging = false;

// ─── Annotation State (Sprint 2) ─────────────────────────────────────────────

let annotationModeActive = false;
let annotationPersistent = false;   // when true, strokes don't auto-fade

const ANNOTATION_COLOR      = '#FF4444';
const ANNOTATION_LINE_WIDTH = 3;
const ANNOTATION_LIFESPAN   = 4000;   // ms before fade begins
const ANNOTATION_FADE_MS    = 600;    // ms for fade-out
const ANNOTATION_MIN_DIST   = 3;      // px — distance threshold for new freehand point
const UNDO_STACK_MAX        = 20;

// Each stroke: { type, points, timestamp, color, lineWidth, alpha, persistent }
// type: 'freehand' | 'arrow' | 'circle'
// For arrow/circle, points = [startPt, endPt]
const annotations = [];
const undoStack   = [];   // stores removed annotations for redo (not implemented yet)
let currentStroke = null; // in-progress stroke during drag
let annotationToolModifier = null; // null = freehand, 'alt' = arrow, 'shift' = circle

// Cursor position — mouse-move events ARE forwarded in click-through mode
let cursorX = -100;
let cursorY = -100;

// ─── Spotlight State (Sprint 1) ──────────────────────────────────────────────

let spotlightRadius    = 120;   // default radius in px
let spotlightOpacity   = 0.70;  // dim layer opacity
let spotlightFadeAlpha = 0;     // 0 = off, 1 = fully on (for fade animation)
const SPOTLIGHT_FADE_SPEED = 0.08; // per frame (~4.8 per second at 60fps)
const SPOTLIGHT_MIN_RADIUS = 40;
const SPOTLIGHT_MAX_RADIUS = 400;
const SPOTLIGHT_RADIUS_STEP = 10;

// ─── Freeze Frame State (Sprint 1) ──────────────────────────────────────────

let frozenImage     = null;  // HTMLImageElement once loaded
let frozenFadeAlpha = 0;     // 0 = off, 1 = fully on
const FROZEN_FADE_SPEED = 0.1;

// ─── Animation Loop (Task 1.1 — mode-based refactor) ─────────────────────────
//
// Rendering order (back to front):
//   1. Freeze frame background (if active)
//   2. Spotlight dim layer (if active)
//   3. Cursor highlight
//   4. Sonar blips
//   5. Selection boxes (completed + live drag)
//
// Each layer is drawn independently so new effects can be inserted without
// touching other draw logic.

function renderFrame(timestamp) {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // ── Layer 1: Freeze frame background ─────────────────────────────────
  renderFreezeFrame();

  // ── Layer 2: Spotlight dim + cutout ──────────────────────────────────
  renderSpotlight();

  // ── Layer 3: Cursor highlight ────────────────────────────────────────
  if (features.cursorHighlightEnabled && cursorX >= 0 && cursorY >= 0) {
    drawCursorHighlight(cursorX, cursorY);
  }

  // ── Layer 4: Sonar blips ─────────────────────────────────────────────
  for (let i = sonarBlips.length - 1; i >= 0; i--) {
    const blip = sonarBlips[i];
    const elapsed = timestamp - blip.startTime;
    const progress = Math.min(elapsed / blip.duration, 1);

    if (progress >= 1) {
      sonarBlips.splice(i, 1);
      continue;
    }

    drawSonarBlip(blip.x, blip.y, progress, blip.color);
  }

  // ── Layer 5: Completed selection boxes (hold then fade) ──────────────
  for (let i = selectionBoxes.length - 1; i >= 0; i--) {
    const box = selectionBoxes[i];

    if (box.phase === 'holding') {
      const holdElapsed = timestamp - box.holdStart;
      if (holdElapsed >= box.holdDuration) {
        box.phase = 'fading';
        box.fadeStart = timestamp;
      } else {
        drawSelectionBox(box.x1, box.y1, box.x2, box.y2, 1.0);
      }
    } else if (box.phase === 'fading') {
      const fadeElapsed = timestamp - box.fadeStart;
      const alpha = Math.max(0, 1 - fadeElapsed / box.fadeDuration);
      if (alpha <= 0) {
        selectionBoxes.splice(i, 1);
        continue;
      }
      drawSelectionBox(box.x1, box.y1, box.x2, box.y2, alpha);
    }
  }

  // ── Layer 5b: Live drag selection ────────────────────────────────────
  if (currentSelection) {
    drawSelectionBox(
      currentSelection.x1, currentSelection.y1,
      currentSelection.x2, currentSelection.y2,
      1.0
    );
  }

  // ── Layer 6: Annotations (Sprint 2) ─────────────────────────────────
  renderAnnotations(timestamp);

  // ── Layer 6b: Live annotation stroke ────────────────────────────────
  if (currentStroke) {
    drawAnnotationStroke(currentStroke, 1.0);
  }

  requestAnimationFrame(renderFrame);
}

requestAnimationFrame(renderFrame);

// ─── Spotlight Rendering (Task 1.2) ──────────────────────────────────────────

function renderSpotlight() {
  // Animate fade
  if (features.spotlightEnabled) {
    spotlightFadeAlpha = Math.min(1, spotlightFadeAlpha + SPOTLIGHT_FADE_SPEED);
  } else {
    spotlightFadeAlpha = Math.max(0, spotlightFadeAlpha - SPOTLIGHT_FADE_SPEED);
  }

  if (spotlightFadeAlpha <= 0) return;

  const dimAlpha = spotlightOpacity * spotlightFadeAlpha;

  // Save context state
  ctx.save();

  // Step 1: Draw full-screen dim layer
  ctx.fillStyle = `rgba(0, 0, 0, ${dimAlpha})`;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Step 2: Punch a soft circular hole at the cursor position
  // Using 'destination-out' composite mode to erase a gradient circle
  ctx.globalCompositeOperation = 'destination-out';

  const featherSize = Math.max(30, spotlightRadius * 0.25);
  const innerRadius = Math.max(0, spotlightRadius - featherSize);

  const gradient = ctx.createRadialGradient(
    cursorX, cursorY, innerRadius,
    cursorX, cursorY, spotlightRadius
  );
  gradient.addColorStop(0, `rgba(255, 255, 255, ${spotlightFadeAlpha})`);
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.beginPath();
  ctx.arc(cursorX, cursorY, spotlightRadius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Also punch a fully opaque inner circle for a crisp center
  ctx.beginPath();
  ctx.arc(cursorX, cursorY, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 255, 255, ${spotlightFadeAlpha})`;
  ctx.fill();

  // Restore composite mode
  ctx.restore();
}

// ─── Freeze Frame Rendering (Task 1.5) ──────────────────────────────────────

function renderFreezeFrame() {
  // Animate fade
  if (features.freezeFrameEnabled && frozenImage) {
    frozenFadeAlpha = Math.min(1, frozenFadeAlpha + FROZEN_FADE_SPEED);
  } else if (!features.freezeFrameEnabled) {
    frozenFadeAlpha = Math.max(0, frozenFadeAlpha - FROZEN_FADE_SPEED);
  }

  if (frozenFadeAlpha <= 0 || !frozenImage) return;

  ctx.save();
  ctx.globalAlpha = frozenFadeAlpha;
  ctx.drawImage(frozenImage, 0, 0, canvasWidth, canvasHeight);
  ctx.restore();
}

// ─── Cursor Highlight Drawing ─────────────────────────────────────────────────

function drawCursorHighlight(x, y) {
  const radius = 24;

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, 'rgba(255, 220, 40, 0.35)');
  gradient.addColorStop(0.6, 'rgba(255, 200, 0, 0.18)');
  gradient.addColorStop(1, 'rgba(255, 180, 0, 0)');

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.75, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 210, 0, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ─── Sonar Blip Drawing ───────────────────────────────────────────────────────

function drawSonarBlip(x, y, progress, color) {
  const maxRadius = 48;
  const numRings = 3;

  for (let r = 0; r < numRings; r++) {
    const ringOffset = r * 0.18;
    const ringProgress = Math.min(Math.max((progress - ringOffset) / (1 - ringOffset), 0), 1);
    if (ringProgress <= 0) continue;

    const radius = ringProgress * maxRadius;
    const alpha = Math.max(0, (1 - ringProgress) * (1 - ringProgress * 0.4));
    const lineWidth = Math.max(0.5, 2.5 * (1 - ringProgress * 0.6));

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(color, alpha);
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  const dotAlpha = Math.max(0, 1 - progress * 3);
  if (dotAlpha > 0) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, dotAlpha * 0.7);
    ctx.fill();
  }
}

// ─── Selection Box Drawing ────────────────────────────────────────────────────
// Outline only — no fill, no dimension label

function drawSelectionBox(x1, y1, x2, y2, alpha) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  if (w < 2 || h < 2) return;

  // Border: solid yellow, 2.5px
  ctx.strokeStyle = `rgba(255, 210, 0, ${0.92 * alpha})`;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);

  // Corner accents
  const cornerLen = Math.min(16, w * 0.2, h * 0.2);
  ctx.strokeStyle = `rgba(255, 255, 100, ${alpha})`;
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.moveTo(x, y + cornerLen); ctx.lineTo(x, y); ctx.lineTo(x + cornerLen, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + w - cornerLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cornerLen);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y + h - cornerLen); ctx.lineTo(x, y + h); ctx.lineTo(x + cornerLen, y + h);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + w - cornerLen, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - cornerLen);
  ctx.stroke();
}

// ─── Annotation Rendering (Sprint 2) ─────────────────────────────────────────

function renderAnnotations(timestamp) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const stroke = annotations[i];

    if (!stroke.persistent && !annotationPersistent) {
      const age = timestamp - stroke.timestamp;
      if (age > ANNOTATION_LIFESPAN + ANNOTATION_FADE_MS) {
        annotations.splice(i, 1);
        continue;
      }
      if (age > ANNOTATION_LIFESPAN) {
        stroke.alpha = 1 - ((age - ANNOTATION_LIFESPAN) / ANNOTATION_FADE_MS);
      } else {
        stroke.alpha = 1;
      }
    } else {
      stroke.alpha = 1;
    }

    if (stroke.alpha <= 0) {
      annotations.splice(i, 1);
      continue;
    }

    drawAnnotationStroke(stroke, stroke.alpha);
  }
}

function drawAnnotationStroke(stroke, alpha) {
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth   = stroke.lineWidth;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  if (stroke.type === 'freehand') {
    drawFreehandStroke(stroke);
  } else if (stroke.type === 'arrow') {
    drawArrowStroke(stroke);
  } else if (stroke.type === 'circle') {
    drawCircleStroke(stroke);
  }

  ctx.restore();
}

function drawFreehandStroke(stroke) {
  const pts = stroke.points;
  if (pts.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);

  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y);
  } else {
    // Quadratic bezier interpolation for smoothness
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }
    // Final segment to last point
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
  }

  ctx.stroke();
}

function drawArrowStroke(stroke) {
  const pts = stroke.points;
  if (pts.length < 2) return;

  const start = pts[0];
  const end   = pts[pts.length - 1];

  // Drop shadow for visibility
  ctx.save();
  ctx.shadowColor   = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur    = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  // Line
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  // Arrowhead (30-degree, 16px length)
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLen = 16;
  const headAngle = Math.PI / 6; // 30 degrees

  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLen * Math.cos(angle - headAngle),
    end.y - headLen * Math.sin(angle - headAngle)
  );
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLen * Math.cos(angle + headAngle),
    end.y - headLen * Math.sin(angle + headAngle)
  );
  ctx.stroke();

  ctx.restore();
}

function drawCircleStroke(stroke) {
  const pts = stroke.points;
  if (pts.length < 2) return;

  const start = pts[0];
  const end   = pts[pts.length - 1];

  const cx = (start.x + end.x) / 2;
  const cy = (start.y + end.y) / 2;
  const rx = Math.abs(end.x - start.x) / 2;
  const ry = Math.abs(end.y - start.y) / 2;

  if (rx < 2 && ry < 2) return;

  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function clearAnnotations() {
  annotations.length = 0;
  undoStack.length   = 0;
}

function undoAnnotation() {
  if (annotations.length === 0) return;
  const removed = annotations.pop();
  if (undoStack.length >= UNDO_STACK_MAX) {
    undoStack.shift();
  }
  undoStack.push(removed);
}

// ─── Mouse Events ─────────────────────────────────────────────────────────────
// All mouse listeners are on document so they fire regardless of
// canvas pointer-events state.

document.addEventListener('mousedown', (e) => {
  // ── Annotation mode drawing ──────────────────────────────────────
  if (annotationModeActive) {
    isDragging = true;

    // Determine tool from modifier keys held during mousedown
    if (e.altKey) {
      annotationToolModifier = 'alt';    // arrow
    } else if (e.shiftKey) {
      annotationToolModifier = 'shift';  // circle
    } else {
      annotationToolModifier = null;     // freehand
    }

    const type = annotationToolModifier === 'alt' ? 'arrow'
               : annotationToolModifier === 'shift' ? 'circle'
               : 'freehand';

    currentStroke = {
      type,
      points:    [{ x: e.clientX, y: e.clientY }],
      timestamp: performance.now(),
      color:     ANNOTATION_COLOR,
      lineWidth: ANNOTATION_LINE_WIDTH,
      alpha:     1,
      persistent: annotationPersistent
    };
    return;
  }

  // ── Selection mode drawing ───────────────────────────────────────
  if (!selectionModeActive) return;

  isDragging = true;
  currentSelection = {
    x1: e.clientX,
    y1: e.clientY,
    x2: e.clientX,
    y2: e.clientY
  };
});

document.addEventListener('mousemove', (e) => {
  cursorX = e.clientX;
  cursorY = e.clientY;

  // ── Annotation drag ──────────────────────────────────────────────
  if (isDragging && currentStroke) {
    const last = currentStroke.points[currentStroke.points.length - 1];
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;

    if (currentStroke.type === 'freehand') {
      // Distance threshold for smooth but efficient curves
      if (dx * dx + dy * dy >= ANNOTATION_MIN_DIST * ANNOTATION_MIN_DIST) {
        currentStroke.points.push({ x: e.clientX, y: e.clientY });
      }
    } else {
      // Arrow/circle: update endpoint
      if (currentStroke.points.length === 1) {
        currentStroke.points.push({ x: e.clientX, y: e.clientY });
      } else {
        currentStroke.points[1] = { x: e.clientX, y: e.clientY };
      }
    }
    return;
  }

  // ── Selection drag ───────────────────────────────────────────────
  if (isDragging && currentSelection) {
    currentSelection.x2 = e.clientX;
    currentSelection.y2 = e.clientY;
  }
});

document.addEventListener('mouseup', (e) => {
  // ── Finish annotation stroke ─────────────────────────────────────
  if (isDragging && currentStroke) {
    isDragging = false;

    // Only commit strokes that have meaningful length
    if (currentStroke.points.length >= 2 ||
        (currentStroke.type !== 'freehand' && currentStroke.points.length >= 2)) {
      // For arrow/circle, finalize endpoint
      if (currentStroke.type !== 'freehand') {
        if (currentStroke.points.length === 1) {
          currentStroke.points.push({ x: e.clientX, y: e.clientY });
        } else {
          currentStroke.points[currentStroke.points.length - 1] = { x: e.clientX, y: e.clientY };
        }
      }
      currentStroke.timestamp = performance.now(); // reset lifespan to start from release
      annotations.push(currentStroke);
    }

    currentStroke = null;
    annotationToolModifier = null;
    return;
  }

  // ── Finish selection ─────────────────────────────────────────────
  if (!isDragging || !currentSelection) return;

  isDragging = false;

  selectionBoxes.push({
    x1: currentSelection.x1,
    y1: currentSelection.y1,
    x2: e.clientX,
    y2: e.clientY,
    phase: 'holding',
    holdStart: performance.now(),
    holdDuration: 2000,
    fadeDuration: 600,
    fadeStart: 0
  });

  currentSelection = null;

  // Clean up selection mode locally
  selectionModeActive = false;
  document.body.classList.remove('selecting');

  // Tell main process to return overlays to click-through
  window.electronAPI.selectionComplete();
});

document.addEventListener('keydown', (e) => {
  // ── Escape exits whichever mode is active ────────────────────────
  if (e.key === 'Escape') {
    if (annotationModeActive) {
      isDragging    = false;
      currentStroke = null;
      annotationModeActive = false;
      document.body.classList.remove('annotating');
      window.electronAPI.annotationComplete();
      return;
    }
    if (selectionModeActive) {
      isDragging = false;
      currentSelection = null;
      selectionModeActive = false;
      document.body.classList.remove('selecting');
      window.electronAPI.selectionComplete();
    }
  }

  // ── Cmd/Ctrl+Z for undo while in annotation mode ────────────────
  if (annotationModeActive && (e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undoAnnotation();
  }
});

// ─── Spotlight Radius Adjustment via Shift+Scroll (Task 1.4) ────────────────

document.addEventListener('wheel', (e) => {
  if (!features.spotlightEnabled || !e.shiftKey) return;

  e.preventDefault();
  if (e.deltaY < 0) {
    spotlightRadius = Math.min(SPOTLIGHT_MAX_RADIUS, spotlightRadius + SPOTLIGHT_RADIUS_STEP);
  } else {
    spotlightRadius = Math.max(SPOTLIGHT_MIN_RADIUS, spotlightRadius - SPOTLIGHT_RADIUS_STEP);
  }
}, { passive: false });

// ─── IPC: Sonar Blip ─────────────────────────────────────────────────────────

window.electronAPI.onSonarBlip(({ x, y }) => {
  if (!features.sonarEnabled) return;
  sonarBlips.push({
    x, y,
    startTime: performance.now(),
    duration: 420,
    color: '#FF6B6B'
  });
});

// ─── IPC: Selection Mode ─────────────────────────────────────────────────────

window.electronAPI.onSelectionModeEnter(() => {
  if (!features.selectionBoxEnabled) return;
  selectionModeActive = true;
  document.body.classList.add('selecting');
});

window.electronAPI.onSelectionModeExit(() => {
  // Force-cancel from main process (e.g. user pressed hotkey again)
  isDragging = false;
  currentSelection = null;
  selectionModeActive = false;
  document.body.classList.remove('selecting');
});

// ─── IPC: Freeze Frame Capture (Task 1.5) ───────────────────────────────────

window.electronAPI.onFreezeFrameCapture(({ imageDataURL }) => {
  if (!imageDataURL) {
    frozenImage = null;
    return;
  }

  const img = new Image();
  img.onload = () => {
    frozenImage = img;
  };
  img.onerror = () => {
    console.warn('[overlay] Failed to load freeze frame image');
    frozenImage = null;
  };
  img.src = imageDataURL;
});

window.electronAPI.onFreezeFrameRelease(() => {
  // Feature toggle handles the fade-out via renderFreezeFrame();
  // After fade completes we clean up the image to free memory
  setTimeout(() => {
    if (!features.freezeFrameEnabled) {
      frozenImage = null;
    }
  }, 2000);
});

// ─── IPC: Annotation Mode (Sprint 2) ─────────────────────────────────────────

window.electronAPI.onAnnotationModeEnter(() => {
  if (annotationModeActive) return;

  // Exit selection mode if active (mutually exclusive)
  if (selectionModeActive) {
    isDragging = false;
    currentSelection = null;
    selectionModeActive = false;
    document.body.classList.remove('selecting');
  }

  annotationModeActive = true;
  document.body.classList.add('annotating');
});

window.electronAPI.onAnnotationModeExit(() => {
  isDragging    = false;
  currentStroke = null;
  annotationModeActive = false;
  document.body.classList.remove('annotating');
});

window.electronAPI.onAnnotationClear(() => {
  clearAnnotations();
});

window.electronAPI.onAnnotationUndo(() => {
  undoAnnotation();
});

window.electronAPI.onAnnotationTogglePersist(() => {
  annotationPersistent = !annotationPersistent;
  // Reset timestamps on existing strokes so they don't immediately fade
  if (annotationPersistent) {
    annotations.forEach(s => { s.persistent = true; });
  }
});

// ─── IPC: Feature Toggles & Display Changes ──────────────────────────────────

window.electronAPI.getFeatureState().then((state) => {
  Object.assign(features, state);
});

window.electronAPI.onFeatureToggled(({ feature, enabled }) => {
  features[feature] = enabled;
  showStatusBadge(feature, enabled);
});

window.electronAPI.onDisplayChanged(({ width, height }) => {
  canvasWidth = width;
  canvasHeight = height;
  canvas.width = width;
  canvas.height = height;
});

// ─── Recording State ─────────────────────────────────────────────────────────
// Recording indicator removed from overlay — status is shown only in the
// Recordings tab inside the Snippet Manager window.

// ─── Status Badge ─────────────────────────────────────────────────────────────

let statusTimeout = null;

// Status badge disabled — no overlay indicators in the top-right corner.
// All status information is shown inside the Snippet Manager window instead.
function showStatusBadge(_feature, _enabled) {
  // intentionally empty
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
