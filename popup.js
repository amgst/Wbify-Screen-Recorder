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

// Tabs that were already open before the extension was installed/reloaded never got
// content.js injected, so a plain sendMessage to them fails silently. Inject it on
// demand and retry instead of falling back to a blank Studio editor.
function sendToContentScript(tabId, message, callback) {
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (!chrome.runtime.lastError) {
      callback(response);
      return;
    }
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
      if (chrome.runtime.lastError) {
        callback(null);
        return;
      }
      chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }, () => {
        chrome.tabs.sendMessage(tabId, message, (response2) => {
          callback(chrome.runtime.lastError ? null : response2);
        });
      });
    });
  });
}

// 1. Start Recording Button
document.getElementById('btnStartRecording').addEventListener('click', () => {
  const mic = document.getElementById('micToggle').checked;
  const webcam = document.getElementById('camToggle').checked;
  const sysAudio = document.getElementById('sysAudioToggle').checked;
  const countdown = document.getElementById('countdownSelect').value;

  const payload = {
    action: 'START_RECORDING',
    target: currentTarget,
    mic,
    webcam,
    sysAudio,
    countdown
  };

  const start = () => {
    chrome.runtime.sendMessage(payload, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  };

  if (currentTarget === 'desktop' && chrome.desktopCapture) {
    const sources = sysAudio ? ['screen', 'audio'] : ['screen'];
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        void chrome.runtime.lastError;
        showNotice('Screen sharing was cancelled.');
        return;
      }
      payload.desktopStreamId = streamId;
      start();
    });
    return;
  }

  if (currentTarget !== 'tab') {
    start();
    return;
  }

  // "Browser Tab": capture the tab that is open right now directly, so Chrome's
  // share picker does not have to ask again. The stream id must be requested
  // here, while the popup's click still grants access to this tab. Anything that
  // goes wrong just falls back to the normal picker.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || isRestrictedPageUrl(tab.url) || !chrome.tabCapture) {
      start();
      return;
    }
    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        void chrome.runtime.lastError;
      } else {
        payload.streamId = streamId;
        payload.tabId = tab.id;
        payload.windowId = tab.windowId;
      }
      start();
    });
  });
});

function isRestrictedPageUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('view-source:') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('chrome.google.com/webstore')
  );
}

// 1. Full Page Capture (Top to Bottom - Auto Scroll)
document.getElementById('btnCaptureFullPage').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      if (isRestrictedPageUrl(tabs[0].url)) {
        showNotice('Cannot capture restricted web store or system pages. Opening Studio instead...');
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
          window.close();
        }, 1200);
        return;
      }
      sendToContentScript(tabs[0].id, { action: 'START_FULL_PAGE_CAPTURE' }, (response) => {
        if (!response) {
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
      if (isRestrictedPageUrl(tabs[0].url)) {
        showNotice('Cannot crop inside restricted web store or system pages. Opening Studio instead...');
        setTimeout(() => {
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
          window.close();
        }, 1200);
        return;
      }
      sendToContentScript(tabs[0].id, { action: 'START_REGION_SELECT' }, (response) => {
        if (!response) {
          // Injection also failed (e.g. a restricted page) - fall back to Studio
          chrome.runtime.sendMessage({ action: 'OPEN_STUDIO', view: 'screenshot' });
        }
        window.close();
      });
    }
  });
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
