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

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.id = 'awesome-toast-notice';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  }

  function processRegionCapture(openInStudio = true) {
    const captureRect = { ...rect };
    cleanup();

    if (captureRect.width < 15 || captureRect.height < 15) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB_RAW' }, (response) => {
          if (chrome.runtime.lastError || !response || !response.ok) return;

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
              chrome.runtime.sendMessage({
                action: 'OPEN_CROPPED_SCREENSHOT',
                dataUrl: croppedDataUrl
              });
            } else {
              cropCanvas.toBlob(async (blob) => {
                try {
                  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                  showToast('✓ Screenshot copied to clipboard!');
                } catch (err) {
                  chrome.runtime.sendMessage({
                    action: 'OPEN_CROPPED_SCREENSHOT',
                    dataUrl: croppedDataUrl
                  });
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

  const totalH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const viewH = window.innerHeight;
  const viewW = window.innerWidth;

  if (totalH <= viewH) {
    if (textEl) textEl.textContent = '📸 Capturing full page... 100%';
    chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB_RAW' }, (res) => {
      hud.remove();
      if (res && res.dataUrl) {
        chrome.runtime.sendMessage({ action: 'OPEN_CROPPED_SCREENSHOT', dataUrl: res.dataUrl });
      }
    });
    return;
  }

  const captures = [];
  let currentY = 0;

  while (currentY < totalH) {
    const scrollTargetY = Math.min(currentY, totalH - viewH);
    window.scrollTo(0, scrollTargetY);

    const pct = Math.min(99, Math.round(((scrollTargetY + viewH) / totalH) * 100));
    if (textEl) textEl.textContent = `📸 Capturing full page (top to bottom)... ${pct}%`;

    await new Promise(r => setTimeout(r, 220));

    const sliceRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB_RAW' }, (res) => {
        resolve(res && res.ok ? res.dataUrl : null);
      });
    });

    if (sliceRes) {
      captures.push({
        dataUrl: sliceRes,
        destY: scrollTargetY
      });
    }

    if (scrollTargetY + viewH >= totalH) break;
    currentY += viewH;
  }

  if (textEl) textEl.textContent = '⚡ Stitching high-res screenshot...';

  window.scrollTo(origScrollX, origScrollY);

  try {
    const images = await Promise.all(captures.map(c => new Promise(res => {
      const img = new Image();
      img.onload = () => res({ img, destY: c.destY });
      img.onerror = () => res(null);
      img.src = c.dataUrl;
    })));

    const validImages = images.filter(Boolean);
    if (validImages.length === 0) {
      hud.remove();
      return;
    }

    const firstImg = validImages[0].img;
    const scale = firstImg.width / viewW;

    const masterCanvas = document.createElement('canvas');
    masterCanvas.width = Math.round(viewW * scale);
    masterCanvas.height = Math.round(totalH * scale);
    const ctx = masterCanvas.getContext('2d');

    validImages.forEach(({ img, destY }) => {
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, Math.round(destY * scale), img.width, img.height);
    });

    const fullPageDataUrl = masterCanvas.toDataURL('image/png');
    hud.remove();

    chrome.runtime.sendMessage({
      action: 'OPEN_CROPPED_SCREENSHOT',
      dataUrl: fullPageDataUrl
    });
  } catch (err) {
    console.error('Full page capture error:', err);
    hud.remove();
  }
}
