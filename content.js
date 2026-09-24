// Content Script for Interactive Region Crop & In-Page Tools
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START_REGION_SELECT') {
    initRegionSelector();
    sendResponse({ status: 'selector_started' });
  } else if (msg.action === 'START_FULL_PAGE_CAPTURE') {
    initFullPageCapture();
    sendResponse({ status: 'full_page_started' });
  }
});

// Hands a finished screenshot to the background worker, which stores it and
// opens the editor. Reports failure (e.g. payload too large) instead of
// silently doing nothing.
function sendCroppedScreenshot(dataUrl, onError) {
  const fail = (message) => {
    if (onError) onError(message);
    else showPageToast('⚠️ Could not open screenshot: ' + message);
  };
  try {
    chrome.runtime.sendMessage({ action: 'OPEN_CROPPED_SCREENSHOT', dataUrl }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) fail(err.message);
      else if (response && !response.ok) fail(response.error || 'Unknown error');
    });
  } catch (e) {
    fail(e && e.message ? e.message : 'Extension was reloaded - refresh the page and try again');
  }
}

function showPageToast(msg) {
  const toast = document.createElement('div');
  toast.id = 'awesome-toast-notice';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function initRegionSelector() {
  if (document.getElementById('awesome-region-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'awesome-region-overlay';
  overlay.innerHTML = `
    <div id="awesome-region-banner">
      <span>📐 Drag handles or region to adjust (ESC to cancel)</span>
    </div>
    <div id="awesome-region-box">
      <div id="awesome-region-dim">0 × 0</div>
      <button id="awesome-region-close" title="Close (ESC)">✕</button>
      
      <!-- 8 Resizing Handles -->
      <div class="awesome-handle handle-nw" data-handle="nw"></div>
      <div class="awesome-handle handle-n" data-handle="n"></div>
      <div class="awesome-handle handle-ne" data-handle="ne"></div>
      <div class="awesome-handle handle-e" data-handle="e"></div>
      <div class="awesome-handle handle-se" data-handle="se"></div>
      <div class="awesome-handle handle-s" data-handle="s"></div>
      <div class="awesome-handle handle-sw" data-handle="sw"></div>
      <div class="awesome-handle handle-w" data-handle="w"></div>

      <!-- Docked Action Bar -->
      <div id="awesome-region-dock">
        <button class="dock-btn-blue" id="btnDockCapture" title="Capture and open in Screenshot Editor">Capture</button>
        <button class="dock-btn-sec" id="btnDockCopy" title="Copy screenshot to clipboard">Copy</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const box = document.getElementById('awesome-region-box');
  const dim = document.getElementById('awesome-region-dim');
  const dock = document.getElementById('awesome-region-dock');
  const btnClose = document.getElementById('awesome-region-close');
  const btnCap = document.getElementById('btnDockCapture');
  const btnCopy = document.getElementById('btnDockCopy');

  let isCreating = false;
  let isMoving = false;
  let isResizing = false;
  let activeHandle = null;

  let startX = 0;
  let startY = 0;

  // Initialize with a default centered selection box
  const initW = Math.min(650, Math.round(window.innerWidth * 0.7));
  const initH = Math.min(380, Math.round(window.innerHeight * 0.6));
  let rect = {
    left: Math.round((window.innerWidth - initW) / 2),
    top: Math.round((window.innerHeight - initH) / 2),
    width: initW,
    height: initH
  };
  let initialRect = { ...rect };

  function updateBoxDOM() {
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    dim.textContent = Math.round(rect.width) + ' × ' + Math.round(rect.height);
  }

  function positionDock() {
    if (rect.width < 20 || rect.height < 20) {
      dock.style.display = 'none';
      return;
    }
    dock.style.display = 'flex';
    if (window.innerWidth - (rect.left + rect.width) < 130) {
      dock.style.right = 'auto';
      dock.style.left = '8px';
      dock.style.top = '8px';
    } else {
      dock.style.left = 'auto';
      dock.style.right = '-118px';
      dock.style.top = '0px';
    }
  }

  // Show box and dock immediately
  box.style.display = 'block';
  updateBoxDOM();
  positionDock();

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.id === 'awesome-region-close') {
      cleanup();
      return;
    }
    if (e.target.closest('#awesome-region-dock')) {
      return;
    }

    e.preventDefault(); // Prevent text selection / native drag
    startX = e.clientX;
    startY = e.clientY;
    dock.style.display = 'none';

    const handleEl = e.target.closest('.awesome-handle');
    if (handleEl) {
      isResizing = true;
      activeHandle = handleEl.getAttribute('data-handle');
      initialRect = { ...rect };
      return;
    }

    const boxEl = e.target.closest('#awesome-region-box');
    if (boxEl && rect.width > 20 && rect.height > 20) {
      isMoving = true;
      initialRect = { ...rect };
      return;
    }

    // Clicked outside box on dim overlay -> start fresh selection drag
    isCreating = true;
    rect.left = startX;
    rect.top = startY;
    rect.width = 0;
    rect.height = 0;
    updateBoxDOM();
  }

  function onMouseMove(e) {
    if (!isCreating && !isMoving && !isResizing) return;
    e.preventDefault();

    const currentX = e.clientX;
    const currentY = e.clientY;
    const dx = currentX - startX;
    const dy = currentY - startY;

    if (isCreating) {
      rect.left = Math.min(startX, currentX);
      rect.top = Math.min(startY, currentY);
      rect.width = Math.abs(currentX - startX);
      rect.height = Math.abs(currentY - startY);
    } else if (isMoving) {
      rect.left = Math.max(0, Math.min(window.innerWidth - initialRect.width, initialRect.left + dx));
      rect.top = Math.max(0, Math.min(window.innerHeight - initialRect.height, initialRect.top + dy));
    } else if (isResizing && activeHandle) {
      let newLeft = initialRect.left;
      let newTop = initialRect.top;
      let newWidth = initialRect.width;
      let newHeight = initialRect.height;

      if (activeHandle.includes('w')) {
        const pWidth = initialRect.width - dx;
        if (pWidth > 20) {
          newLeft = initialRect.left + dx;
          newWidth = pWidth;
        }
      }
      if (activeHandle.includes('e')) {
        newWidth = Math.max(20, initialRect.width + dx);
      }
      if (activeHandle.includes('n')) {
        const pHeight = initialRect.height - dy;
        if (pHeight > 20) {
          newTop = initialRect.top + dy;
          newHeight = pHeight;
        }
      }
      if (activeHandle.includes('s')) {
        newHeight = Math.max(20, initialRect.height + dy);
      }

      rect.left = newLeft;
      rect.top = newTop;
      rect.width = newWidth;
      rect.height = newHeight;
    }

    updateBoxDOM();
  }

  function onMouseUp(e) {
    if (isCreating || isMoving || isResizing) {
      isCreating = false;
      isMoving = false;
      isResizing = false;
      activeHandle = null;
      positionDock();
    }
  }

  const showToast = showPageToast;

  async function processRegionCapture(openInStudio = true) {
    // The box can be dragged/resized partly off-screen; crop only the part
    // inside the viewport so the region doesn't shift.
    const vLeft = Math.max(0, rect.left);
    const vTop = Math.max(0, rect.top);
    const captureRect = {
      left: vLeft,
      top: vTop,
      width: Math.min(window.innerWidth, rect.left + rect.width) - vLeft,
      height: Math.min(window.innerHeight, rect.top + rect.height) - vTop
    };
    cleanup();

    if (captureRect.width < 15 || captureRect.height < 15) return;

    await ensurePageImagesAndFontsLoaded(document, 1200);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB_RAW' }, (response) => {
          const err = chrome.runtime.lastError;
          if (err || !response || !response.ok) {
            showToast('⚠️ Capture failed: ' + (err?.message || response?.error || 'Unable to capture tab surface'));
            return;
          }

          const img = new Image();
          img.onload = () => {
            const scale = img.width / window.innerWidth;
            const sx = Math.max(0, captureRect.left * scale);
            const sy = Math.max(0, captureRect.top * scale);
            const sw = Math.min(img.width - sx, captureRect.width * scale);
            const sh = Math.min(img.height - sy, captureRect.height * scale);

            if (sw <= 0 || sh <= 0) return;

            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = sw;
            cropCanvas.height = sh;
            const cropCtx = cropCanvas.getContext('2d');
            cropCtx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
            const croppedDataUrl = cropCanvas.toDataURL('image/png');

            if (openInStudio) {
              sendCroppedScreenshot(croppedDataUrl);
            } else {
              cropCanvas.toBlob(async (blob) => {
                try {
                  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                  showToast('✓ Screenshot copied to clipboard!');
                } catch (err) {
                  sendCroppedScreenshot(croppedDataUrl);
                }
              });
            }
          };
          img.src = response.dataUrl;
        });
      });
    });
  }

  function cleanup() {
    overlay.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKeyDown);
    if (btnClose) btnClose.removeEventListener('click', cleanup);
    if (btnCap) btnCap.removeEventListener('click', () => processRegionCapture(true));
    if (btnCopy) btnCopy.removeEventListener('click', () => processRegionCapture(false));
    overlay.remove();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanup();
  }

  btnClose.addEventListener('click', cleanup);
  btnCap.addEventListener('click', () => processRegionCapture(true));
  btnCopy.addEventListener('click', () => processRegionCapture(false));
  overlay.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
}

async function ensurePageImagesAndFontsLoaded(scope = document, maxTimeoutMs = 2500) {
  if (document.readyState === 'loading') {
    await new Promise(resolve => {
      window.addEventListener('DOMContentLoaded', resolve, { once: true });
      setTimeout(resolve, 800);
    });
  }

  if (document.fonts && document.fonts.ready) {
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise(r => setTimeout(r, 600))
      ]);
    } catch (e) {}
  }

  const images = Array.from(scope.querySelectorAll('img'));
  const pendingPromises = [];

  images.forEach(img => {
    if (img.getAttribute('loading') === 'lazy') {
      img.setAttribute('loading', 'eager');
    }

    const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazySrc && (!img.src || img.src.includes('data:image/svg') || img.src.includes('blank') || img.naturalWidth === 0)) {
      img.src = lazySrc;
    }

    const lazySrcset = img.getAttribute('data-srcset');
    if (lazySrcset && !img.srcset) {
      img.srcset = lazySrcset;
    }

    if (!img.complete || img.naturalWidth === 0) {
      pendingPromises.push(new Promise(resolve => {
        if (typeof img.decode === 'function') {
          img.decode().then(resolve).catch(() => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, maxTimeoutMs);
          });
        } else {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, maxTimeoutMs);
        }
      }));
    }
  });

  if (pendingPromises.length > 0) {
    await Promise.race([
      Promise.all(pendingPromises),
      new Promise(r => setTimeout(r, maxTimeoutMs))
    ]);
  }
}

async function initFullPageCapture() {
  if (document.getElementById('awesome-fullpage-hud')) return;

  const hud = document.createElement('div');
  hud.id = 'awesome-fullpage-hud';
  hud.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.5" class="spin"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
      <span id="awesome-fullpage-text">📸 Capturing full page (top to bottom)... 0%</span>
    </div>
  `;
  document.body.appendChild(hud);

  const textEl = document.getElementById('awesome-fullpage-text');

  const origScrollX = window.scrollX;
  const origScrollY = window.scrollY;
  const origHtmlOverflow = document.documentElement.style.overflow;
  const origBodyOverflow = document.body.style.overflow;

  // Temporarily hide scrollbars to avoid capturing scrollbar tracks in screenshots
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  // Handle position: fixed / position: sticky elements to prevent repeating headers/footers
  const fixedElements = [];
  try {
    const allEls = document.querySelectorAll('*');
    allEls.forEach(el => {
      if (el === hud || el.contains(hud)) return;
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const rect = el.getBoundingClientRect();
        fixedElements.push({
          el,
          origVisibility: el.style.visibility,
          isTopHeader: rect.top <= 120,
          isBottomFooter: rect.bottom >= (window.innerHeight - 120)
        });
      }
    });
  } catch (e) {
    console.warn('[Full Page Capture] Error detecting fixed elements', e);
  }

  function setFixedElementsVisibility(scrollTargetY, maxScrollY) {
    fixedElements.forEach(item => {
      if (scrollTargetY === 0) {
        // Top slice: show top headers, hide bottom footers if page is long
        if (item.isBottomFooter && maxScrollY > 0) {
          item.el.style.visibility = 'hidden';
        } else {
          item.el.style.visibility = item.origVisibility;
        }
      } else if (scrollTargetY >= maxScrollY) {
        // Bottom slice: hide top headers, show bottom footers
        if (item.isTopHeader) {
          item.el.style.visibility = 'hidden';
        } else {
          item.el.style.visibility = item.origVisibility;
        }
      } else {
        // Middle slices: hide both top headers and bottom footers to prevent repetition
        item.el.style.visibility = 'hidden';
      }
    });
  }

  function restoreFixedElements() {
    fixedElements.forEach(item => {
      item.el.style.visibility = item.origVisibility;
    });
  }

  const CAPTURE_QUOTA_DELAY_MS = 550;

  // Pages with `scroll-behavior: smooth` would animate a plain scrollTo and the
  // capture would fire mid-scroll, so force an immediate jump.
  function scrollToInstant(x, y) {
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  async function hideHudForCapture() {
    hud.style.visibility = 'hidden';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  function showHud() {
    hud.style.visibility = 'visible';
  }

  async function showErrorAndRemoveHud(message) {
    console.error('[Full Page Capture]', message);
    if (textEl) {
      textEl.textContent = `⚠️ ${message}`;
      await new Promise(r => setTimeout(r, 2500));
    }
    restoreFixedElements();
    document.documentElement.style.overflow = origHtmlOverflow;
    document.body.style.overflow = origBodyOverflow;
    scrollToInstant(origScrollX, origScrollY);
    hud.remove();
  }

  async function captureSliceWithRetry(maxRetries = 3) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB_RAW' }, (r) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({ ok: false, error: err.message });
              return;
            }
            resolve(r || { ok: false, error: 'No response from background worker' });
          });
        } catch (e) {
          resolve({ ok: false, error: e?.message || 'Failed to dispatch message' });
        }
      });
      if (res && res.ok && res.dataUrl) return { dataUrl: res.dataUrl };
      lastError = (res && res.error) || 'Unknown capture error';
      console.warn(`[Full Page Capture] slice attempt ${attempt + 1}/${maxRetries + 1} failed:`, lastError);
      await new Promise(r => setTimeout(r, CAPTURE_QUOTA_DELAY_MS));
    }
    return { dataUrl: null, error: lastError };
  }

  try {
    let totalH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;

    if (textEl) textEl.textContent = '📸 Pre-loading page assets & web fonts...';
    await ensurePageImagesAndFontsLoaded(document, 2000);

    if (totalH <= viewH) {
      if (textEl) textEl.textContent = '📸 Capturing full page... 100%';
      await hideHudForCapture();
      const { dataUrl, error } = await captureSliceWithRetry();
      showHud();

      // On failure the HUD must stay up so the error message is actually seen;
      // showErrorAndRemoveHud restores the page and removes it afterwards.
      if (!dataUrl) {
        await showErrorAndRemoveHud(error || 'Could not capture the page.');
        return;
      }

      restoreFixedElements();
      document.documentElement.style.overflow = origHtmlOverflow;
      document.body.style.overflow = origBodyOverflow;
      scrollToInstant(origScrollX, origScrollY);
      hud.remove();
      sendCroppedScreenshot(dataUrl);
      return;
    }

    const captures = [];
    let currentY = 0;
    let lastSliceError = null;

    while (currentY < totalH) {
      // Dynamically check totalH in case content expanded
      totalH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const maxScrollY = Math.max(0, totalH - viewH);
      const scrollTargetY = Math.min(currentY, maxScrollY);

      scrollToInstant(0, scrollTargetY);
      setFixedElementsVisibility(scrollTargetY, maxScrollY);

      const pct = Math.min(99, Math.round(((scrollTargetY + viewH) / totalH) * 100));
      if (textEl) textEl.textContent = `📸 Capturing full page (top to bottom)... ${pct}%`;

      // Wait for any newly scrolled lazy images to load & decode
      await ensurePageImagesAndFontsLoaded(document, 1000);
      await new Promise(r => setTimeout(r, CAPTURE_QUOTA_DELAY_MS));

      // Record where the page really is: it may be unable to reach the requested
      // offset, and each slice must be stitched at its true position.
      const actualScrollY = Math.round(window.scrollY);

      await hideHudForCapture();
      const { dataUrl: sliceDataUrl, error: sliceError } = await captureSliceWithRetry();
      showHud();

      if (sliceDataUrl) {
        captures.push({
          dataUrl: sliceDataUrl,
          scrollY: actualScrollY
        });
      } else {
        lastSliceError = sliceError;
      }

      if (scrollTargetY + viewH >= totalH || (scrollTargetY >= maxScrollY && currentY > 0)) break;
      currentY += viewH;
    }

    if (textEl) textEl.textContent = '⚡ Stitching high-res screenshot...';

    // Page height as it was laid out during capture (scrollbars hidden); measuring
    // after restoring overflow could reflow the page and change it.
    const finalTotalH = totalH;

    // Restore page state before image stitching canvas operations
    restoreFixedElements();
    document.documentElement.style.overflow = origHtmlOverflow;
    document.body.style.overflow = origBodyOverflow;
    scrollToInstant(origScrollX, origScrollY);

    const images = await Promise.all(captures.map(c => new Promise(res => {
      const img = new Image();
      img.onload = () => res({ img, scrollY: c.scrollY });
      img.onerror = () => res(null);
      img.src = c.dataUrl;
    })));

    const validImages = images.filter(Boolean);
    if (validImages.length === 0) {
      await showErrorAndRemoveHud(lastSliceError || 'Could not capture any part of the page.');
      return;
    }

    // srcScale: screenshot pixels per CSS pixel (the device pixel ratio).
    // destScale: same ratio for the output, reduced when the page is so tall/wide
    // that the canvas would exceed browser limits.
    const firstImg = validImages[0].img;
    const srcScale = firstImg.width / viewW;
    let destScale = srcScale;

    const MAX_CANVAS_DIM = 16384;
    if (finalTotalH * destScale > MAX_CANVAS_DIM) {
      destScale = MAX_CANVAS_DIM / finalTotalH;
    }
    if (viewW * destScale > MAX_CANVAS_DIM) {
      destScale = Math.min(destScale, MAX_CANVAS_DIM / viewW);
    }

    const masterCanvas = document.createElement('canvas');
    masterCanvas.width = Math.max(1, Math.round(viewW * destScale));
    masterCanvas.height = Math.max(1, Math.round(finalTotalH * destScale));
    const ctx = masterCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, masterCanvas.width, masterCanvas.height);

    // Place every slice at the scroll offset it was captured at. Overlapping
    // areas show identical content, so later slices simply paint over earlier
    // ones, and a slice that failed to capture leaves a blank gap rather than
    // shifting everything after it.
    validImages.forEach(({ img, scrollY }) => {
      const destY = Math.round(scrollY * destScale);
      const destH = Math.round((img.height / srcScale) * destScale) + 1; // +1px avoids rounding seams
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, destY, masterCanvas.width, destH);
    });

    // Runtime messages are capped at 64 MB, so fall back to progressively
    // smaller JPEGs if the PNG is too big to hand to the background worker.
    function exportCanvasDataUrl(cnv) {
      const MAX_PAYLOAD_CHARS = 48 * 1024 * 1024;
      const attempts = [['image/png'], ['image/jpeg', 0.9], ['image/jpeg', 0.7]];
      for (const [type, quality] of attempts) {
        try {
          const u = cnv.toDataURL(type, quality);
          if (u && u.length > 100 && u !== 'data:,' && u.length <= MAX_PAYLOAD_CHARS) return u;
        } catch (e) {
          console.warn(type + ' export failed, trying next format', e);
        }
      }
      return null;
    }

    const fullPageDataUrl = exportCanvasDataUrl(masterCanvas);

    if (!fullPageDataUrl) {
      await showErrorAndRemoveHud('Failed to process image payload (page may be too large).');
      return;
    }

    hud.remove();
    sendCroppedScreenshot(fullPageDataUrl);
  } catch (err) {
    await showErrorAndRemoveHud(err && err.message ? err.message : String(err));
  }
}
