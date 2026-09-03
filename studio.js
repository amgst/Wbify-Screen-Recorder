// Standalone Screen Recorder Engine & Screenshot Markup Editor for Chrome Extension
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let timerInterval = null;
let recordingSeconds = 0;
let isPaused = false;
let currentRecordedBlob = null;

// Extra source streams kept around only so we can stop their tracks / tear
// down compositing when recording ends.
let rawDisplayStream = null;
let rawCamStream = null;
let rawMicStream = null;
let pipRafId = null;
let pipAudioCtx = null;

// Screenshot markup state
let activeTool = 'arrow';
let strokeColor = '#ef4444';
let screenshotImage = new Image();
let canvasHistory = [];
let isDrawing = false;
let startX = 0;
let startY = 0;

// URL parameters
const urlParams = new URLSearchParams(window.location.search);
const initialAction = urlParams.get('action');
const initialView = urlParams.get('view');

// Nav buttons
const navStudio = document.getElementById('navStudio');
const navScreenshot = document.getElementById('navScreenshot');
const navLibrary = document.getElementById('navLibrary');
const navSettings = document.getElementById('navSettings');

const cardLauncher = document.getElementById('cardLauncher');
const liveStudioView = document.getElementById('liveStudioView');
const cardReviewVideo = document.getElementById('cardReviewVideo');
const editorView = document.getElementById('editorView');
const libraryContainer = document.getElementById('libraryContainer');
const settingsContainer = document.getElementById('settingsContainer');

function switchView(view) {
  [navStudio, navScreenshot, navLibrary, navSettings].forEach(b => { if (b) b.classList.remove('active'); });
  cardLauncher.style.display = 'none';
  liveStudioView.style.display = 'none';
  cardReviewVideo.style.display = 'none';
  editorView.style.display = 'none';
  libraryContainer.style.display = 'none';
  if (settingsContainer) settingsContainer.style.display = 'none';

  if (view === 'studio') {
    if (navStudio) navStudio.classList.add('active');
    cardLauncher.style.display = 'block';
  } else if (view === 'screenshot') {
    if (navScreenshot) navScreenshot.classList.add('active');
    editorView.style.display = 'flex';
  } else if (view === 'library') {
    if (navLibrary) navLibrary.classList.add('active');
    libraryContainer.style.display = 'block';
    renderLibrary();
  } else if (view === 'settings') {
    if (navSettings) navSettings.classList.add('active');
    if (settingsContainer) settingsContainer.style.display = 'block';
    calculateAndUpdateStorageUsage();
  }
}

if (navStudio) navStudio.addEventListener('click', () => switchView('studio'));
if (navScreenshot) navScreenshot.addEventListener('click', () => switchView('screenshot'));
if (navLibrary) navLibrary.addEventListener('click', () => switchView('library'));
if (navSettings) navSettings.addEventListener('click', () => switchView('settings'));

// Format time
function formatTime(s) {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
}

// Read the mic / webcam / sysAudio / countdown options the popup passed
// through the URL. Direct launches from the Studio card (no query string)
// fall back to sensible defaults instead of silently recording muted.
function getRecordingOpts() {
  return {
    mic: urlParams.has('mic') ? urlParams.get('mic') === '1' : true,
    webcam: urlParams.get('webcam') === '1',
    sysAudio: urlParams.has('sysAudio') ? urlParams.get('sysAudio') === '1' : true,
    countdown: urlParams.has('countdown') ? (parseInt(urlParams.get('countdown'), 10) || 0) : 0
  };
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('countdownOverlay');
    if (!seconds || seconds <= 0) {
      overlay.style.display = 'none';
      resolve();
      return;
    }
    let remaining = seconds;
    overlay.textContent = String(remaining);
    overlay.style.display = 'flex';
    const iv = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(iv);
        overlay.style.display = 'none';
        resolve();
      } else {
        overlay.textContent = String(remaining);
      }
    }, 1000);
  });
}

// Mixes any combination of system/tab audio + microphone audio into a
// single track, since MediaRecorder does not reliably record more than
// one audio track per stream.
function mixAudioTracks(streams) {
  const usable = streams.filter(s => s && s.getAudioTracks().length > 0);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].getAudioTracks()[0];

  pipAudioCtx = new AudioContext();
  const dest = pipAudioCtx.createMediaStreamDestination();
  usable.forEach(s => pipAudioCtx.createMediaStreamSource(s).connect(dest));
  return dest.stream.getAudioTracks()[0];
}

// Composites the screen-share video and the webcam feed onto a canvas
// (webcam drawn as a rounded picture-in-picture bubble, bottom-right) and
// returns a live video track for that composite.
function buildWebcamPipTrack(displayStream, camStream) {
  const displaySettings = displayStream.getVideoTracks()[0].getSettings();
  const width = displaySettings.width || 1280;
  const height = displaySettings.height || 720;

  const displayVideoEl = document.createElement('video');
  displayVideoEl.srcObject = displayStream;
  displayVideoEl.muted = true;
  displayVideoEl.playsInline = true;
  displayVideoEl.play();

  const camVideoEl = document.createElement('video');
  camVideoEl.srcObject = camStream;
  camVideoEl.muted = true;
  camVideoEl.playsInline = true;
  camVideoEl.play();

  const pipCanvas = document.createElement('canvas');
  pipCanvas.width = width;
  pipCanvas.height = height;
  const pipCtx = pipCanvas.getContext('2d');

  const pipW = Math.round(width * 0.22);
  const pipH = Math.round(pipW * 0.75);
  const pipX = width - pipW - 24;
  const pipY = height - pipH - 24;
  const radius = 16;

  function drawFrame() {
    pipCtx.drawImage(displayVideoEl, 0, 0, width, height);

    pipCtx.save();
    pipCtx.beginPath();
    pipCtx.moveTo(pipX + radius, pipY);
    pipCtx.arcTo(pipX + pipW, pipY, pipX + pipW, pipY + pipH, radius);
    pipCtx.arcTo(pipX + pipW, pipY + pipH, pipX, pipY + pipH, radius);
    pipCtx.arcTo(pipX, pipY + pipH, pipX, pipY, radius);
    pipCtx.arcTo(pipX, pipY, pipX + pipW, pipY, radius);
    pipCtx.closePath();
    pipCtx.clip();
    pipCtx.drawImage(camVideoEl, pipX, pipY, pipW, pipH);
    pipCtx.restore();

    pipCtx.strokeStyle = '#2563eb';
    pipCtx.lineWidth = 3;
    pipCtx.strokeRect(pipX, pipY, pipW, pipH);

    pipRafId = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  const pipStream = pipCanvas.captureStream(30);
  pipStream._previewCanvas = pipCanvas;
  return pipStream;
}

// Start Screen / Tab Recording
async function startRecordingFlow(isCameraOnly = false) {
  const opts = getRecordingOpts();
  try {
    let finalVideoTrack;
    let previewStream;

    if (isCameraOnly) {
      rawCamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1920, height: 1080 },
        audio: opts.mic
      });
      finalVideoTrack = rawCamStream.getVideoTracks()[0];
      previewStream = rawCamStream;
    } else {
      rawDisplayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: opts.sysAudio
      });

      if (opts.webcam) {
        try {
          rawCamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
            audio: false
          });
        } catch (camErr) {
          console.warn('Webcam PIP requested but camera unavailable, continuing without it', camErr);
          rawCamStream = null;
        }
      }

      if (opts.mic) {
        try {
          rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (micErr) {
          console.warn('Microphone requested but unavailable, continuing without it', micErr);
          rawMicStream = null;
        }
      }

      const audioTrack = mixAudioTracks([rawDisplayStream, rawMicStream]);

      if (rawCamStream) {
        const pipStream = buildWebcamPipTrack(rawDisplayStream, rawCamStream);
        finalVideoTrack = pipStream.getVideoTracks()[0];
        previewStream = new MediaStream([finalVideoTrack]);
      } else {
        finalVideoTrack = rawDisplayStream.getVideoTracks()[0];
        previewStream = new MediaStream([finalVideoTrack]);
      }

      if (audioTrack) previewStream.addTrack(audioTrack);
    }

    mediaStream = isCameraOnly ? rawCamStream : previewStream;
    recordedChunks = [];
    recordingSeconds = 0;
    isPaused = false;

    const videoPreview = document.getElementById('liveVideoPreview');
    videoPreview.srcObject = mediaStream;

    cardLauncher.style.display = 'none';
    cardReviewVideo.style.display = 'none';
    liveStudioView.style.display = 'flex';

    const timerEl = document.getElementById('liveTimerText');
    timerEl.textContent = '00:00';

    // If user stops sharing via the browser's own share bar
    const sourceVideoTrack = isCameraOnly
      ? rawCamStream.getVideoTracks()[0]
      : rawDisplayStream.getVideoTracks()[0];
    sourceVideoTrack.onended = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    };

    await runCountdown(opts.countdown);

    // MediaRecorder setup
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      clearInterval(timerInterval);
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      currentRecordedBlob = blob;

      const videoUrl = URL.createObjectURL(blob);
      const reviewEl = document.getElementById('reviewVideoEl');
      reviewEl.src = videoUrl;

      liveStudioView.style.display = 'none';
      cardReviewVideo.style.display = 'block';

      teardownRecordingSources();
      saveVideoToStorage(blob, recordingSeconds);
    };

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!isPaused) {
        recordingSeconds++;
        timerEl.textContent = formatTime(recordingSeconds);
      }
    }, 1000);

    mediaRecorder.start(1000);

  } catch (err) {
    console.error('Failed to start recording stream', err);
    teardownRecordingSources();
    cardLauncher.style.display = 'block';
    liveStudioView.style.display = 'none';
  }
}

function teardownRecordingSources() {
  if (pipRafId) {
    cancelAnimationFrame(pipRafId);
    pipRafId = null;
  }
  if (pipAudioCtx) {
    pipAudioCtx.close().catch(() => {});
    pipAudioCtx = null;
  }
  [rawDisplayStream, rawCamStream, rawMicStream].forEach(s => {
    if (s) s.getTracks().forEach(t => t.stop());
  });
  rawDisplayStream = null;
  rawCamStream = null;
  rawMicStream = null;
}

// Button Listeners
document.getElementById('btnLaunchScreenRec').addEventListener('click', () => startRecordingFlow(false));
document.getElementById('btnLaunchCameraOnly').addEventListener('click', () => startRecordingFlow(true));

// Pause / Resume
document.getElementById('btnPauseResume').addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (isPaused) {
    mediaRecorder.resume();
    isPaused = false;
    document.getElementById('btnPauseResume').textContent = 'Pause';
  } else {
    mediaRecorder.pause();
    isPaused = true;
    document.getElementById('btnPauseResume').textContent = 'Resume';
  }
});

// Stop
document.getElementById('btnStopRecord').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
  }
});

// Record Again
document.getElementById('btnRecordAgain').addEventListener('click', () => {
  cardReviewVideo.style.display = 'none';
  cardLauncher.style.display = 'block';
});

// Download Video
document.getElementById('btnDownloadReviewWebm').addEventListener('click', () => {
  if (!currentRecordedBlob) return;
  const filename = 'screen-recording-' + Date.now() + '.webm';
  downloadMediaFile(currentRecordedBlob, filename);
});

// Grabs a single frame from an OS-level screen/window/monitor picker
// (getDisplayMedia), unlike "Capture Visible Part" which is restricted by
// Chrome to the current tab's own viewport and can never see other
// monitors, the desktop, or other apps.
async function captureEntireScreenSnapshot() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.warn('Entire screen snapshot cancelled or failed', err);
    return;
  }

  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play().then(resolve).catch(resolve);
    };
  });

  // Small delay to ensure frame data is rendered into video element
  await new Promise(r => setTimeout(r, 150));

  const width = video.videoWidth || 1920;
  const height = video.videoHeight || 1080;

  const snapCanvas = document.createElement('canvas');
  snapCanvas.width = width;
  snapCanvas.height = height;
  const ctx = snapCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0, width, height);

  track.stop();
  stream.getTracks().forEach(t => t.stop());

  const dataUrl = snapCanvas.toDataURL('image/png');
  autoStoreScreenshot(dataUrl);
  initCanvasWithImage(dataUrl);
}

// ---------------- Persistence: IndexedDB (videos) + chrome.storage (index) ----------------
const VIDEO_DB_NAME = 'AwesomeRecorderDB';
const VIDEO_DB_STORE = 'videos';

function openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(VIDEO_DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function addLibraryIndexEntry(entry) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['library_index'], (res) => {
      const list = res.library_index || [];
      list.unshift(entry);
      chrome.storage.local.set({ library_index: list }, resolve);
    });
  });
}

function removeLibraryIndexEntry(id) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['library_index'], (res) => {
      const list = (res.library_index || []).filter(e => e.id !== id);
      chrome.storage.local.set({ library_index: list }, resolve);
    });
  });
}

function getVideoBlob(id) {
  return openVideoDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_DB_STORE, 'readonly');
    const req = tx.objectStore(VIDEO_DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  }));
}

function deleteVideoBlob(id) {
  return openVideoDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_DB_STORE, 'readwrite');
    tx.objectStore(VIDEO_DB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  }));
}

async function saveVideoToStorage(blob, duration) {
  try {
    const db = await openVideoDB();
    const id = 'vid_' + Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_DB_STORE, 'readwrite');
      tx.objectStore(VIDEO_DB_STORE).put({ id, blob, duration });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await addLibraryIndexEntry({ id, type: 'video', duration, createdAt: Date.now() });
    checkStorageQuotaAlert();
  } catch (err) {
    console.error('Failed to save recording to IndexedDB', err);
  }
}

// ---------------- Interactive Screenshot Markup Editor (Shapes & Objects) ----------------
const canvas = document.getElementById('markupCanvas');
const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;

let shapes = [];
let selectedShapeId = null;
let isDraggingShape = false;
let isResizingShape = false;
let activeResizeHandle = null;
let dragStartX = 0;
let dragStartY = 0;
let currentLiveShape = null;

let strokeWidth = 4;
let stepCounter = 1;
let activeEmoji = '✅';

// Crop Mode State
let isCropMode = false;
let cropRect = { x: 0, y: 0, w: 0, h: 0 };
let isDraggingCrop = false;
let isResizingCrop = false;
let activeCropHandle = null;

const HANDLE_SIZE = 10;

function initCanvasWithImage(imgSrc) {
  screenshotImage.crossOrigin = 'anonymous';
  screenshotImage.onload = () => {
    if (!canvas || !ctx) return;
    canvas.width = screenshotImage.naturalWidth || screenshotImage.width || 1280;
    canvas.height = screenshotImage.naturalHeight || screenshotImage.height || 720;
    shapes = [];
    selectedShapeId = null;
    stepCounter = 1;
    isCropMode = false;
    document.getElementById('cropActionBar').style.display = 'none';
    redrawCanvas(true);

    const canvasWrap = document.querySelector('.canvas-wrap');
    const btnToggleZoom = document.getElementById('btnToggleZoom');
    if (canvasWrap) {
      canvasWrap.classList.remove('actual-mode');
      canvasWrap.classList.add('fit-mode');
    }
    if (btnToggleZoom) {
      btnToggleZoom.textContent = '🔍 Fit Screen';
      btnToggleZoom.classList.add('active');
    }

    switchView('screenshot');
  };
  screenshotImage.onerror = () => {
    console.warn('Failed to load screenshot image source into canvas');
    if (canvas && ctx) {
      canvas.width = 1280;
      canvas.height = 720;
      shapes = [];
      selectedShapeId = null;
      stepCounter = 1;
      isCropMode = false;
      redrawCanvas(true);
      switchView('screenshot');
    }
  };
  screenshotImage.src = imgSrc;
}

function saveCanvasState() {
  canvasHistory.push(JSON.stringify(shapes));
  if (canvasHistory.length > 30) canvasHistory.shift();
}

function getShapeBounds(shape) {
  if (!shape) return { x: 0, y: 0, w: 0, h: 0 };
  
  if (shape.type === 'pen' || shape.type === 'highlighter') {
    if (!shape.points || shape.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    shape.points.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    const padding = 8;
    return {
      x: minX - padding,
      y: minY - padding,
      w: Math.max(16, maxX - minX + padding * 2),
      h: Math.max(16, maxY - minY + padding * 2)
    };
  }

  let x = Math.min(shape.x, shape.x + shape.w);
  let y = Math.min(shape.y, shape.y + shape.h);
  let w = Math.abs(shape.w);
  let h = Math.abs(shape.h);

  if (shape.type === 'text') {
    const fontSize = shape.fontSize || 22;
    const textLen = (shape.text || '').length;
    w = Math.max(w, textLen * (fontSize * 0.65) + 10);
    h = Math.max(h, fontSize * 1.3);
  } else if (shape.type === 'step') {
    w = Math.max(w, 34);
    h = Math.max(h, 34);
  } else if (shape.type === 'emoji') {
    w = Math.max(w, 36);
    h = Math.max(h, 36);
  }

  return { x, y, w: Math.max(14, w), h: Math.max(14, h) };
}

function getHandlePositions(bounds) {
  const { x, y, w, h } = bounds;
  return {
    nw: { x: x, y: y },
    n:  { x: x + w / 2, y: y },
    ne: { x: x + w, y: y },
    e:  { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s:  { x: x + w / 2, y: y + h },
    sw: { x: x, y: y + h },
    w:  { x: x, y: y + h / 2 }
  };
}

function drawSingleShape(targetCtx, shape) {
  if (!shape) return;
  targetCtx.save();
  targetCtx.strokeStyle = shape.color || strokeColor;
  targetCtx.fillStyle = shape.color || strokeColor;
  targetCtx.lineWidth = shape.strokeWidth || 4;
  targetCtx.lineCap = 'round';
  targetCtx.lineJoin = 'round';

  const bounds = getShapeBounds(shape);
  const x = bounds.x;
  const y = bounds.y;
  const w = bounds.w;
  const h = bounds.h;

  if (shape.type === 'rect') {
    targetCtx.strokeRect(x, y, w, h);
  } else if (shape.type === 'circle') {
    targetCtx.beginPath();
    targetCtx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
    targetCtx.stroke();
  } else if (shape.type === 'line') {
    targetCtx.beginPath();
    targetCtx.moveTo(shape.x, shape.y);
    targetCtx.lineTo(shape.x + shape.w, shape.y + shape.h);
    targetCtx.stroke();
  } else if (shape.type === 'arrow') {
    const startX = shape.x;
    const startY = shape.y;
    const endX = shape.x + shape.w;
    const endY = shape.y + shape.h;

    targetCtx.beginPath();
    targetCtx.moveTo(startX, startY);
    targetCtx.lineTo(endX, endY);
    targetCtx.stroke();

    const dist = Math.hypot(endX - startX, endY - startY);
    if (dist >= 4) {
      const angle = Math.atan2(endY - startY, endX - startX);
      const headLen = Math.min(28, Math.max(14, dist * 0.25));
      targetCtx.beginPath();
      targetCtx.moveTo(endX, endY);
      targetCtx.lineTo(endX - headLen * Math.cos(angle - Math.PI / 6), endY - headLen * Math.sin(angle - Math.PI / 6));
      targetCtx.lineTo(endX - headLen * Math.cos(angle + Math.PI / 6), endY - headLen * Math.sin(angle + Math.PI / 6));
      targetCtx.closePath();
      targetCtx.fill();
    }
  } else if (shape.type === 'highlighter') {
    targetCtx.save();
    targetCtx.globalAlpha = 0.45;
    targetCtx.strokeStyle = shape.color || '#fde047';
    targetCtx.lineWidth = Math.max(12, (shape.strokeWidth || 4) * 3);
    targetCtx.lineCap = 'square';
    if (shape.points && shape.points.length > 0) {
      targetCtx.beginPath();
      targetCtx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) {
        targetCtx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      targetCtx.stroke();
    }
    targetCtx.restore();
  } else if (shape.type === 'step') {
    const r = Math.max(14, Math.min(w, h) / 2);
    targetCtx.beginPath();
    targetCtx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
    targetCtx.fillStyle = shape.color || strokeColor;
    targetCtx.fill();
    targetCtx.strokeStyle = '#ffffff';
    targetCtx.lineWidth = 2;
    targetCtx.stroke();

    targetCtx.fillStyle = '#ffffff';
    targetCtx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    targetCtx.textAlign = 'center';
    targetCtx.textBaseline = 'middle';
    targetCtx.fillText(String(shape.stepNumber || 1), x + w / 2, y + h / 2 + 1);
  } else if (shape.type === 'emoji') {
    const fontSz = Math.round(Math.max(24, Math.min(w, h)));
    targetCtx.font = `${fontSz}px sans-serif`;
    targetCtx.textAlign = 'left';
    targetCtx.textBaseline = 'top';
    targetCtx.fillText(shape.emojiText || '✅', x, y);
  } else if (shape.type === 'text') {
    const fontSize = shape.fontSize || 22;
    targetCtx.font = `bold ${fontSize}px sans-serif`;
    targetCtx.fillText(shape.text || 'Text', x, y + fontSize * 0.85);
  } else if (shape.type === 'pen') {
    if (shape.points && shape.points.length > 0) {
      targetCtx.beginPath();
      targetCtx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) {
        targetCtx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      targetCtx.stroke();
    }
  } else if (shape.type === 'blur') {
    if (w > 2 && h > 2) {
      const bw = Math.round(w);
      const bh = Math.round(h);
      const bx = Math.round(x);
      const by = Math.round(y);

      const off = document.createElement('canvas');
      off.width = bw;
      off.height = bh;
      const offCtx = off.getContext('2d');
      if (screenshotImage && screenshotImage.src && screenshotImage.naturalWidth > 0) {
        offCtx.drawImage(screenshotImage, bx, by, bw, bh, 0, 0, bw, bh);
      } else {
        offCtx.drawImage(canvas, bx, by, bw, bh, 0, 0, bw, bh);
      }

      targetCtx.save();
      targetCtx.filter = 'blur(10px)';
      targetCtx.drawImage(off, bx, by, bw, bh);
      targetCtx.restore();
    }
  }
  targetCtx.restore();
}

function drawSelectionOverlay(targetCtx, shape) {
  const bounds = getShapeBounds(shape);
  const pad = 6;
  const bx = bounds.x - pad;
  const by = bounds.y - pad;
  const bw = bounds.w + pad * 2;
  const bh = bounds.h + pad * 2;

  targetCtx.save();
  targetCtx.strokeStyle = '#2563eb';
  targetCtx.lineWidth = 2;
  targetCtx.setLineDash([6, 4]);
  targetCtx.strokeRect(bx, by, bw, bh);
  targetCtx.setLineDash([]);

  const handles = getHandlePositions({ x: bx, y: by, w: bw, h: bh });
  targetCtx.fillStyle = '#ffffff';
  targetCtx.strokeStyle = '#2563eb';
  targetCtx.lineWidth = 2;

  Object.values(handles).forEach(pt => {
    targetCtx.beginPath();
    targetCtx.rect(pt.x - HANDLE_SIZE / 2, pt.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    targetCtx.fill();
    targetCtx.stroke();
  });

  targetCtx.restore();
}

function redrawCanvas(showHandles = true) {
  if (!canvas || !ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 1. Base Screenshot Image
  if (screenshotImage && screenshotImage.src && screenshotImage.naturalWidth > 0) {
    ctx.drawImage(screenshotImage, 0, 0, canvas.width, canvas.height);
  }

  // 2. All Drawn Objects
  shapes.forEach(s => drawSingleShape(ctx, s));

  // 3. Live Shape Preview
  if (isDrawing && currentLiveShape) {
    drawSingleShape(ctx, currentLiveShape);
  }

  // 4. Selection Overlay & Handles
  if (showHandles && selectedShapeId && !isCropMode) {
    const selectedShape = shapes.find(s => s.id === selectedShapeId);
    if (selectedShape) {
      drawSelectionOverlay(ctx, selectedShape);
    }
  }

  // 5. Crop Overlay Mode
  if (showHandles && isCropMode) {
    ctx.save();
    // Dim background outside cropRect
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    ctx.fill('evenodd');

    // Crop border
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    ctx.setLineDash([]);

    // Crop handles
    const handles = getHandlePositions(cropRect);
    ctx.fillStyle = '#2563eb';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    Object.values(handles).forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }
}

function hitTestHandle(shape, cx, cy) {
  if (!shape) return null;
  const bounds = getShapeBounds(shape);
  const pad = 6;
  const handles = getHandlePositions({ x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 });

  for (const [key, pt] of Object.entries(handles)) {
    if (Math.abs(cx - pt.x) <= HANDLE_SIZE && Math.abs(cy - pt.y) <= HANDLE_SIZE) {
      return key;
    }
  }
  return null;
}

function hitTestShape(shape, cx, cy) {
  const bounds = getShapeBounds(shape);
  const pad = 8;
  return (
    cx >= bounds.x - pad &&
    cx <= bounds.x + bounds.w + pad &&
    cy >= bounds.y - pad &&
    cy <= bounds.y + bounds.h + pad
  );
}

// Tool switching
document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTool = btn.dataset.tool;

    // Toggle sub-bars
    document.getElementById('emojiPaletteBar').style.display = (activeTool === 'emoji') ? 'flex' : 'none';
    if (isCropMode) cancelCropMode();

    if (activeTool !== 'select') {
      selectedShapeId = null;
      redrawCanvas(true);
    }
  });
});

// Stroke Thickness Selector
const strokeWidthSelect = document.getElementById('strokeWidthSelect');
if (strokeWidthSelect) {
  strokeWidthSelect.addEventListener('change', (e) => {
    strokeWidth = parseInt(e.target.value, 10) || 4;
    if (selectedShapeId) {
      const shape = shapes.find(s => s.id === selectedShapeId);
      if (shape) {
        shape.strokeWidth = strokeWidth;
        redrawCanvas(true);
        saveCanvasState();
      }
    }
  });
}

// Emoji selection buttons
document.querySelectorAll('.emoji-opt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-opt-btn').forEach(b => b.style.borderColor = '#e2e8f0');
    btn.style.borderColor = '#2563eb';
    activeEmoji = btn.dataset.emoji || '✅';
  });
});

// Crop Mode Handlers
const btnCropMode = document.getElementById('btnCropMode');
const cropActionBar = document.getElementById('cropActionBar');
const btnApplyCrop = document.getElementById('btnApplyCrop');
const btnCancelCrop = document.getElementById('btnCancelCrop');

function startCropMode() {
  isCropMode = true;
  selectedShapeId = null;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
  document.getElementById('emojiPaletteBar').style.display = 'none';
  cropActionBar.style.display = 'flex';

  const marginX = Math.round(canvas.width * 0.08);
  const marginY = Math.round(canvas.height * 0.08);
  cropRect = {
    x: marginX,
    y: marginY,
    w: Math.max(100, canvas.width - marginX * 2),
    h: Math.max(100, canvas.height - marginY * 2)
  };
  redrawCanvas(true);
}

function cancelCropMode() {
  isCropMode = false;
  cropActionBar.style.display = 'none';
  redrawCanvas(true);
}

if (btnCropMode) btnCropMode.addEventListener('click', startCropMode);
if (btnCancelCrop) btnCancelCrop.addEventListener('click', cancelCropMode);

if (btnApplyCrop) {
  btnApplyCrop.addEventListener('click', () => {
    if (!isCropMode || cropRect.w < 20 || cropRect.h < 20) return;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.round(cropRect.w);
    cropCanvas.height = Math.round(cropRect.h);
    const cropCtx = cropCanvas.getContext('2d');

    // Render clean shapes and background onto temporary canvas
    redrawCanvas(false);
    cropCtx.drawImage(canvas, Math.round(cropRect.x), Math.round(cropRect.y), cropCanvas.width, cropCanvas.height, 0, 0, cropCanvas.width, cropCanvas.height);

    // Update screenshotImage and shapes coordinates relative to crop
    const croppedDataUrl = cropCanvas.toDataURL('image/png');
    const cropX = cropRect.x;
    const cropY = cropRect.y;

    screenshotImage = new Image();
    screenshotImage.onload = () => {
      canvas.width = cropCanvas.width;
      canvas.height = cropCanvas.height;

      // Adjust existing shapes to new crop offset
      shapes.forEach(s => {
        s.x -= cropX;
        s.y -= cropY;
        if (s.points) {
          s.points.forEach(p => {
            p.x -= cropX;
            p.y -= cropY;
          });
        }
      });

      cancelCropMode();
      saveCanvasState();
    };
    screenshotImage.src = croppedDataUrl;
  });
}

const btnToggleZoom = document.getElementById('btnToggleZoom');
if (btnToggleZoom) {
  btnToggleZoom.addEventListener('click', () => {
    const canvasWrap = document.querySelector('.canvas-wrap');
    if (!canvasWrap) return;
    if (canvasWrap.classList.contains('fit-mode')) {
      canvasWrap.classList.remove('fit-mode');
      canvasWrap.classList.add('actual-mode');
      btnToggleZoom.textContent = '🔍 1:1 Actual Size';
      btnToggleZoom.classList.remove('active');
    } else {
      canvasWrap.classList.remove('actual-mode');
      canvasWrap.classList.add('fit-mode');
      btnToggleZoom.textContent = '🔍 Fit Screen';
      btnToggleZoom.classList.add('active');
    }
  });
}

// Color picker updates selected object live
document.getElementById('markupColorPicker').addEventListener('input', (e) => {
  strokeColor = e.target.value;
  if (selectedShapeId) {
    const shape = shapes.find(s => s.id === selectedShapeId);
    if (shape) {
      shape.color = strokeColor;
      redrawCanvas(true);
      saveCanvasState();
    }
  }
});

// Delete selected object
function deleteSelectedShape() {
  if (selectedShapeId) {
    shapes = shapes.filter(s => s.id !== selectedShapeId);
    selectedShapeId = null;
    redrawCanvas(true);
    saveCanvasState();
  }
}

const btnDeleteSelected = document.getElementById('btnDeleteSelected');
if (btnDeleteSelected) {
  btnDeleteSelected.addEventListener('click', deleteSelectedShape);
}

// Keyboard shortcuts (Delete / Backspace key to remove shape)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    deleteSelectedShape();
  }
});

// Undo
document.getElementById('btnUndo').addEventListener('click', () => {
  if (shapes.length > 0) {
    shapes.pop();
    selectedShapeId = null;
    redrawCanvas(true);
    saveCanvasState();
  }
});

// Clear
document.getElementById('btnClearCanvas').addEventListener('click', () => {
  shapes = [];
  selectedShapeId = null;
  stepCounter = 1;
  redrawCanvas(true);
  saveCanvasState();
});

// ---------------- Download Location & Storage Quota Management ----------------
function downloadMediaFile(dataUrlOrBlob, filename) {
  chrome.storage.local.get(['save_location_mode'], (res) => {
    const mode = res.save_location_mode || 'prompt';
    const promptSave = mode === 'prompt';

    let url = dataUrlOrBlob;
    if (dataUrlOrBlob instanceof Blob) {
      url = URL.createObjectURL(dataUrlOrBlob);
    }

    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({
        url: url,
        filename: filename,
        saveAs: promptSave
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn('chrome.downloads failed, falling back to anchor tag:', chrome.runtime.lastError);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.click();
        }
      });
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
    }
  });
}

function autoStoreScreenshot(dataUrl) {
  const id = 'shot_' + Date.now();
  chrome.storage.local.set({ [id]: dataUrl, 'active_screenshot': dataUrl }, () => {
    addLibraryIndexEntry({ id, type: 'screenshot', createdAt: Date.now() });
    checkStorageQuotaAlert();
  });
}

async function calculateTotalStorageBytes() {
  let screenshotBytes = 0;
  let videoBytes = 0;

  await new Promise(resolve => {
    if (chrome.storage && chrome.storage.local && chrome.storage.local.getBytesInUse) {
      chrome.storage.local.getBytesInUse(null, (bytes) => {
        screenshotBytes = bytes || 0;
        resolve();
      });
    } else {
      chrome.storage.local.get(null, (res) => {
        screenshotBytes = JSON.stringify(res || {}).length;
        resolve();
      });
    }
  });

  try {
    const db = await openVideoDB();
    videoBytes = await new Promise(resolve => {
      const tx = db.transaction(VIDEO_DB_STORE, 'readonly');
      const store = tx.objectStore(VIDEO_DB_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        let total = 0;
        (req.result || []).forEach(item => {
          if (item.blob) total += item.blob.size;
        });
        resolve(total);
      };
      req.onerror = () => resolve(0);
    });
  } catch (e) {
    videoBytes = 0;
  }

  return screenshotBytes + videoBytes;
}

async function calculateAndUpdateStorageUsage() {
  const usageTextEl = document.getElementById('storageUsageText');
  const usageBarEl = document.getElementById('storageUsageBar');
  if (!usageTextEl || !usageBarEl) return;

  const totalBytes = await calculateTotalStorageBytes();
  const usedMB = (totalBytes / (1024 * 1024)).toFixed(1);

  chrome.storage.local.get(['storage_limit_mb'], (res) => {
    const limitMB = (res.storage_limit_mb !== undefined) ? parseInt(res.storage_limit_mb, 10) : 1000;
    if (limitMB === 0) {
      usageTextEl.textContent = `${usedMB} MB / Unlimited allocated`;
      usageBarEl.style.width = '10%';
      usageBarEl.style.background = '#2563eb';
    } else {
      const pct = Math.min(100, Math.round((usedMB / limitMB) * 100));
      usageTextEl.textContent = `${usedMB} MB / ${limitMB} MB allocated (${pct}%)`;
      usageBarEl.style.width = `${pct}%`;

      if (pct >= 90) {
        usageBarEl.style.background = '#ef4444';
      } else if (pct >= 70) {
        usageBarEl.style.background = '#f59e0b';
      } else {
        usageBarEl.style.background = '#2563eb';
      }
    }
  });
}

async function checkStorageQuotaAlert() {
  const totalBytes = await calculateTotalStorageBytes();
  const usedMB = totalBytes / (1024 * 1024);

  chrome.storage.local.get(['storage_limit_mb', 'storage_notify_enabled'], (res) => {
    const limitMB = (res.storage_limit_mb !== undefined) ? parseInt(res.storage_limit_mb, 10) : 1000;
    const notifyEnabled = res.storage_notify_enabled !== false;

    if (limitMB > 0 && usedMB >= limitMB * 0.9) {
      const pct = Math.round((usedMB / limitMB) * 100);
      if (notifyEnabled && chrome.notifications) {
        chrome.notifications.create('quota_alert_' + Date.now(), {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '⚠️ Screen Recorder Storage Warning',
          message: `Storage capacity is at ${pct}% (${usedMB.toFixed(1)} MB / ${limitMB} MB used). Please clean up saved library items!`
        });
      }
    }
  });
}

// Settings Event Handlers
const btnSaveSettings = document.getElementById('btnSaveSettings');
if (btnSaveSettings) {
  btnSaveSettings.addEventListener('click', () => {
    const saveLocationMode = document.querySelector('input[name="saveLocationMode"]:checked')?.value || 'prompt';
    const storageLimitMB = parseInt(document.getElementById('selectStorageLimit')?.value, 10);
    const storageNotifyEnabled = document.getElementById('chkStorageNotify')?.checked !== false;

    chrome.storage.local.set({
      save_location_mode: saveLocationMode,
      storage_limit_mb: isNaN(storageLimitMB) ? 1000 : storageLimitMB,
      storage_notify_enabled: storageNotifyEnabled
    }, () => {
      const msg = document.getElementById('saveSettingsMsg');
      if (msg) {
        msg.style.display = 'inline';
        setTimeout(() => msg.style.display = 'none', 2500);
      }
      calculateAndUpdateStorageUsage();
    });
  });
}

function loadSettingsForm() {
  chrome.storage.local.get(['save_location_mode', 'storage_limit_mb', 'storage_notify_enabled'], (res) => {
    const mode = res.save_location_mode || 'prompt';
    const radio = document.querySelector(`input[name="saveLocationMode"][value="${mode}"]`);
    if (radio) radio.checked = true;

    const limit = res.storage_limit_mb !== undefined ? res.storage_limit_mb : 1000;
    const selectLimit = document.getElementById('selectStorageLimit');
    if (selectLimit) selectLimit.value = String(limit);

    const chkNotify = document.getElementById('chkStorageNotify');
    if (chkNotify) chkNotify.checked = res.storage_notify_enabled !== false;
  });
}
loadSettingsForm();

const btnRefreshStorage = document.getElementById('btnRefreshStorage');
if (btnRefreshStorage) {
  btnRefreshStorage.addEventListener('click', calculateAndUpdateStorageUsage);
}

// Export (clean render without selection handles)
document.getElementById('btnDownloadShot').addEventListener('click', () => {
  redrawCanvas(false);
  const dataUrl = canvas.toDataURL('image/png');
  const filename = 'screenshot-markup-' + Date.now() + '.png';
  autoStoreScreenshot(dataUrl);
  downloadMediaFile(dataUrl, filename);
  redrawCanvas(true);
});

document.getElementById('btnCopyShot').addEventListener('click', async () => {
  redrawCanvas(false);
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      alert('Screenshot copied to clipboard!');
    } catch (e) {
      alert('Could not copy automatically. Download as PNG instead.');
    } finally {
      redrawCanvas(true);
    }
  });
});

// Canvas Mouse Interactions (Select, Move, Resize, Draw, Crop)
function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY
  };
}

canvas.addEventListener('mousedown', (e) => {
  const { x, y } = getCanvasCoords(e);
  dragStartX = x;
  dragStartY = y;

  // Crop Mode Interactions
  if (isCropMode) {
    const handles = getHandlePositions(cropRect);
    for (const [key, pt] of Object.entries(handles)) {
      if (Math.abs(x - pt.x) <= 12 && Math.abs(y - pt.y) <= 12) {
        isResizingCrop = true;
        activeCropHandle = key;
        return;
      }
    }
    if (x >= cropRect.x && x <= cropRect.x + cropRect.w && y >= cropRect.y && y <= cropRect.y + cropRect.h) {
      isDraggingCrop = true;
      return;
    }
    return;
  }

  // 1. Check if clicking a handle of currently selected shape
  if (selectedShapeId) {
    const selectedShape = shapes.find(s => s.id === selectedShapeId);
    const handle = hitTestHandle(selectedShape, x, y);
    if (handle) {
      isResizingShape = true;
      activeResizeHandle = handle;
      return;
    }
  }

  // 2. Check if clicking on an existing shape
  let clickedShape = null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitTestShape(shapes[i], x, y)) {
      clickedShape = shapes[i];
      break;
    }
  }

  if (clickedShape) {
    selectedShapeId = clickedShape.id;
    isDraggingShape = true;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    const btnSelect = document.querySelector('.tool-btn[data-tool="select"]');
    if (btnSelect) btnSelect.classList.add('active');
    activeTool = 'select';
    redrawCanvas(true);
    return;
  }

  // 3. Clicking empty space
  if (activeTool === 'select') {
    selectedShapeId = null;
    redrawCanvas(true);
    return;
  }

  // 4. Instant Placement Tools (Step & Emoji)
  if (activeTool === 'step') {
    const newShape = {
      id: 'shape_' + Date.now(),
      type: 'step',
      x: x - 18,
      y: y - 18,
      w: 36,
      h: 36,
      stepNumber: stepCounter++,
      color: strokeColor
    };
    shapes.push(newShape);
    selectedShapeId = newShape.id;
    saveCanvasState();
    redrawCanvas(true);
    return;
  }

  if (activeTool === 'emoji') {
    const newShape = {
      id: 'shape_' + Date.now(),
      type: 'emoji',
      x: x - 18,
      y: y - 18,
      w: 40,
      h: 40,
      emojiText: activeEmoji
    };
    shapes.push(newShape);
    selectedShapeId = newShape.id;
    saveCanvasState();
    redrawCanvas(true);
    return;
  }

  // 5. Start drawing new shape
  isDrawing = true;
  selectedShapeId = null;

  if (activeTool === 'pen' || activeTool === 'highlighter') {
    currentLiveShape = {
      id: 'shape_' + Date.now(),
      type: activeTool,
      color: strokeColor,
      strokeWidth: strokeWidth,
      points: [{ x, y }]
    };
  } else if (activeTool === 'text') {
    const textStr = prompt('Enter annotation text:', 'Highlight');
    if (textStr) {
      const newShape = {
        id: 'shape_' + Date.now(),
        type: 'text',
        x,
        y,
        w: textStr.length * 14,
        h: 28,
        text: textStr,
        fontSize: 22,
        color: strokeColor
      };
      shapes.push(newShape);
      selectedShapeId = newShape.id;
      saveCanvasState();
    }
    isDrawing = false;
    currentLiveShape = null;
    redrawCanvas(true);
  } else {
    currentLiveShape = {
      id: 'shape_' + Date.now(),
      type: activeTool,
      x,
      y,
      w: 0,
      h: 0,
      color: strokeColor,
      strokeWidth: strokeWidth
    };
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { x, y } = getCanvasCoords(e);

  // Crop Mode Dragging / Resizing
  if (isCropMode) {
    canvas.style.cursor = 'crosshair';
    if (isResizingCrop) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;
      const h = activeCropHandle;
      if (h.includes('e')) cropRect.w = Math.max(30, cropRect.w + dx);
      if (h.includes('s')) cropRect.h = Math.max(30, cropRect.h + dy);
      if (h.includes('w')) { cropRect.x += dx; cropRect.w = Math.max(30, cropRect.w - dx); }
      if (h.includes('n')) { cropRect.y += dy; cropRect.h = Math.max(30, cropRect.h - dy); }
      redrawCanvas(true);
      return;
    }
    if (isDraggingCrop) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;
      cropRect.x = Math.max(0, Math.min(canvas.width - cropRect.w, cropRect.x + dx));
      cropRect.y = Math.max(0, Math.min(canvas.height - cropRect.h, cropRect.y + dy));
      redrawCanvas(true);
      return;
    }
    return;
  }

  // Dynamic cursor update when hovering
  if (!isDrawing && !isDraggingShape && !isResizingShape) {
    let handleHover = null;
    let shapeHover = false;
    if (selectedShapeId) {
      const selectedShape = shapes.find(s => s.id === selectedShapeId);
      handleHover = hitTestHandle(selectedShape, x, y);
    }
    if (!handleHover) {
      shapeHover = shapes.some(s => hitTestShape(s, x, y));
    }

    if (handleHover) {
      if (handleHover === 'nw' || handleHover === 'se') canvas.style.cursor = 'nwse-resize';
      else if (handleHover === 'ne' || handleHover === 'sw') canvas.style.cursor = 'nesw-resize';
      else if (handleHover === 'n' || handleHover === 's') canvas.style.cursor = 'ns-resize';
      else if (handleHover === 'e' || handleHover === 'w') canvas.style.cursor = 'ew-resize';
    } else if (shapeHover || activeTool === 'select') {
      canvas.style.cursor = shapeHover ? 'move' : 'default';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  // Handle Resizing Shapes
  if (isResizingShape && selectedShapeId) {
    const shape = shapes.find(s => s.id === selectedShapeId);
    if (shape) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;

      const bounds = getShapeBounds(shape);
      const h = activeResizeHandle;

      if (shape.type === 'pen' || shape.type === 'highlighter') {
        const scaleX = (bounds.w + (h.includes('e') ? dx : h.includes('w') ? -dx : 0)) / Math.max(1, bounds.w);
        const scaleY = (bounds.h + (h.includes('s') ? dy : h.includes('n') ? -dy : 0)) / Math.max(1, bounds.h);
        shape.points.forEach(p => {
          p.x = bounds.x + (p.x - bounds.x) * scaleX + (h.includes('w') ? dx : 0);
          p.y = bounds.y + (p.y - bounds.y) * scaleY + (h.includes('n') ? dy : 0);
        });
      } else {
        if (h.includes('e')) shape.w += dx;
        if (h.includes('s')) shape.h += dy;
        if (h.includes('w')) { shape.x += dx; shape.w -= dx; }
        if (h.includes('n')) { shape.y += dy; shape.h -= dy; }

        if (shape.type === 'text') {
          shape.fontSize = Math.max(12, Math.min(96, (shape.fontSize || 22) + dy * 0.2));
        }
      }
      redrawCanvas(true);
    }
    return;
  }

  // Handle Dragging / Moving Shapes
  if (isDraggingShape && selectedShapeId) {
    const shape = shapes.find(s => s.id === selectedShapeId);
    if (shape) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;

      shape.x += dx;
      shape.y += dy;
      if (shape.points) {
        shape.points.forEach(p => {
          p.x += dx;
          p.y += dy;
        });
      }
      redrawCanvas(true);
    }
    return;
  }

  // Handle Live Drawing Preview
  if (isDrawing && currentLiveShape) {
    if (currentLiveShape.type === 'pen' || currentLiveShape.type === 'highlighter') {
      currentLiveShape.points.push({ x, y });
    } else {
      currentLiveShape.w = x - dragStartX;
      currentLiveShape.h = y - dragStartY;
    }
    redrawCanvas(true);
  }
});

canvas.addEventListener('mouseup', () => {
  if (isCropMode) {
    isDraggingCrop = false;
    isResizingCrop = false;
    activeCropHandle = null;
    return;
  }

  if (isDrawing && currentLiveShape) {
    if ((currentLiveShape.type !== 'pen' && currentLiveShape.type !== 'highlighter') || (currentLiveShape.points && currentLiveShape.points.length > 1)) {
      shapes.push(currentLiveShape);
      selectedShapeId = currentLiveShape.id;
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
      const btnSelect = document.querySelector('.tool-btn[data-tool="select"]');
      if (btnSelect) btnSelect.classList.add('active');
      activeTool = 'select';
      saveCanvasState();
    }
  }

  isDrawing = false;
  isDraggingShape = false;
  isResizingShape = false;
  currentLiveShape = null;
  activeResizeHandle = null;
  redrawCanvas(true);
});

// Double click shape to edit text or step number
canvas.addEventListener('dblclick', (e) => {
  const { x, y } = getCanvasCoords(e);
  const clicked = shapes.find(s => hitTestShape(s, x, y));
  if (clicked) {
    if (clicked.type === 'text') {
      const updatedText = prompt('Edit text annotation:', clicked.text);
      if (updatedText !== null) {
        if (updatedText.trim() === '') {
          deleteSelectedShape();
        } else {
          clicked.text = updatedText;
          redrawCanvas(true);
          saveCanvasState();
        }
      }
    } else if (clicked.type === 'step') {
      const updatedStep = prompt('Edit step number:', clicked.stepNumber);
      if (updatedStep !== null) {
        clicked.stepNumber = parseInt(updatedStep, 10) || clicked.stepNumber;
        redrawCanvas(true);
        saveCanvasState();
      }
    }
  }
});

// ---------------- Library ----------------
const previewModal = document.getElementById('previewModal');
const previewModalContent = document.getElementById('previewModalContent');

function closePreviewModal() {
  previewModalContent.innerHTML = '';
  previewModal.style.display = 'none';
}
document.getElementById('btnClosePreview').addEventListener('click', closePreviewModal);
previewModal.addEventListener('click', (e) => {
  if (e.target === previewModal) closePreviewModal();
});

function formatLibDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderLibrary() {
  const grid = document.getElementById('libGrid');
  chrome.storage.local.get(['library_index'], (res) => {
    const items = res.library_index || [];

    if (items.length === 0) {
      grid.innerHTML = `<p style="color:#64748b; font-size:13px; grid-column: 1 / -1;">No recordings or screenshots saved yet. Record a video or take a screenshot to see it here.</p>`;
      return;
    }

    grid.innerHTML = '';
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'lib-card';

      const isVideo = item.type === 'video';
      const thumb = document.createElement('div');
      thumb.style.cssText = 'width:100%; height:130px; background:#0f172a; display:flex; align-items:center; justify-content:center; color:white; overflow:hidden;';
      thumb.innerHTML = isVideo
        ? '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="white"/></svg>'
        : '';
      card.appendChild(thumb);

      if (!isVideo) {
        chrome.storage.local.get([item.id], (shotRes) => {
          const src = shotRes[item.id];
          if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.className = 'lib-thumb';
            thumb.innerHTML = '';
            thumb.appendChild(img);
          }
        });
      }

      const body = document.createElement('div');
      body.className = 'lib-body';

      const title = document.createElement('div');
      title.className = 'lib-title';
      title.textContent = isVideo ? 'Screen Recording' : 'Screenshot';
      body.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'lib-meta';
      meta.textContent = (isVideo ? `Duration: ${formatTime(item.duration || 0)} • WebM • ` : '') + formatLibDate(item.createdAt);
      body.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';

      const btnPreview = document.createElement('button');
      btnPreview.className = 'btn-secondary';
      btnPreview.style.cssText = 'flex:1; justify-content:center;';
      btnPreview.textContent = isVideo ? 'Preview' : 'Edit';
      btnPreview.addEventListener('click', () => {
        if (isVideo) {
          previewVideoItem(item.id);
        } else {
          chrome.storage.local.get([item.id], (shotRes) => {
            const src = shotRes[item.id];
            if (src) initCanvasWithImage(src);
          });
        }
      });
      actions.appendChild(btnPreview);

      const btnDownload = document.createElement('button');
      btnDownload.className = 'btn-secondary';
      btnDownload.style.cssText = 'flex:1; justify-content:center;';
      btnDownload.textContent = 'Download';
      btnDownload.addEventListener('click', () => downloadLibraryItem(item));
      actions.appendChild(btnDownload);

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-secondary';
      btnDelete.textContent = '🗑';
      btnDelete.title = 'Delete';
      btnDelete.addEventListener('click', () => deleteLibraryItem(item, card));
      actions.appendChild(btnDelete);

      body.appendChild(actions);
      card.appendChild(body);
      grid.appendChild(card);
    });
  });
}

function previewVideoItem(id) {
  getVideoBlob(id).then(blob => {
    if (!blob) {
      alert('This recording could not be found (it may have been deleted).');
      return;
    }
    const url = URL.createObjectURL(blob);
    previewModalContent.innerHTML = '';
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    previewModalContent.appendChild(video);
    previewModal.style.display = 'flex';
  }).catch(err => {
    console.error('Failed to load recording for preview', err);
    alert('Failed to load this recording.');
  });
}

function downloadLibraryItem(item) {
  if (item.type === 'video') {
    getVideoBlob(item.id).then(blob => {
      if (!blob) {
        alert('This recording could not be found (it may have been deleted).');
        return;
      }
      const filename = 'screen-recording-' + item.id + '.webm';
      downloadMediaFile(blob, filename);
    });
  } else {
    chrome.storage.local.get([item.id], (res) => {
      const src = res[item.id];
      if (!src) {
        alert('This screenshot could not be found (it may have been deleted).');
        return;
      }
      const filename = 'screenshot-' + item.id + '.png';
      downloadMediaFile(src, filename);
    });
  }
}

function deleteLibraryItem(item, cardEl) {
  if (!confirm('Delete this item permanently?')) return;
  const cleanup = () => {
    removeLibraryIndexEntry(item.id).then(() => cardEl.remove());
  };
  if (item.type === 'video') {
    deleteVideoBlob(item.id).then(cleanup).catch(cleanup);
  } else {
    chrome.storage.local.remove([item.id], cleanup);
  }
}

// Initial Auto-Launch Trigger
if (initialAction === 'start_record') {
  const target = urlParams.get('target');
  startRecordingFlow(target === 'camera');
} else if (initialAction === 'edit_screenshot') {
  const shotId = urlParams.get('id');
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([shotId, 'active_screenshot'], (res) => {
      const src = res[shotId] || res['active_screenshot'];
      if (src) initCanvasWithImage(src);
    });
  }
} else if (initialView) {
  switchView(initialView);
  if (initialView === 'screenshot' && urlParams.get('directCapture') === '1') {
    captureEntireScreenSnapshot();
  }
} else {
  switchView('studio');
}
