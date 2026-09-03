// Content Script for Interactive Region Crop & In-Page Tools
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START_REGION_SELECT') {
    initRegionSelector();
    sendResponse({ status: 'selector_started' });
  }
});

function initRegionSelector() {
  if (document.getElementById('awesome-region-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'awesome-region-overlay';
  overlay.innerHTML = `
    <div id="awesome-region-banner">
      <span>📐 Click & drag to select region to capture (ESC to cancel)</span>
    </div>
    <div id="awesome-region-box">
      <div id="awesome-region-dim">0 × 0 px</div>
    </div>
  `;
  document.body.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let isDragging = false;
  const box = document.getElementById('awesome-region-box');
  const dim = document.getElementById('awesome-region-dim');

  function onMouseDown(e) {
    if (e.target.id === 'awesome-region-banner') return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.display = 'block';
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0px';
    box.style.height = '0px';
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = width + 'px';
    box.style.height = height + 'px';
    dim.textContent = Math.round(width) + ' × ' + Math.round(height) + ' px';
  }

  function cleanup() {
    overlay.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') cleanup();
  }

  function onMouseUp(e) {
    if (!isDragging) return;
    isDragging = false;
    const rect = box.getBoundingClientRect();
    cleanup();

    if (rect.width > 15 && rect.height > 15) {
      // Capture the visible tab and crop to the selected coordinates
      chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' }, () => {
        // Handled via studio
      });
    }
  }

  overlay.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('keydown', onKeyDown);
}
