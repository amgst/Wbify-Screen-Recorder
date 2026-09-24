// Recording-format helpers and the basic video editor's export engine.
// Uses only web APIs (no chrome.* calls) so it can be tested in a plain page.
//
// Editing works by playing the source video through a canvas + WebAudio graph
// and re-recording it with MediaRecorder: that lets us trim, change speed,
// mute and downscale without shipping a video-processing library. The cost is
// that an export runs in real time (a 60 s clip at 2x speed takes ~30 s).

// Preferred first: MP4 (H.264 + AAC) plays everywhere. WebM is the fallback for
// browsers whose MediaRecorder cannot write MP4.
const RECORDER_MIME_CANDIDATES = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', container: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', container: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', container: 'mp4' },
  { mimeType: 'video/mp4', container: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', container: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', container: 'webm' },
  { mimeType: 'video/webm', container: 'webm' }
];

// Returns { mimeType, container } for the best format this browser can record.
function pickRecorderMimeType(preferMp4 = true) {
  const supported = RECORDER_MIME_CANDIDATES.filter(c => MediaRecorder.isTypeSupported(c.mimeType));
  const wanted = preferMp4 ? supported : supported.filter(c => c.container === 'webm');
  return wanted[0] || supported[0] || null;
}

function containerOfBlob(blob) {
  return blob && /mp4/i.test(blob.type) ? 'mp4' : 'webm';
}

// Writes the real duration into a finished recording (MediaRecorder leaves it
// blank in both formats, which breaks seeking / shows 0:00 in many players).
async function fixVideoDuration(blob, durationMs) {
  if (containerOfBlob(blob) === 'mp4') {
    return typeof fixMp4Duration === 'function' ? fixMp4Duration(blob, durationMs) : blob;
  }
  return typeof fixWebmDuration === 'function' ? fixWebmDuration(blob, durationMs) : blob;
}

function waitForEvent(target, eventName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.removeEventListener(eventName, onEvent);
      reject(new Error('Timed out waiting for video "' + eventName + '"'));
    }, timeoutMs);
    const onEvent = () => {
      clearTimeout(timer);
      resolve();
    };
    target.addEventListener(eventName, onEvent, { once: true });
  });
}

function loadVideoElement(blob) {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  // Attached but invisible: some browsers throttle detached media elements
  video.style.cssText = 'position:fixed; left:-9999px; top:0; width:2px; height:2px; opacity:0; pointer-events:none;';
  const url = URL.createObjectURL(blob);
  video.src = url;
  document.body.appendChild(video);
  const dispose = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
  const ready = new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('This video could not be loaded for editing.')), { once: true });
  });
  return { video, ready, dispose };
}

// Reads length and size of a video. Some recordings report an infinite/unknown
// duration until the end has been reached, so seek there once to force it.
async function probeVideo(blob, hintSeconds = 0) {
  const { video, ready, dispose } = loadVideoElement(blob);
  try {
    await ready;
    let duration = video.duration;
    if (!isFinite(duration)) {
      video.currentTime = 1e9;
      await Promise.race([
        waitForEvent(video, 'seeked', 5000).catch(() => {}),
        waitForEvent(video, 'durationchange', 5000).catch(() => {})
      ]);
      duration = video.duration;
    }
    if (!isFinite(duration) || duration <= 0) duration = hintSeconds || 0;
    return { duration, width: video.videoWidth, height: video.videoHeight };
  } finally {
    dispose();
  }
}

/**
 * Re-records `blob` with the given edits.
 * options: {
 *   start, end        seconds to keep (defaults: whole video)
 *   speed             playback speed multiplier, e.g. 0.5 - 2 (default 1)
 *   mute              drop the audio track
 *   targetHeight      downscale to this height in px (0 / larger than source = keep original)
 *   preferMp4         prefer MP4 output (default true)
 *   onProgress(f, s)  f = 0..1; s.hidden = true when the tab is in the background
 *   signal            AbortSignal to cancel
 * }
 * Resolves { blob, container, durationSeconds }; rejects with AbortError on cancel.
 */
async function exportEditedVideo(blob, options = {}) {
  const speed = options.speed > 0 ? options.speed : 1;
  const onProgress = options.onProgress || (() => {});
  const picked = pickRecorderMimeType(options.preferMp4 !== false);
  if (!picked) throw new Error('This browser cannot record video.');

  const { video, ready, dispose } = loadVideoElement(blob);
  let audioCtx = null;
  let recorder = null;
  let drawTimer = null;
  let canvasTrack = null;

  const cleanup = () => {
    clearInterval(drawTimer);
    if (canvasTrack) canvasTrack.stop();
    if (audioCtx) audioCtx.close().catch(() => {});
    dispose();
  };

  try {
    await ready;

    let sourceDuration = video.duration;
    if (!isFinite(sourceDuration)) {
      sourceDuration = (await probeVideo(blob, options.end || 0)).duration;
    }
    const start = Math.max(0, options.start || 0);
    const end = Math.min(sourceDuration || Infinity, options.end > 0 ? options.end : (sourceDuration || Infinity));
    if (!isFinite(end) || end - start < 0.1) throw new Error('The selected range is too short to export.');

    // Output size (H.264 needs even dimensions)
    let width = video.videoWidth || 1280;
    let height = video.videoHeight || 720;
    if (options.targetHeight > 0 && options.targetHeight < height) {
      width = Math.round(width * options.targetHeight / height);
      height = options.targetHeight;
    }
    width = Math.max(2, width - (width % 2));
    height = Math.max(2, height - (height % 2));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    const FPS = 30;
    const canvasStream = canvas.captureStream(FPS);
    canvasTrack = canvasStream.getVideoTracks()[0];
    const tracks = [canvasTrack];

    // Route the video's sound into the recording (not the speakers) via WebAudio
    if (!options.mute) {
      audioCtx = new AudioContext();
      await audioCtx.resume();
      const source = audioCtx.createMediaElementSource(video);
      const destination = audioCtx.createMediaStreamDestination();
      source.connect(destination);
      tracks.push(...destination.stream.getAudioTracks());
    }

    recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType: picked.mimeType,
      videoBitsPerSecond: Math.max(1500000, Math.round(width * height * FPS * 0.12)),
      audioBitsPerSecond: 128000
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    // Seek to the trim start and paint that frame before recording begins
    video.currentTime = start;
    await waitForEvent(video, 'seeked');
    ctx.drawImage(video, 0, 0, width, height);

    const finished = new Promise((resolve, reject) => {
      let recordStartedAt = 0;
      let stopping = false;
      let aborted = false;

      const finish = () => {
        if (stopping) return;
        stopping = true;
        video.pause();
        if (recorder.state !== 'inactive') recorder.stop();
      };

      recorder.onstop = () => {
        if (aborted) {
          reject(new DOMException('Export cancelled', 'AbortError'));
          return;
        }
        resolve(performance.now() - recordStartedAt);
      };
      recorder.onerror = (e) => reject(e.error || new Error('Recording failed during export.'));

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          finish();
        }, { once: true });
      }

      const checkProgress = (mediaTime) => {
        const t = mediaTime !== undefined ? mediaTime : video.currentTime;
        onProgress(Math.min(1, Math.max(0, (t - start) / (end - start))), { hidden: document.hidden });
        if (t >= end - 0.02 || video.ended) finish();
      };

      const drawAndCheck = (now, metadata) => {
        ctx.drawImage(video, 0, 0, width, height);
        checkProgress(metadata && metadata.mediaTime);
      };
      const frameLoop = (now, metadata) => {
        if (stopping) return;
        drawAndCheck(now, metadata);
        video.requestVideoFrameCallback(frameLoop);
      };

      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(frameLoop);
      // Backup for browsers/tabs where frame callbacks are throttled or missing
      drawTimer = setInterval(() => { if (!stopping) drawAndCheck(); }, 1000 / FPS);
      video.addEventListener('ended', finish, { once: true });

      recorder.start(1000);
      recordStartedAt = performance.now();
      video.playbackRate = speed;
      video.play().catch(reject);
    });

    const elapsedMs = await finished;
    const container = picked.container;
    const raw = new Blob(chunks, { type: container === 'mp4' ? 'video/mp4' : 'video/webm' });
    if (raw.size === 0) throw new Error('Nothing was recorded during export.');
    const result = await fixVideoDuration(raw, elapsedMs);
    return { blob: result, container, durationSeconds: elapsedMs / 1000 };
  } finally {
    cleanup();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pickRecorderMimeType, containerOfBlob, exportEditedVideo, probeVideo };
}
