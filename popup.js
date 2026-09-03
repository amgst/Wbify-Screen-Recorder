let currentTarget = 'desktop';

// Tab switching
const tabRecord = document.getElementById('tabRecord');
const tabScreenshot = document.getElementById('tabScreenshot');
const tabLibrary = document.getElementById('tabLibrary');
const panelRecord = document.getElementById('panelRecord');
const panelScreenshot = document.getElementById('panelScreenshot');
const panelLibrary = document.getElementById('panelLibrary');

function setTab(tab) {
  [tabRecord, tabScreenshot, tabLibrary].forEach(b => b.classList.remove('active'));
  [panelRecord, panelScreenshot, panelLibrary].forEach(p => p.style.display = 'none');
  
  if (tab === 'record') {
    tabRecord.classList.add('active');
    panelRecord.style.display = 'block';
  } else if (tab === 'screenshot') {
    tabScreenshot.classList.add('active');
    panelScreenshot.style.display = 'block';
  } else {
    tabLibrary.classList.add('active');
    panelLibrary.style.display = 'block';
  }
}

tabRecord.addEventListener('click', () => setTab('record'));
tabScreenshot.addEventListener('click', () => setTab('screenshot'));
tabLibrary.addEventListener('click', () => setTab('library'));

// Target Selection
document.querySelectorAll('.target-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.target-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    currentTarget = card.dataset.target;
  });
});

// Notice display
function showNotice(msg) {
  const n = document.getElementById('noticeMsg');
  n.textContent = msg;
  n.style.display = 'block';
}

// 1. Start Recording Button
document.getElementById('btnStartRecording').addEventListener('click', () => {
  const mic = document.getElementById('micToggle').checked;
  const webcam = document.getElementById('camToggle').checked;
  const sysAudio = document.getElementById('sysAudioToggle').checked;
  const countdown = document.getElementById('countdownSelect').value;

  chrome.runtime.sendMessage({
    action: 'START_RECORDING',
    target: currentTarget,
    mic,
    webcam,
    sysAudio,
    countdown
  });

  window.close();
});

// 1. Full Page Capture (Top to Bottom - Auto Scroll)
document.getElementById('btnCaptureFullPage').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      if (tabs[0].url && (tabs[0].url.startsWith('chrome://') || tabs[0].url.startsWith('edge://') || tabs[0].url.startsWith('about:'))) {
        showNotice('Cannot capture browser system pages. Opening Studio instead...');
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
          window.close();
        }, 1200);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'START_FULL_PAGE_CAPTURE' }, (response) => {
        if (chrome.runtime.lastError) {
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
        }
        window.close();
      });
    }
  });
});

// 2. Screenshot: Visible Part
document.getElementById('btnCaptureVisible').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' });
  window.close();
});

// 3. Screenshot: Selected Area (Crop)
document.getElementById('btnCaptureSelected').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      if (tabs[0].url && (tabs[0].url.startsWith('chrome://') || tabs[0].url.startsWith('edge://') || tabs[0].url.startsWith('about:'))) {
        showNotice('Cannot crop inside browser system pages. Opening Studio instead...');
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
          window.close();
        }, 1200);
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'START_REGION_SELECT' }, (response) => {
        if (chrome.runtime.lastError) {
          // If content script was not injected on an old tab, open studio
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
        }
        window.close();
      });
    }
  });
});

// 4. Screenshot: Entire Screen Snapshot
document.getElementById('btnCaptureEntireScreen').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot', directCapture: true });
  window.close();
});

// Open Studio & Library links
const openStudio = () => {
  chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'studio' });
  window.close();
};

const openLibrary = () => {
  chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'library' });
  window.close();
};

document.getElementById('btnOpenStudio').addEventListener('click', openStudio);
document.getElementById('btnFooterStudio').addEventListener('click', openStudio);
document.getElementById('btnLaunchLibrary').addEventListener('click', openLibrary);
document.getElementById('btnFooterLibrary').addEventListener('click', openLibrary);
