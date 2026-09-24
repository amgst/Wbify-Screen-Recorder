// Standalone Screen Recorder Engine & Screenshot Markup Editor for Chrome Extension
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;
let timerInterval = null;
let recordingSeconds = 0;
let isPaused = false;
let liveRecordingState = 'idle';
// Wall-clock recording length (excluding paused time), used to write the
// duration into the WebM header when recording stops.
let recordingStartedAt = 0;
let pausedTotalMs = 0;
let pauseStartedAt = 0;
let currentRecordedBlob = null;
let currentRecordedFilename = null;
// 'mp4' when the browser can record H.264/AAC directly, otherwise 'webm'
let recordingContainer = 'webm';

// Extra source streams kept around only so we can stop their tracks / tear
// down compositing when recording ends.
let rawDisplayStream = null;
let rawCamStream = null;
let rawMicStream = null;
let pipRafId = null;
let pipAudioCtx = null;
// Plays a captured tab's audio back through the speakers (Chrome mutes a tab
// while it is being captured unless something plays the audio again).
let tabPlaybackCtx = null;

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

// One-time direct-capture ids handed over by the popup (skip asking again in
// Studio after Chrome's chooser has already approved the source).
let pendingTabCapture = urlParams.get('streamId')
  ? {
      streamId: urlParams.get('streamId'),
      tabId: parseInt(urlParams.get('tabId'), 10),
      windowId: parseInt(urlParams.get('windowId'), 10)
    }
  : null;
let pendingDesktopStreamId = urlParams.get('desktopStreamId') || null;

// Nav buttons
const navStudio = document.getElementById('navStudio');
const navScreenshot = document.getElementById('navScreenshot');
const navLibrary = document.getElementById('navLibrary');
const navSettings = document.getElementById('navSettings');

const cardLauncher = document.getElementById('cardLauncher');
const liveStudioView = document.getElementById('liveStudioView');
const cardReviewVideo = document.getElementById('cardReviewVideo');
const cardVideoEditor = document.getElementById('cardVideoEditor');
const editorView = document.getElementById('editorView');
const libraryContainer = document.getElementById('libraryContainer');
const settingsContainer = document.getElementById('settingsContainer');

function switchView(view) {
  [navStudio, navScreenshot, navLibrary, navSettings].forEach(b => { if (b) b.classList.remove('active'); });
  cardLauncher.style.display = 'none';
  liveStudioView.style.display = 'none';
  cardReviewVideo.style.display = 'none';
  cardVideoEditor.style.display = 'none';
  editorView.style.display = 'none';
  libraryContainer.style.display = 'none';
  if (settingsContainer) settingsContainer.style.display = 'none';
  if (view !== 'videoedit') document.getElementById('editVideoEl').pause();

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
  } else if (view === 'videoedit') {
    cardVideoEditor.style.display = 'block';
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
    countdown: urlParams.has('countdown') ? (parseInt(urlParams.get('countdown'), 10) || 0) : 0,
    target: urlParams.get('target') || 'desktop'
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

function setButtonLabel(button, label) {
  if (!button) return;
  const labelEl = button.querySelector('span:last-child') || button;
  labelEl.textContent = label;
}

function setLiveRecordingUi(state) {
  liveRecordingState = state;
  const badge = document.getElementById('liveBadge');
  const badgeText = document.getElementById('liveBadgeText');
  const title = document.getElementById('livePlaceholderTitle');
  const desc = document.getElementById('livePlaceholderDesc');
  const pauseBtn = document.getElementById('btnPauseResume');
  const stopBtn = document.getElementById('btnStopRecord');

  if (badge) {
    badge.classList.remove('recording', 'paused', 'stopping');
    if (['recording', 'paused', 'stopping'].includes(state)) badge.classList.add(state);
  }

  if (state === 'preparing') {
    if (badgeText) badgeText.textContent = 'PREPARING';
    if (title) title.textContent = 'Preparing recording...';
    if (desc) desc.textContent = 'Choose your screen, then wait for the countdown to finish. Recording starts when the badge turns red.';
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) {
      stopBtn.disabled = false;
      setButtonLabel(stopBtn, 'Cancel');
    }
  } else if (state === 'recording') {
    if (badgeText) badgeText.textContent = 'RECORDING ACTIVE';
    if (title) title.textContent = 'Your screen is being recorded';
    if (desc) desc.textContent = 'Switch to the window you want to record. Come back here when you are ready to stop and save.';
    if (pauseBtn) pauseBtn.disabled = false;
    if (stopBtn) {
      stopBtn.disabled = false;
      setButtonLabel(stopBtn, 'Stop & Save Recording');
    }
  } else if (state === 'paused') {
    if (badgeText) badgeText.textContent = 'PAUSED';
    if (title) title.textContent = 'Recording paused';
    if (desc) desc.textContent = 'Resume when you are ready to continue, or stop to save what has already been captured.';
    if (pauseBtn) pauseBtn.disabled = false;
    if (stopBtn) {
      stopBtn.disabled = false;
      setButtonLabel(stopBtn, 'Stop & Save Recording');
    }
  } else if (state === 'stopping') {
    if (badgeText) badgeText.textContent = 'SAVING';
    if (title) title.textContent = 'Saving recording...';
    if (desc) desc.textContent = 'Finishing the video file. Keep this tab open until the review screen appears.';
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) {
      stopBtn.disabled = true;
      setButtonLabel(stopBtn, 'Saving...');
    }
  } else {
    if (pauseBtn) pauseBtn.disabled = false;
    if (stopBtn) {
      stopBtn.disabled = false;
      setButtonLabel(stopBtn, 'Stop & Save Recording');
    }
  }
}

function showRecordingNotification(message) {
  if (!(chrome.notifications && chrome.notifications.create)) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'wbify screen recorder',
    message
  }, () => void chrome.runtime.lastError);
}

function stopActiveRecording() {
  if (!(mediaRecorder && mediaRecorder.state !== 'inactive')) return false;
  if (liveRecordingState === 'stopping') return true;
  setLiveRecordingUi('stopping');
  try {
    if (mediaRecorder.state !== 'paused') mediaRecorder.requestData();
  } catch (e) {
    // requestData is best effort; stop() below still finalizes the recording.
  }
  mediaRecorder.stop();
  return true;
}

// Mixes any combination of system/tab audio + microphone audio into a
// single track, since MediaRecorder does not reliably record more than
// one audio track per stream.
function mixAudioTracks(streams) {
  const usable = streams.filter(s => s && s.getAudioTracks().length > 0);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].getAudioTracks()[0];

  pipAudioCtx = new AudioContext();
  // A context created without a recent user gesture starts suspended and
  // would record silence.
  pipAudioCtx.resume().catch(() => {});
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

// Opens the tab chosen in the popup directly, without Chrome's share picker.
async function getTabCaptureStream(streamId, withAudio) {
  const source = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: withAudio ? source : false,
    video: source
  });

  if (stream.getAudioTracks().length > 0) {
    tabPlaybackCtx = new AudioContext();
    tabPlaybackCtx.resume().catch(() => {});
    tabPlaybackCtx
      .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
      .connect(tabPlaybackCtx.destination);
  }
  return stream;
}

async function getDesktopCaptureStream(streamId, withAudio) {
  const source = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: withAudio ? source : false,
      video: source
    });
  } catch (err) {
    if (!withAudio) throw err;
    console.warn('Desktop audio was unavailable; retrying screen recording without system audio', err);
    showToast('System audio was not available, so recording started without it.', true);
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: source
    });
  }
}

function focusRecordedTab({ tabId, windowId }) {
  if (!(chrome.tabs && chrome.tabs.update) || isNaN(tabId)) return;
  chrome.tabs.update(tabId, { active: true }, () => {
    void chrome.runtime.lastError; // tab may have been closed already
    if (!isNaN(windowId) && chrome.windows && chrome.windows.update) {
      chrome.windows.update(windowId, { focused: true }, () => void chrome.runtime.lastError);
    }
  });
}

// Start Screen / Tab Recording
async function startRecordingFlow(isCameraOnly = false) {
  const opts = getRecordingOpts();
  let capturedTab = null;
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
      const tabCapture = pendingTabCapture;
      pendingTabCapture = null;

      if (tabCapture) {
        try {
          rawDisplayStream = await getTabCaptureStream(tabCapture.streamId, opts.sysAudio);
          capturedTab = tabCapture;
        } catch (tabErr) {
          // e.g. the id expired or the page cannot be captured: use the normal picker
          console.warn('Direct tab capture failed, falling back to the share picker', tabErr);
          rawDisplayStream = null;
        }
      }

      if (!rawDisplayStream && opts.target === 'desktop' && pendingDesktopStreamId) {
        const desktopStreamId = pendingDesktopStreamId;
        pendingDesktopStreamId = null;
        rawDisplayStream = await getDesktopCaptureStream(desktopStreamId, opts.sysAudio);
      }

      if (!rawDisplayStream) {
        // displaySurface is only a hint: it makes the picker open on the
        // matching tab (Browser Tab vs Entire Screen) chosen in the popup.
        rawDisplayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: 60,
            displaySurface: opts.target === 'tab' ? 'browser' : 'monitor'
          },
          audio: opts.sysAudio
        });
      }

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
    document.getElementById('btnPauseResume').textContent = 'Pause';

    // Only the camera is previewed live. A screen or tab capture usually contains
    // this very page, so previewing it would show the recording inside itself
    // (a repeating, zoomed-in "hall of mirrors" in the saved video).
    const videoPreview = document.getElementById('liveVideoPreview');
    const previewPlaceholder = document.getElementById('livePreviewPlaceholder');
    videoPreview.srcObject = isCameraOnly ? mediaStream : null;
    videoPreview.style.display = isCameraOnly ? 'block' : 'none';
    previewPlaceholder.style.display = isCameraOnly ? 'none' : 'flex';

    cardLauncher.style.display = 'none';
    cardReviewVideo.style.display = 'none';
    liveStudioView.style.display = 'flex';
    setLiveRecordingUi('preparing');

    const timerEl = document.getElementById('liveTimerText');
    timerEl.textContent = '00:00';

    // If user stops sharing via the browser's own share bar
    const sourceVideoTrack = isCameraOnly
      ? rawCamStream.getVideoTracks()[0]
      : rawDisplayStream.getVideoTracks()[0];
    sourceVideoTrack.onended = () => {
      stopActiveRecording();
    };

    await runCountdown(opts.countdown);

    // The share may have been stopped from Chrome's own bar during the countdown
    if (sourceVideoTrack.readyState === 'ended') {
      teardownRecordingSources();
      clearInterval(timerInterval);
      liveStudioView.style.display = 'none';
      cardLauncher.style.display = 'block';
      setLiveRecordingUi('idle');
      return;
    }

    // MediaRecorder setup: MP4 (H.264 + AAC) when this browser can record it, else WebM
    const picked = pickRecorderMimeType(true);
    if (!picked) throw new Error('This browser cannot record video.');
    recordingContainer = picked.container;

    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: picked.mimeType,
      videoBitsPerSecond: 8000000,
      audioBitsPerSecond: 128000
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      clearInterval(timerInterval);
      setLiveRecordingUi('stopping');
      teardownRecordingSources();
      liveStudioView.style.display = 'none';

      if (recordedChunks.length === 0) {
        // Nothing was captured (e.g. the share ended immediately)
        cardLauncher.style.display = 'block';
        setLiveRecordingUi('idle');
        showToast('Nothing was recorded, so no video was saved.', true);
        return;
      }

      // MediaRecorder output has no duration, which makes the video unseekable.
      // Write the real length into the file so playback, the Library and saved
      // copies all behave normally.
      const stoppedAt = Date.now();
      const openPauseMs = pauseStartedAt ? stoppedAt - pauseStartedAt : 0;
      const durationMs = stoppedAt - recordingStartedAt - pausedTotalMs - openPauseMs;
      const rawBlob = new Blob(recordedChunks, { type: recordingContainer === 'mp4' ? 'video/mp4' : 'video/webm' });
      let blob = rawBlob;
      try {
        blob = await fixVideoDuration(rawBlob, durationMs);
      } catch (err) {
        // Patching is a nicety; never let it stop the recording from being saved
        console.warn('Duration patch unavailable, saving original recording', err);
      }
      currentRecordedBlob = blob;

      const reviewEl = document.getElementById('reviewVideoEl');
      if (reviewEl.src.startsWith('blob:')) URL.revokeObjectURL(reviewEl.src);
      reviewEl.src = URL.createObjectURL(blob);

      cardReviewVideo.style.display = 'block';

      saveVideoToStorage(blob, recordingSeconds);

      const format = containerOfBlob(blob);
      currentRecordedFilename = 'screen-recording-' + Date.now() + '.' + format;
      document.getElementById('btnDownloadReviewWebm').textContent = 'Download Video (' + format.toUpperCase() + ')';
      if (format === 'webm') showToast('This browser cannot record MP4 directly, so the video was saved as WebM.', true);
      setVideoSaveStatus('');
      autoSaveRecording(blob, currentRecordedFilename);
      showRecordingNotification('Recording stopped and the video is ready to review.');
      setLiveRecordingUi('idle');
    };

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!isPaused) {
        recordingSeconds++;
        timerEl.textContent = formatTime(recordingSeconds);
      }
    }, 1000);

    recordingStartedAt = Date.now();
    pausedTotalMs = 0;
    pauseStartedAt = 0;
    mediaRecorder.start(1000);
    setRecordingIndicator('recording');
    setLiveRecordingUi('recording');
    showRecordingNotification('Recording started. Return to the Studio tab when you want to stop and save.');
    showToast('Recording started.', false);

    // The recorded tab was in front when Start was clicked; the studio tab took
    // over for the countdown, so hand focus back so the user can just carry on.
    if (capturedTab) focusRecordedTab(capturedTab);

  } catch (err) {
    console.error('Failed to start recording stream', err);
    const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
    showToast(cancelled
      ? 'Recording was not started: screen sharing was cancelled or blocked.'
      : 'Could not start recording: ' + (err && err.message ? err.message : err), true);
    teardownRecordingSources();
    setLiveRecordingUi('idle');
    cardLauncher.style.display = 'block';
    liveStudioView.style.display = 'none';
  }
}

// ---------------- Toolbar icon recording indicator ----------------
// While recording, the extension's toolbar icon shows a pulsing red dot (amber
// and steady while paused), so recording state is visible from any tab.
const REC_ICON_SIZES = [16, 32];
let recIconState = null; // 'recording' | 'paused' | null
let recIconTimer = null;
let recIconBase = null; // promise of the icon image, loaded once

function loadRecIconBase() {
  if (!recIconBase) {
    recIconBase = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = chrome.runtime.getURL('icons/icon48.png');
    });
  }
  return recIconBase;
}

function renderRecIcon(base, color, alpha) {
  const imageData = {};
  REC_ICON_SIZES.forEach((size) => {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(base, 0, 0, size, size);
    const r = size * 0.3;
    const cx = size - r;
    const cy = r;
    g.beginPath();
    g.arc(cx, cy, r + Math.max(1, size * 0.06), 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fill();
    imageData[size] = g.getImageData(0, 0, size, size);
  });
  return imageData;
}

function setToolbarIcon(details) {
  try {
    const p = chrome.action.setIcon(details);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* icon is cosmetic; never let it affect recording */ }
}

function setRecordingIndicator(state) {
  clearInterval(recIconTimer);
  recIconTimer = null;
  recIconState = state;
  if (!(chrome.action && chrome.action.setIcon)) return;

  if (!state) {
    setToolbarIcon({ path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
    if (chrome.action.setTitle) chrome.action.setTitle({ title: 'wbify screen recorder' });
    return;
  }

  if (chrome.action.setTitle) {
    chrome.action.setTitle({ title: state === 'paused' ? 'Recording paused' : 'Recording in progress' });
  }
  loadRecIconBase().then((base) => {
    if (!base || recIconState !== state) return;
    if (state === 'paused') {
      setToolbarIcon({ imageData: renderRecIcon(base, '#f59e0b', 1) });
      return;
    }
    let bright = true;
    const tick = () => {
      setToolbarIcon({ imageData: renderRecIcon(base, '#ef4444', bright ? 1 : 0.3) });
      bright = !bright;
    };
    tick();
    recIconTimer = setInterval(tick, 500);
  });
}

// If this tab is closed mid-recording, don't leave the icon stuck on "recording"
window.addEventListener('pagehide', () => {
  if (recIconState) setRecordingIndicator(null);
});

function teardownRecordingSources() {
  setRecordingIndicator(null);
  if (pipRafId) {
    cancelAnimationFrame(pipRafId);
    pipRafId = null;
  }
  if (pipAudioCtx) {
    pipAudioCtx.close().catch(() => {});
    pipAudioCtx = null;
  }
  if (tabPlaybackCtx) {
    tabPlaybackCtx.close().catch(() => {});
    tabPlaybackCtx = null;
  }
  [rawDisplayStream, rawCamStream, rawMicStream].forEach(s => {
    if (s) s.getTracks().forEach(t => t.stop());
  });
  rawDisplayStream = null;
  rawCamStream = null;
  rawMicStream = null;
}

// Closing or reloading this tab mid-recording throws the video away, so ask first.
window.addEventListener('beforeunload', (e) => {
  const recording = mediaRecorder && mediaRecorder.state !== 'inactive';
  if (recording || editAbort) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Button Listeners
document.getElementById('btnLaunchScreenRec').addEventListener('click', () => startRecordingFlow(false));
document.getElementById('btnLaunchCameraOnly').addEventListener('click', () => startRecordingFlow(true));

// Pause / Resume
document.getElementById('btnPauseResume').addEventListener('click', () => {
  if (!mediaRecorder) return;
  if (isPaused) {
    mediaRecorder.resume();
    isPaused = false;
    pausedTotalMs += Date.now() - pauseStartedAt;
    pauseStartedAt = 0;
    document.getElementById('btnPauseResume').textContent = 'Pause';
    setRecordingIndicator('recording');
    setLiveRecordingUi('recording');
  } else {
    mediaRecorder.pause();
    isPaused = true;
    pauseStartedAt = Date.now();
    document.getElementById('btnPauseResume').textContent = 'Resume';
    setRecordingIndicator('paused');
    setLiveRecordingUi('paused');
  }
});

// Stop
document.getElementById('btnStopRecord').addEventListener('click', () => {
  if (liveRecordingState === 'stopping') return;
  if (stopActiveRecording()) return;

  // Cancel while preparing/counting down, before MediaRecorder has started.
  teardownRecordingSources();
  clearInterval(timerInterval);
  setLiveRecordingUi('idle');
  liveStudioView.style.display = 'none';
  cardLauncher.style.display = 'block';
});

// Record Again
document.getElementById('btnRecordAgain').addEventListener('click', () => {
  cardReviewVideo.style.display = 'none';
  cardLauncher.style.display = 'block';
});

// Where save results are reported: the recording review card and the video editor
const REVIEW_STATUS = { statusId: 'videoSaveStatus', showBtnId: 'btnShowSavedVideo' };
const EDIT_STATUS = { statusId: 'editSaveStatus', showBtnId: 'btnShowSavedEdit' };

function setVideoSaveStatus(message, isError, downloadId, target = REVIEW_STATUS) {
  const el = document.getElementById(target.statusId);
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#b45309' : '#16a34a';
  el.style.display = message ? 'block' : 'none';

  // "Show in folder" only works for downloads made through chrome.downloads
  const btnShow = document.getElementById(target.showBtnId);
  if (btnShow) {
    if (downloadId === undefined) {
      delete btnShow.dataset.downloadId;
      btnShow.style.display = 'none';
    } else {
      btnShow.dataset.downloadId = String(downloadId);
      btnShow.style.display = 'inline-flex';
    }
  }
}

[REVIEW_STATUS, EDIT_STATUS].forEach(({ showBtnId }) => {
  document.getElementById(showBtnId).addEventListener('click', (e) => {
    const id = parseInt(e.currentTarget.dataset.downloadId, 10);
    if (!isNaN(id) && chrome.downloads && chrome.downloads.show) chrome.downloads.show(id);
  });
});

// Saves a video and reports what really happened, using the actual file path
// Chrome wrote to (not just "the download started").
async function saveRecordingAndReport(blob, filename, target = REVIEW_STATUS) {
  const report = (message, isError, downloadId) => setVideoSaveStatus(message, isError, downloadId, target);

  let result;
  try {
    result = await saveMediaFile(blob, filename);
  } catch (err) {
    console.error('Saving video failed', err);
    report('Could not save the video: ' + err.message + ' It is still in your Library.', true);
    return;
  }

  if (result.status === 'canceled') {
    report('Save canceled - the video is still in your Library. Use the download button to save it.', true);
    return;
  }

  const fallbackNote = result.fallbackReason ? ' (' + result.fallbackReason + ')' : '';

  if (result.downloadId === undefined) {
    // Written straight into the chosen folder (or anchor fallback): no download record to check
    report('Saved to ' + result.where + '.' + fallbackNote + ' A copy is also in your Library.', !!result.fallbackReason);
    return;
  }

  report('Saving...', false);
  const check = await verifyDownload(result.downloadId);
  if (check.state === 'complete') {
    report('Saved: ' + check.path + fallbackNote + ' - a copy is also in your Library.', !!result.fallbackReason, result.downloadId);
  } else if (check.state === 'interrupted') {
    report('Chrome could not finish saving the file (' + check.error + '). It is still in your Library - use the download button to retry.', true);
  } else {
    report('Still saving' + (check.path ? ' to ' + check.path : '') + ' - check your downloads if it does not appear.', false, result.downloadId);
  }
}

// Runs right after a recording (or an edited export) is ready so it reaches
// disk without the user having to remember to click Download.
async function autoSaveRecording(blob, filename, target = REVIEW_STATUS) {
  const { auto_save_video } = await getStorageValues(['auto_save_video']);
  if (auto_save_video === false) {
    setVideoSaveStatus('Auto-save is off - use the download button to save it to disk. (It is kept in your Library.)', true, undefined, target);
    return;
  }
  setVideoSaveStatus('Saving...', false, undefined, target);
  await saveRecordingAndReport(blob, filename, target);
}

// Download Video
document.getElementById('btnDownloadReviewWebm').addEventListener('click', () => {
  if (!currentRecordedBlob) return;
  saveRecordingAndReport(currentRecordedBlob, currentRecordedFilename || ('screen-recording-' + Date.now() + '.' + containerOfBlob(currentRecordedBlob)));
});

document.getElementById('btnEditRecording').addEventListener('click', () => {
  if (currentRecordedBlob) openVideoEditor(currentRecordedBlob, recordingSeconds, 'review');
});

// ---------------- Persistence: IndexedDB (videos) + chrome.storage (index) ----------------
const VIDEO_DB_NAME = 'AwesomeRecorderDB';
const VIDEO_DB_STORE = 'videos';
// Holds the FileSystemDirectoryHandle for the user's chosen save folder
// (handles can't live in chrome.storage, but IndexedDB can persist them).
const SETTINGS_DB_STORE = 'settings';
const SAVE_DIR_KEY = 'save_dir_handle';

function openVideoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VIDEO_DB_STORE)) {
        db.createObjectStore(VIDEO_DB_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_DB_STORE)) {
        db.createObjectStore(SETTINGS_DB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSavedDirHandle() {
  try {
    const db = await openVideoDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(SETTINGS_DB_STORE, 'readonly').objectStore(SETTINGS_DB_STORE).get(SAVE_DIR_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('Could not read saved folder handle', err);
    return null;
  }
}

async function setSavedDirHandle(handle) {
  const db = await openVideoDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_DB_STORE, 'readwrite');
    tx.objectStore(SETTINGS_DB_STORE).put(handle, SAVE_DIR_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
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

// Stores a video in the Library and returns its id (null on failure).
async function saveVideoToStorage(blob, duration) {
  try {
    const db = await openVideoDB();
    const id = 'vid_' + Date.now();
    const seconds = Math.round(duration || 0);
    const format = containerOfBlob(blob);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_DB_STORE, 'readwrite');
      tx.objectStore(VIDEO_DB_STORE).put({ id, blob, duration: seconds, format });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await addLibraryIndexEntry({ id, type: 'video', duration: seconds, format, createdAt: Date.now() });
    checkStorageQuotaAlert();
    return id;
  } catch (err) {
    console.error('Failed to save recording to IndexedDB', err);
    return null;
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

// Library entry holding the edited export of the current image (so repeat
// downloads update it rather than adding copies), and whether the base image
// itself was changed (cropped).
let exportedShotId = null;
let imageModified = false;

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
    exportedShotId = null;
    imageModified = false;
    canvasHistory = [JSON.stringify(shapes)];
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
      exportedShotId = null;
      imageModified = false;
      canvasHistory = [JSON.stringify(shapes)];
      redrawCanvas(true);
      switchView('screenshot');
    }
  };
  screenshotImage.src = imgSrc;
}

// History holds a snapshot of `shapes` after every change; the last entry is
// always the current state, so undo restores the one before it.
function saveCanvasState() {
  canvasHistory.push(JSON.stringify(shapes));
  if (canvasHistory.length > 30) canvasHistory.shift();
}

function syncStepCounter() {
  stepCounter = shapes.reduce((max, s) => (s.type === 'step' ? Math.max(max, s.stepNumber || 0) : max), 0) + 1;
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
  if (!shape || shape.hidden) return;
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

  renderLayersPanel();
}

// ---------------- Layers Panel ----------------
const LAYER_META = {
  rect: { icon: '▢', name: 'Box' },
  circle: { icon: '◯', name: 'Circle' },
  line: { icon: '―', name: 'Line' },
  arrow: { icon: '↗', name: 'Arrow' },
  pen: { icon: '✏', name: 'Pen' },
  highlighter: { icon: '🖌', name: 'Highlight' },
  step: { icon: '①', name: 'Step' },
  text: { icon: 'T', name: 'Text' },
  blur: { icon: '▧', name: 'Blur' },
  emoji: { icon: '✅', name: 'Sticker' }
};
const LAYERS_NO_SWATCH = ['blur', 'emoji'];

// redrawCanvas runs on every mouse-move while dragging; rebuilding the list
// only when something the list shows has changed keeps that cheap.
let layersRenderKey = null;

function getLayerLabel(shape, ordinal) {
  const meta = LAYER_META[shape.type] || { icon: '?', name: shape.type };
  if (shape.type === 'text') {
    const t = (shape.text || '').trim();
    return { icon: meta.icon, label: t ? (t.length > 18 ? t.slice(0, 18) + '…' : t) : 'Text' };
  }
  if (shape.type === 'step') return { icon: meta.icon, label: 'Step ' + (shape.stepNumber || ordinal) };
  if (shape.type === 'emoji') return { icon: shape.emojiText || meta.icon, label: 'Sticker ' + ordinal };
  return { icon: meta.icon, label: meta.name + ' ' + ordinal };
}

function selectLayer(id) {
  // Moving a shape needs the Select tool; drawing tools would start a new shape instead
  if (activeTool !== 'select') {
    document.querySelector('.tool-btn[data-tool="select"]').click();
  }
  selectedShapeId = id;
  redrawCanvas(true);
}

function toggleLayerVisibility(id) {
  const shape = shapes.find(s => s.id === id);
  if (!shape) return;
  shape.hidden = !shape.hidden;
  if (shape.hidden && selectedShapeId === id) selectedShapeId = null;
  redrawCanvas(true);
  saveCanvasState();
}

// direction +1 brings the layer forward (drawn later, on top), -1 sends it back
function moveLayer(id, direction) {
  const i = shapes.findIndex(s => s.id === id);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= shapes.length) return;
  [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  redrawCanvas(true);
  saveCanvasState();
}

function deleteLayer(id) {
  shapes = shapes.filter(s => s.id !== id);
  if (selectedShapeId === id) selectedShapeId = null;
  redrawCanvas(true);
  saveCanvasState();
}

function makeLayerButton(text, title, onClick, extraClass, disabled) {
  const btn = document.createElement('button');
  btn.className = 'layer-btn' + (extraClass ? ' ' + extraClass : '');
  btn.textContent = text;
  btn.title = title;
  btn.disabled = !!disabled;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function renderLayersPanel() {
  const list = document.getElementById('layersList');
  const count = document.getElementById('layersCount');
  if (!list || !count) return;

  const key = selectedShapeId + '|' + shapes.map(s =>
    [s.id, s.type, s.color, s.hidden ? 1 : 0, s.text, s.stepNumber, s.emojiText].join(':')
  ).join(',');
  if (key === layersRenderKey) return;
  layersRenderKey = key;

  count.textContent = shapes.length;
  list.textContent = '';

  if (shapes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'layers-empty';
    empty.textContent = 'No layers yet. Blur, arrows, text and other markup will be listed here.';
    list.appendChild(empty);
    return;
  }

  // Per-type numbering follows creation order (bottom layer = 1)
  const typeCounts = {};
  const ordinals = shapes.map(s => (typeCounts[s.type] = (typeCounts[s.type] || 0) + 1));

  let selectedRow = null;
  // Topmost layer first, like a design tool's layer stack
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    const { icon, label } = getLayerLabel(shape, ordinals[i]);

    const row = document.createElement('div');
    row.className = 'layer-row'
      + (shape.id === selectedShapeId ? ' selected' : '')
      + (shape.hidden ? ' hidden-layer' : '');
    row.addEventListener('click', () => selectLayer(shape.id));

    if (!LAYERS_NO_SWATCH.includes(shape.type)) {
      const swatch = document.createElement('span');
      swatch.className = 'layer-swatch';
      swatch.style.background = shape.color || strokeColor;
      row.appendChild(swatch);
    }

    const iconEl = document.createElement('span');
    iconEl.className = 'layer-icon';
    iconEl.textContent = icon;
    row.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'layer-name';
    nameEl.textContent = label;
    row.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'layer-actions';
    actions.appendChild(makeLayerButton(shape.hidden ? '🚫' : '👁', shape.hidden ? 'Show layer' : 'Hide layer', () => toggleLayerVisibility(shape.id)));
    actions.appendChild(makeLayerButton('↑', 'Bring forward', () => moveLayer(shape.id, 1), '', i === shapes.length - 1));
    actions.appendChild(makeLayerButton('↓', 'Send backward', () => moveLayer(shape.id, -1), '', i === 0));
    actions.appendChild(makeLayerButton('🗑', 'Delete layer', () => deleteLayer(shape.id), 'danger'));
    row.appendChild(actions);

    list.appendChild(row);
    if (shape.id === selectedShapeId) selectedRow = row;
  }

  if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
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
  if (shape.hidden) return false;
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

// Keep the crop box fully inside the image.
function clampCropRect() {
  cropRect.w = Math.min(cropRect.w, canvas.width);
  cropRect.h = Math.min(cropRect.h, canvas.height);
  cropRect.x = Math.max(0, Math.min(canvas.width - cropRect.w, cropRect.x));
  cropRect.y = Math.max(0, Math.min(canvas.height - cropRect.h, cropRect.y));
}

if (btnCropMode) btnCropMode.addEventListener('click', startCropMode);
if (btnCancelCrop) btnCancelCrop.addEventListener('click', cancelCropMode);

if (btnApplyCrop) {
  btnApplyCrop.addEventListener('click', () => {
    if (!isCropMode) return;
    clampCropRect();
    if (cropRect.w < 20 || cropRect.h < 20) return;

    const cropX = Math.round(cropRect.x);
    const cropY = Math.round(cropRect.y);
    const cropW = Math.round(cropRect.w);
    const cropH = Math.round(cropRect.h);

    // Crop only the base image. Shapes stay editable objects (shifted by the
    // crop offset below); baking them in here would draw them twice.
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    const cropCtx = cropCanvas.getContext('2d');
    if (screenshotImage && screenshotImage.naturalWidth > 0) {
      cropCtx.drawImage(screenshotImage, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    }

    const croppedImage = new Image();
    croppedImage.onload = () => {
      screenshotImage = croppedImage;
      canvas.width = cropW;
      canvas.height = cropH;

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

      // Earlier snapshots use pre-crop coordinates, so history restarts here.
      canvasHistory = [JSON.stringify(shapes)];
      imageModified = true;
      selectedShapeId = null;
      cancelCropMode();
    };
    croppedImage.src = cropCanvas.toDataURL('image/png');
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
// 'input' fires continuously while dragging inside the picker, so it only
// previews the color; the undo snapshot is taken once on 'change'.
const markupColorPicker = document.getElementById('markupColorPicker');
markupColorPicker.addEventListener('input', (e) => {
  strokeColor = e.target.value;
  if (selectedShapeId) {
    const shape = shapes.find(s => s.id === selectedShapeId);
    if (shape) {
      shape.color = strokeColor;
      redrawCanvas(true);
    }
  }
});
markupColorPicker.addEventListener('change', () => {
  if (selectedShapeId) saveCanvasState();
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
    // Only act while the editor is on screen, not from other views.
    if (getComputedStyle(editorView).display === 'none') return;
    deleteSelectedShape();
  }
});

// Undo: step back through every change (draw, move, resize, recolor, delete, clear)
document.getElementById('btnUndo').addEventListener('click', () => {
  if (canvasHistory.length > 1) {
    canvasHistory.pop();
    shapes = JSON.parse(canvasHistory[canvasHistory.length - 1]);
    selectedShapeId = null;
    syncStepCounter();
    redrawCanvas(true);
  }
});

// Clear
document.getElementById('btnClearCanvas').addEventListener('click', () => {
  if (shapes.length === 0) return;
  shapes = [];
  selectedShapeId = null;
  stepCounter = 1;
  redrawCanvas(true);
  saveCanvasState();
});

// ---------------- Download Location & Storage Quota Management ----------------
function getStorageValues(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function showToast(message, isError) {
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = 'position: fixed; bottom: 24px; right: 24px; z-index: 99999; max-width: 380px; padding: 12px 16px; border-radius: 10px; font-size: 13px; font-weight: 600; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,0.2); background: ' + (isError ? '#dc2626' : '#16a34a') + ';';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Resolves { status: 'saved' | 'canceled', downloadId } - 'canceled' means the
// user dismissed the Save As dialog. downloadId is undefined for the anchor fallback.
function downloadViaBrowser(blob, filename, promptSave) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    // Give the browser time to start reading the blob before releasing it
    const release = () => setTimeout(() => URL.revokeObjectURL(url), 60000);

    const anchorFallback = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      release();
      resolve({ status: 'saved' });
    };

    if (!(chrome.downloads && chrome.downloads.download)) {
      anchorFallback();
      return;
    }

    chrome.downloads.download({ url, filename, saveAs: promptSave }, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (!err && downloadId !== undefined) {
        release();
        resolve({ status: 'saved', downloadId });
      } else if (err && /cancel/i.test(err.message || '')) {
        URL.revokeObjectURL(url);
        resolve({ status: 'canceled' });
      } else {
        console.warn('chrome.downloads failed, falling back to anchor tag:', err);
        anchorFallback();
      }
    });
  });
}

async function writeToChosenFolder(dirHandle, blob, filename) {
  const opts = { mode: 'readwrite' };
  let perm = await dirHandle.queryPermission(opts);
  if (perm !== 'granted') perm = await dirHandle.requestPermission(opts);
  if (perm !== 'granted') throw new Error('Folder permission ' + perm);

  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// Saves a Blob / data URL according to the save-location setting.
// Resolves { status: 'saved' | 'canceled', where, fallbackReason }.
async function saveMediaFile(source, filename) {
  // Data URLs are capped at ~2 MB by chrome.downloads, so always hand it a Blob
  // (a full-page screenshot PNG is easily larger than that).
  const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
  const { save_location_mode } = await getStorageValues(['save_location_mode']);
  const mode = save_location_mode || 'prompt';
  let fallbackReason = null;

  if (mode === 'folder') {
    const dirHandle = await getSavedDirHandle();
    if (!dirHandle) {
      fallbackReason = 'No save folder is set';
    } else {
      try {
        await writeToChosenFolder(dirHandle, blob, filename);
        return { status: 'saved', where: dirHandle.name + '\\' + filename };
      } catch (err) {
        console.warn('Writing to chosen folder failed, falling back to Downloads', err);
        fallbackReason = 'Could not write to "' + dirHandle.name + '" (access may need re-approval - use the Download button to grant it again)';
      }
    }
  }

  const promptSave = mode === 'prompt';
  const { status, downloadId } = await downloadViaBrowser(blob, filename, promptSave);
  return { status, downloadId, where: promptSave ? 'the location you picked' : 'your Downloads folder', fallbackReason };
}

// Asks Chrome what actually happened to a download, so "saved" means the file
// is on disk. Resolves { state: 'complete' | 'interrupted' | 'pending', path, error }.
function verifyDownload(downloadId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!(chrome.downloads && chrome.downloads.search) || downloadId === undefined) {
      resolve({ state: 'pending' });
      return;
    }
    const startedAt = Date.now();
    const poll = () => {
      chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items && items[0];
        if (item && item.state === 'complete') {
          resolve({ state: 'complete', path: item.filename });
        } else if (item && item.state === 'interrupted') {
          resolve({ state: 'interrupted', error: item.error || 'UNKNOWN' });
        } else if (Date.now() - startedAt > timeoutMs) {
          resolve({ state: 'pending', path: item && item.filename });
        } else {
          setTimeout(poll, 300);
        }
      });
    };
    poll();
  });
}

async function downloadMediaFile(dataUrlOrBlob, filename) {
  try {
    const result = await saveMediaFile(dataUrlOrBlob, filename);
    if (result.status === 'saved') {
      showToast('Saved to ' + result.where + (result.fallbackReason ? ' (' + result.fallbackReason + ')' : ''), !!result.fallbackReason);
    }
    return result;
  } catch (err) {
    console.error('Saving file failed', err);
    showToast('Could not save the file: ' + err.message, true);
    return { status: 'failed' };
  }
}

// Stores a screenshot in the Library and returns its id. Pass an existing id to
// overwrite that entry's image instead of adding another one.
function autoStoreScreenshot(dataUrl, existingId) {
  const id = existingId || ('shot_' + Date.now());
  chrome.storage.local.set({ [id]: dataUrl, 'active_screenshot': dataUrl }, () => {
    if (chrome.runtime.lastError) {
      console.error('Failed to store screenshot', chrome.runtime.lastError.message);
      return;
    }
    if (!existingId) addLibraryIndexEntry({ id, type: 'screenshot', createdAt: Date.now() });
    checkStorageQuotaAlert();
  });
  return id;
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
          title: 'wbify screen recorder storage warning',
          message: `Storage capacity is at ${pct}% (${usedMB.toFixed(1)} MB / ${limitMB} MB used). Please clean up saved library items!`
        });
      }
    }
  });
}

// Settings Event Handlers
async function refreshChosenFolderLabel() {
  const label = document.getElementById('chosenFolderName');
  if (!label) return;
  const handle = await getSavedDirHandle();
  label.textContent = handle ? 'Current folder: ' + handle.name : 'No folder chosen';
}

const btnChooseFolder = document.getElementById('btnChooseFolder');
if (btnChooseFolder) {
  if (!window.showDirectoryPicker) {
    btnChooseFolder.disabled = true;
    btnChooseFolder.title = 'Folder picking is not supported by this browser';
  }
  btnChooseFolder.addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'awesome-recorder-save', mode: 'readwrite', startIn: 'videos' });
      await setSavedDirHandle(handle);
      const folderRadio = document.querySelector('input[name="saveLocationMode"][value="folder"]');
      if (folderRadio) folderRadio.checked = true;
      await refreshChosenFolderLabel();
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        console.error('Choosing save folder failed', err);
        showToast('Could not use that folder: ' + err.message, true);
      }
    }
  });
}

const btnSaveSettings = document.getElementById('btnSaveSettings');
if (btnSaveSettings) {
  btnSaveSettings.addEventListener('click', async () => {
    const saveLocationMode = document.querySelector('input[name="saveLocationMode"]:checked')?.value || 'prompt';
    const storageLimitMB = parseInt(document.getElementById('selectStorageLimit')?.value, 10);
    const storageNotifyEnabled = document.getElementById('chkStorageNotify')?.checked !== false;
    const autoSaveVideo = document.getElementById('chkAutoSaveVideo')?.checked !== false;

    if (saveLocationMode === 'folder' && !(await getSavedDirHandle())) {
      showToast('Click "Choose Folder…" to pick a folder first.', true);
      return;
    }

    chrome.storage.local.set({
      save_location_mode: saveLocationMode,
      storage_limit_mb: isNaN(storageLimitMB) ? 1000 : storageLimitMB,
      storage_notify_enabled: storageNotifyEnabled,
      auto_save_video: autoSaveVideo
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
  refreshChosenFolderLabel();
  chrome.storage.local.get(['save_location_mode', 'storage_limit_mb', 'storage_notify_enabled', 'auto_save_video'], (res) => {
    const chkAutoSave = document.getElementById('chkAutoSaveVideo');
    if (chkAutoSave) chkAutoSave.checked = res.auto_save_video !== false;

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
  // The original is already in the Library. Only keep the edited version, and
  // keep updating that one entry on repeat downloads instead of adding copies.
  if (shapes.length > 0 || imageModified || exportedShotId) {
    exportedShotId = autoStoreScreenshot(dataUrl, exportedShotId);
  }
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

// True once a move/resize drag actually changed a shape, so one undo
// snapshot is taken on release instead of one per mouse-move.
let shapeDragChanged = false;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const { x, y } = getCanvasCoords(e);
  dragStartX = x;
  dragStartY = y;
  shapeDragChanged = false;

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

  // 2. Select tool: pick up / move an existing shape, or deselect on empty space.
  // Other tools always draw, so a new shape can start on top of an existing one
  // and the tool stays active for the next shape.
  if (activeTool === 'select') {
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
    } else {
      selectedShapeId = null;
    }
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

// Moves the edges named by the handle, keeping the shape's direction
// (an arrow drawn right-to-left has a negative w) so the dragged handle
// always moves the edge under it.
function resizeShapeByHandle(shape, handle, dx, dy) {
  const MIN = 4;

  if (handle.includes('e') || handle.includes('w')) {
    let left = Math.min(shape.x, shape.x + shape.w);
    let right = Math.max(shape.x, shape.x + shape.w);
    if (handle.includes('w')) left = Math.min(left + dx, right - MIN);
    else right = Math.max(right + dx, left + MIN);
    const forward = shape.w >= 0;
    shape.x = forward ? left : right;
    shape.w = forward ? right - left : left - right;
  }

  if (handle.includes('n') || handle.includes('s')) {
    let top = Math.min(shape.y, shape.y + shape.h);
    let bottom = Math.max(shape.y, shape.y + shape.h);
    if (handle.includes('n')) top = Math.min(top + dy, bottom - MIN);
    else bottom = Math.max(bottom + dy, top + MIN);
    const forward = shape.h >= 0;
    shape.y = forward ? top : bottom;
    shape.h = forward ? bottom - top : top - bottom;
  }
}

window.addEventListener('mousemove', (e) => {
  const dragging = isDrawing || isDraggingShape || isResizingShape || isDraggingCrop || isResizingCrop;
  // Listening on window lets a drag continue past the canvas edge; otherwise
  // only react while the pointer is over the canvas.
  if (!dragging && e.target !== canvas) return;

  const { x, y } = getCanvasCoords(e);

  // Crop Mode Dragging / Resizing
  if (isCropMode) {
    canvas.style.cursor = 'crosshair';
    if (isResizingCrop) {
      const dx = x - dragStartX;
      const dy = y - dragStartY;
      dragStartX = x;
      dragStartY = y;
      const hd = activeCropHandle;
      const MIN = 30;
      let left = cropRect.x;
      let top = cropRect.y;
      let right = cropRect.x + cropRect.w;
      let bottom = cropRect.y + cropRect.h;
      if (hd.includes('e')) right = Math.max(left + MIN, Math.min(canvas.width, right + dx));
      if (hd.includes('w')) left = Math.min(right - MIN, Math.max(0, left + dx));
      if (hd.includes('s')) bottom = Math.max(top + MIN, Math.min(canvas.height, bottom + dy));
      if (hd.includes('n')) top = Math.min(bottom - MIN, Math.max(0, top + dy));
      cropRect = { x: left, y: top, w: right - left, h: bottom - top };
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
    if (!handleHover && activeTool === 'select') {
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
        resizeShapeByHandle(shape, h, dx, dy);

        if (shape.type === 'text') {
          // Dragging the bottom edge down or the top edge up grows the text
          const growth = h.includes('n') ? -dy : h.includes('s') ? dy : 0;
          shape.fontSize = Math.max(12, Math.min(96, (shape.fontSize || 22) + growth * 0.2));
        }
      }
      shapeDragChanged = true;
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
      shapeDragChanged = true;
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

// On window (not the canvas) so releasing the button outside the canvas still
// ends the drag instead of leaving the shape stuck to the cursor.
window.addEventListener('mouseup', () => {
  if (!(isDrawing || isDraggingShape || isResizingShape || isDraggingCrop || isResizingCrop)) return;

  if (isCropMode) {
    isDraggingCrop = false;
    isResizingCrop = false;
    activeCropHandle = null;
    return;
  }

  if ((isDraggingShape || isResizingShape) && shapeDragChanged) {
    saveCanvasState();
  }
  shapeDragChanged = false;

  if (isDrawing && currentLiveShape) {
    const isFreehand = currentLiveShape.type === 'pen' || currentLiveShape.type === 'highlighter';
    // A plain click (no real drag) must not leave an invisible zero-size shape behind
    const hasSize = isFreehand
      ? currentLiveShape.points && currentLiveShape.points.length > 1
      : Math.abs(currentLiveShape.w) >= 3 || Math.abs(currentLiveShape.h) >= 3;
    if (hasSize) {
      // The tool stays active so several shapes can be drawn in a row;
      // the new shape is left selected so its handles can be used right away.
      shapes.push(currentLiveShape);
      selectedShapeId = currentLiveShape.id;
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
  // Topmost shape first, matching what mousedown selects
  const clicked = [...shapes].reverse().find(s => hitTestShape(s, x, y));
  if (clicked) {
    if (clicked.type === 'text') {
      const updatedText = prompt('Edit text annotation:', clicked.text);
      if (updatedText !== null) {
        if (updatedText.trim() === '') {
          selectedShapeId = clicked.id;
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
  const video = previewModalContent.querySelector('video');
  if (video) {
    video.pause();
    if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  }
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
      meta.textContent = (isVideo ? `Duration: ${formatTime(item.duration || 0)} • ${(item.format || 'webm').toUpperCase()} • ` : '') + formatLibDate(item.createdAt);
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

      if (isVideo) {
        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-secondary';
        btnEdit.style.cssText = 'flex:1; justify-content:center;';
        btnEdit.textContent = '✂ Edit';
        btnEdit.addEventListener('click', () => openLibraryVideoInEditor(item));
        actions.appendChild(btnEdit);
      }

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
      const filename = 'screen-recording-' + item.id + '.' + containerOfBlob(blob);
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

// ---------------- Basic Video Editor ----------------
// Trim, speed, mute and downscale. The actual work is done by exportEditedVideo()
// in video-export.js; this section is the screen around it.
const editVideoEl = document.getElementById('editVideoEl');
const editStartRange = document.getElementById('editStartRange');
const editEndRange = document.getElementById('editEndRange');
const editStartLabel = document.getElementById('editStartLabel');
const editEndLabel = document.getElementById('editEndLabel');
const editSpeedSelect = document.getElementById('editSpeedSelect');
const editSizeSelect = document.getElementById('editSizeSelect');
const editFormatSelect = document.getElementById('editFormatSelect');
const editMuteChk = document.getElementById('editMuteChk');
const editResultLength = document.getElementById('editResultLength');
const editProgressWrap = document.getElementById('editProgressWrap');
const editProgressBar = document.getElementById('editProgressBar');
const editProgressText = document.getElementById('editProgressText');
const editResultWrap = document.getElementById('editResultWrap');
const editResultVideo = document.getElementById('editResultVideo');
const btnSetStart = document.getElementById('btnSetStart');
const btnSetEnd = document.getElementById('btnSetEnd');
const btnEditBack = document.getElementById('btnEditBack');
const btnEditPreview = document.getElementById('btnEditPreview');
const btnEditSaveResult = document.getElementById('btnEditSaveResult');
const btnEditCancel = document.getElementById('btnEditCancel');
const btnEditExport = document.getElementById('btnEditExport');

const EDIT_MIN_LENGTH = 0.1;
let editSource = null;        // { blob, duration }
let editSourceUrl = null;
let editReturnTo = 'studio';  // where "Back" goes: 'review' | 'library' | 'studio'
let editAbort = null;         // AbortController while an export is running
let editResult = null;        // { blob, filename } of the latest export
let editPreviewingRange = false;

function formatEditTime(seconds) {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function getEditRange() {
  return { start: parseFloat(editStartRange.value), end: parseFloat(editEndRange.value) };
}

function getEditSpeed() {
  return parseFloat(editSpeedSelect.value) || 1;
}

function refreshEditLabels() {
  const { start, end } = getEditRange();
  editStartLabel.textContent = formatEditTime(start);
  editEndLabel.textContent = formatEditTime(end);
  editResultLength.textContent = formatEditTime((end - start) / getEditSpeed());
}

function resetEditorUi() {
  editProgressWrap.style.display = 'none';
  editResultWrap.style.display = 'none';
  btnEditSaveResult.style.display = 'none';
  setVideoSaveStatus('', false, undefined, EDIT_STATUS);
  if (editResultVideo.src.startsWith('blob:')) URL.revokeObjectURL(editResultVideo.src);
  editResultVideo.removeAttribute('src');
  editResult = null;
  editPreviewingRange = false;
  editSpeedSelect.value = '1';
  editSizeSelect.value = '0';
  editMuteChk.checked = false;
  editVideoEl.muted = false;
  editVideoEl.playbackRate = 1;
}

async function openVideoEditor(blob, durationHint, returnTo) {
  editReturnTo = returnTo || 'studio';
  switchView('videoedit');
  resetEditorUi();

  let info;
  try {
    info = await probeVideo(blob, durationHint);
  } catch (err) {
    console.error('Could not open video for editing', err);
    showToast('Could not open this video for editing: ' + err.message, true);
    leaveVideoEditor();
    return;
  }
  if (!info.duration) {
    showToast('This video has no readable length, so it cannot be edited.', true);
    leaveVideoEditor();
    return;
  }

  editSource = { blob, duration: info.duration };
  if (editSourceUrl) URL.revokeObjectURL(editSourceUrl);
  editSourceUrl = URL.createObjectURL(blob);
  editVideoEl.src = editSourceUrl;

  const max = Math.max(EDIT_MIN_LENGTH, Math.floor(info.duration * 10) / 10);
  editStartRange.max = editEndRange.max = String(max);
  editStartRange.value = '0';
  editEndRange.value = String(max);

  // Offer only formats this browser can actually record
  const mp4Ok = (pickRecorderMimeType(true) || {}).container === 'mp4';
  editFormatSelect.querySelector('option[value="mp4"]').disabled = !mp4Ok;
  editFormatSelect.value = mp4Ok ? 'mp4' : 'webm';

  refreshEditLabels();
}

function leaveVideoEditor() {
  if (editReturnTo === 'library') {
    switchView('library');
  } else if (editReturnTo === 'review' && currentRecordedBlob) {
    switchView('studio');
    cardLauncher.style.display = 'none';
    cardReviewVideo.style.display = 'block';
  } else {
    switchView('studio');
  }
}

function openLibraryVideoInEditor(item) {
  getVideoBlob(item.id).then((blob) => {
    if (!blob) {
      alert('This recording could not be found (it may have been deleted).');
      return;
    }
    openVideoEditor(blob, item.duration, 'library');
  }).catch((err) => {
    console.error('Failed to load recording for editing', err);
    alert('Failed to load this recording.');
  });
}

// Trim sliders: keep at least EDIT_MIN_LENGTH between start and end, and show the frame being adjusted
editStartRange.addEventListener('input', () => {
  const { start, end } = getEditRange();
  if (start > end - EDIT_MIN_LENGTH) editStartRange.value = String(Math.max(0, end - EDIT_MIN_LENGTH));
  editVideoEl.currentTime = parseFloat(editStartRange.value);
  refreshEditLabels();
});

editEndRange.addEventListener('input', () => {
  const { start, end } = getEditRange();
  if (end < start + EDIT_MIN_LENGTH) editEndRange.value = String(Math.min(parseFloat(editEndRange.max), start + EDIT_MIN_LENGTH));
  editVideoEl.currentTime = parseFloat(editEndRange.value);
  refreshEditLabels();
});

btnSetStart.addEventListener('click', () => {
  const { end } = getEditRange();
  const t = Math.round(editVideoEl.currentTime * 10) / 10;
  editStartRange.value = String(Math.max(0, Math.min(t, end - EDIT_MIN_LENGTH)));
  refreshEditLabels();
});

btnSetEnd.addEventListener('click', () => {
  const { start } = getEditRange();
  const t = Math.round(editVideoEl.currentTime * 10) / 10;
  editEndRange.value = String(Math.min(parseFloat(editEndRange.max), Math.max(t, start + EDIT_MIN_LENGTH)));
  refreshEditLabels();
});

editSpeedSelect.addEventListener('change', () => {
  editVideoEl.playbackRate = getEditSpeed();
  refreshEditLabels();
});

editMuteChk.addEventListener('change', () => {
  editVideoEl.muted = editMuteChk.checked;
});

// Preview plays only the selected range, at the chosen speed and mute setting
btnEditPreview.addEventListener('click', () => {
  const { start } = getEditRange();
  editVideoEl.muted = editMuteChk.checked;
  editVideoEl.playbackRate = getEditSpeed();
  editVideoEl.currentTime = start;
  editPreviewingRange = true;
  editVideoEl.play().catch(() => { editPreviewingRange = false; });
});

editVideoEl.addEventListener('timeupdate', () => {
  if (editPreviewingRange && editVideoEl.currentTime >= getEditRange().end) {
    editVideoEl.pause();
    editPreviewingRange = false;
  }
});
editVideoEl.addEventListener('pause', () => { editPreviewingRange = false; });

btnEditBack.addEventListener('click', leaveVideoEditor);

function setExportingUi(exporting) {
  [btnEditExport, btnEditPreview, btnEditBack, btnSetStart, btnSetEnd, editStartRange, editEndRange,
    editSpeedSelect, editSizeSelect, editFormatSelect, editMuteChk].forEach((el) => { el.disabled = exporting; });
  btnEditCancel.style.display = exporting ? 'inline-flex' : 'none';
  editProgressWrap.style.display = exporting ? 'block' : 'none';
  if (exporting) {
    editProgressBar.style.width = '0%';
    editProgressText.textContent = 'Starting export...';
  }
}

let lastProgressPaint = 0;
function updateExportProgress(fraction, state) {
  const now = performance.now();
  if (now - lastProgressPaint < 200 && fraction < 1) return;
  lastProgressPaint = now;
  const pct = Math.round(fraction * 100);
  editProgressBar.style.width = pct + '%';
  editProgressText.textContent = 'Exporting... ' + pct + '%' +
    (state && state.hidden ? ' - keep this tab in front: the picture freezes while it is in the background.' : '');
}

btnEditCancel.addEventListener('click', () => {
  if (editAbort) editAbort.abort();
});

btnEditExport.addEventListener('click', async () => {
  if (!editSource || editAbort) return;
  const { start, end } = getEditRange();
  editVideoEl.pause();
  editResultWrap.style.display = 'none';
  btnEditSaveResult.style.display = 'none';
  setVideoSaveStatus('', false, undefined, EDIT_STATUS);
  setExportingUi(true);
  editAbort = new AbortController();

  try {
    const result = await exportEditedVideo(editSource.blob, {
      start,
      end,
      speed: getEditSpeed(),
      mute: editMuteChk.checked,
      targetHeight: parseInt(editSizeSelect.value, 10) || 0,
      preferMp4: editFormatSelect.value !== 'webm',
      signal: editAbort.signal,
      onProgress: updateExportProgress
    });

    const filename = 'edited-video-' + Date.now() + '.' + result.container;
    editResult = { blob: result.blob, filename };
    if (editResultVideo.src.startsWith('blob:')) URL.revokeObjectURL(editResultVideo.src);
    editResultVideo.src = URL.createObjectURL(result.blob);
    editResultWrap.style.display = 'block';
    btnEditSaveResult.textContent = 'Download edited video (' + result.container.toUpperCase() + ')';
    btnEditSaveResult.style.display = 'inline-flex';

    // Keep a copy in the Library, then write it to disk like a fresh recording
    await saveVideoToStorage(result.blob, result.durationSeconds);
    editAbort = null;
    setExportingUi(false);
    await autoSaveRecording(result.blob, filename, EDIT_STATUS);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      setVideoSaveStatus('Export cancelled.', true, undefined, EDIT_STATUS);
    } else {
      console.error('Video export failed', err);
      setVideoSaveStatus('Export failed: ' + (err && err.message ? err.message : err), true, undefined, EDIT_STATUS);
    }
  } finally {
    editAbort = null;
    setExportingUi(false);
  }
});

btnEditSaveResult.addEventListener('click', () => {
  if (editResult) saveRecordingAndReport(editResult.blob, editResult.filename, EDIT_STATUS);
});

// Initial Auto-Launch Trigger
if (initialAction === 'start_record') {
  const target = urlParams.get('target');
  startRecordingFlow(target === 'camera');
} else if (initialAction === 'edit_screenshot') {
  switchView('screenshot');
  const shotId = urlParams.get('id');
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get([shotId, 'active_screenshot'], (res) => {
      const src = res[shotId] || res['active_screenshot'];
      if (src && src.length > 50 && src !== 'data:,') {
        initCanvasWithImage(src);
      } else {
        console.warn('Screenshot missing from storage or payload invalid', shotId);
        alert('Could not display screenshot. The image may have failed to save or was too large.');
        switchView('studio');
      }
    });
  } else {
    switchView('studio');
  }
} else if (initialView) {
  switchView(['studio', 'screenshot', 'library', 'settings'].includes(initialView) ? initialView : 'studio');
} else {
  switchView('studio');
}
