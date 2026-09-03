// Standalone Screen Recorder Engine & Screenshot Markup Editor for Chrome Extension
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let timerInterval = null;
let recordingSeconds = 0;
let isPaused = false;
let currentRecordedBlob = null;

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

const cardLauncher = document.getElementById('cardLauncher');
const liveStudioView = document.getElementById('liveStudioView');
const cardReviewVideo = document.getElementById('cardReviewVideo');
const editorView = document.getElementById('editorView');
const libraryContainer = document.getElementById('libraryContainer');

function switchView(view) {
  [navStudio, navScreenshot, navLibrary].forEach(b => b.classList.remove('active'));
  cardLauncher.style.display = 'none';
  liveStudioView.style.display = 'none';
  cardReviewVideo.style.display = 'none';
  editorView.style.display = 'none';
  libraryContainer.style.display = 'none';

  if (view === 'studio') {
    navStudio.classList.add('active');
    cardLauncher.style.display = 'block';
  } else if (view === 'screenshot') {
    navScreenshot.classList.add('active');
    editorView.style.display = 'flex';
  } else if (view === 'library') {
    navLibrary.classList.add('active');
    libraryContainer.style.display = 'block';
    renderLibrary();
  }
}

navStudio.addEventListener('click', () => switchView('studio'));
navScreenshot.addEventListener('click', () => switchView('screenshot'));
navLibrary.addEventListener('click', () => switchView('library'));

// Format time
function formatTime(s) {
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
}

// Start Screen / Tab Recording
async function startRecordingFlow(isCameraOnly = false) {
  try {
    let stream;
    if (isCameraOnly) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1920, height: 1080 },
        audio: true
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: true
      });
    }

    mediaStream = stream;
    recordedChunks = [];
    recordingSeconds = 0;
    isPaused = false;

    const videoPreview = document.getElementById('liveVideoPreview');
    videoPreview.srcObject = stream;

    cardLauncher.style.display = 'none';
    cardReviewVideo.style.display = 'none';
    liveStudioView.style.display = 'flex';

    // Timer
    const timerEl = document.getElementById('liveTimerText');
    timerEl.textContent = '00:00';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!isPaused) {
        recordingSeconds++;
        timerEl.textContent = formatTime(recordingSeconds);
      }
    }, 1000);

    // MediaRecorder setup
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });

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

      // Save to storage
      saveVideoToStorage(blob, recordingSeconds);
    };

    // If user stops sharing via browser bar
    stream.getVideoTracks()[0].onended = () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    };

    mediaRecorder.start(1000);

  } catch (err) {
    console.error('Failed to start recording stream', err);
    cardLauncher.style.display = 'block';
    liveStudioView.style.display = 'none';
  }
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
  const a = document.createElement('a');
  a.href = URL.createObjectURL(currentRecordedBlob);
  a.download = 'screen-recording-' + Date.now() + '.webm';
  a.click();
});

// Save video to indexedDB / storage
function saveVideoToStorage(blob, duration) {
  // In extension, we keep video reference in memory & indexedDB
}

// ---------------- Screenshot Markup Editor ----------------
const canvas = document.getElementById('markupCanvas');
const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;

function initCanvasWithImage(imgSrc) {
  screenshotImage.crossOrigin = 'anonymous';
  screenshotImage.onload = () => {
    if (!canvas || !ctx) return;
    canvas.width = screenshotImage.naturalWidth || screenshotImage.width || 1280;
    canvas.height = screenshotImage.naturalHeight || screenshotImage.height || 720;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(screenshotImage, 0, 0, canvas.width, canvas.height);
    canvasHistory = [];
    saveCanvasState();
    switchView('screenshot');
  };
  screenshotImage.onerror = () => {
    console.warn('Failed to load screenshot image source into canvas');
    if (canvas && ctx) {
      canvas.width = 1280;
      canvas.height = 720;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      saveCanvasState();
      switchView('screenshot');
    }
  };
  screenshotImage.src = imgSrc;
}

function saveCanvasState() {
  if (!canvas || !ctx || canvas.width <= 0 || canvas.height <= 0) return;
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    canvasHistory.push(imgData);
    if (canvasHistory.length > 30) {
      canvasHistory.shift();
    }
  } catch (err) {
    console.warn('ctx.getImageData failed in saveCanvasState, trying dataURL fallback:', err);
    try {
      const dataUrl = canvas.toDataURL('image/png');
      canvasHistory.push(dataUrl);
      if (canvasHistory.length > 30) {
        canvasHistory.shift();
      }
    } catch (fallbackErr) {
      console.error('saveCanvasState could not capture canvas state', fallbackErr);
    }
  }
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTool = btn.dataset.tool;
  });
});

document.getElementById('markupColorPicker').addEventListener('input', (e) => {
  strokeColor = e.target.value;
});

document.getElementById('btnUndo').addEventListener('click', () => {
  if (!canvas || !ctx || canvasHistory.length <= 1) return;
  canvasHistory.pop();
  const prev = canvasHistory[canvasHistory.length - 1];
  if (!prev) return;

  if (typeof prev === 'string') {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = prev;
  } else if (prev instanceof ImageData) {
    try {
      ctx.putImageData(prev, 0, 0);
    } catch (err) {
      console.warn('ctx.putImageData failed on undo', err);
    }
  }
});

document.getElementById('btnClearCanvas').addEventListener('click', () => {
  if (screenshotImage.src) {
    ctx.drawImage(screenshotImage, 0, 0);
    saveCanvasState();
  }
});

document.getElementById('btnDownloadShot').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'screenshot-markup-' + Date.now() + '.png';
  a.click();
});

document.getElementById('btnCopyShot').addEventListener('click', async () => {
  canvas.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      alert('Screenshot copied to clipboard!');
    } catch (e) {
      alert('Could not copy automatically. Download as PNG instead.');
    }
  });
});

// Canvas Drawing Interactions
canvas.addEventListener('mousedown', (e) => {
  isDrawing = true;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  startX = (e.clientX - rect.left) * scaleX;
  startY = (e.clientY - rect.top) * scaleY;
});

canvas.addEventListener('mouseup', (e) => {
  if (!isDrawing) return;
  isDrawing = false;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const endX = (e.clientX - rect.left) * scaleX;
  const endY = (e.clientY - rect.top) * scaleY;

  ctx.strokeStyle = strokeColor;
  ctx.fillStyle = strokeColor;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';

  if (activeTool === 'arrow') {
    // Draw arrow
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();

    const angle = Math.atan2(endY - startY, endX - startX);
    const headLen = 16;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI / 6), endY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI / 6), endY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else if (activeTool === 'rect') {
    ctx.strokeRect(startX, startY, endX - startX, endY - startY);
  } else if (activeTool === 'circle') {
    const rx = Math.abs(endX - startX) / 2;
    const ry = Math.abs(endY - startY) / 2;
    const cx = startX + (endX - startX) / 2;
    const cy = startY + (endY - startY) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (activeTool === 'text') {
    const text = prompt('Enter annotation text:', 'Highlight');
    if (text) {
      ctx.font = 'bold 20px sans-serif';
      ctx.fillText(text, startX, startY);
    }
  } else if (activeTool === 'blur') {
    ctx.filter = 'blur(10px)';
    ctx.drawImage(canvas, startX, startY, endX - startX, endY - startY, startX, startY, endX - startX, endY - startY);
    ctx.filter = 'none';
  }

  saveCanvasState();
});

// Library Mock Render
function renderLibrary() {
  const grid = document.getElementById('libGrid');
  grid.innerHTML = `
    <div class="lib-card">
      <div style="background: #0f172a; height: 130px; display: flex; align-items: center; justify-content: center; color: white;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="white"/></svg>
      </div>
      <div class="lib-body">
        <div class="lib-title">Sample Screen Demo</div>
        <div class="lib-meta">Duration: 00:45 • WebM</div>
        <button class="btn-secondary" style="width: 100%; justify-content: center;" onclick="alert('Demo sample item')">Preview</button>
      </div>
    </div>
  `;
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
} else {
  switchView('studio');
}
