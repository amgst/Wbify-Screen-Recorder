// Background Service Worker for wbify screen recorder
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "capture_visible",
    title: "Capture Visible Screenshot",
    contexts: ["page", "selection", "image", "link"]
  });
  chrome.contextMenus.create({
    id: "open_studio",
    title: "Open wbify screen recorder Studio",
    contexts: ["action", "page"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "capture_visible") {
    captureVisibleTab();
  } else if (info.menuItemId === "open_studio") {
    openStudio();
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-screenshot") {
    captureVisibleTab();
  }
});

function addLibraryIndexEntry(entry) {
  chrome.storage.local.get(['library_index'], (res) => {
    const list = res.library_index || [];
    list.unshift(entry);
    chrome.storage.local.set({ library_index: list });
  });
}

function captureVisibleTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = (tabs && tabs[0]) ? tabs[0] : null;
    const windowId = activeTab ? activeTab.windowId : undefined;
    
    const handleResult = (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        console.warn('captureVisibleTab warning:', chrome.runtime.lastError);
        openStudio('screenshot');
        return;
      }
      const id = 'shot_' + Date.now();
      chrome.storage.local.set({ [id]: dataUrl, 'active_screenshot': dataUrl }, () => {
        if (chrome.runtime.lastError) {
          // Nothing was stored, so don't add a Library entry that points at nothing
          console.error('[Background] Failed to store screenshot:', chrome.runtime.lastError.message);
          openStudio('screenshot');
          return;
        }
        addLibraryIndexEntry({ id, type: 'screenshot', createdAt: Date.now() });
        chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?action=edit_screenshot&id=' + id) });
      });
    };

    try {
      if (windowId !== undefined && windowId !== null) {
        chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, handleResult);
      } else {
        chrome.tabs.captureVisibleTab({ format: 'png' }, handleResult);
      }
    } catch (e) {
      chrome.tabs.captureVisibleTab({ format: 'png' }, handleResult);
    }
  });
}

function openStudio(view = 'studio', extraParams = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`studio.html?view=${view}${extraParams}`) });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'CAPTURE_VISIBLE_TAB') {
    captureVisibleTab();
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'START_RECORDING') {
    const params = new URLSearchParams({
      action: 'start_record',
      target: request.target || 'desktop',
      mic: request.mic ? '1' : '0',
      webcam: request.webcam ? '1' : '0',
      sysAudio: request.sysAudio ? '1' : '0',
      countdown: request.countdown || '3'
    });
    // Present only when the popup already obtained a direct capture id, so
    // Studio can use the approved source without opening another picker.
    if (request.streamId) {
      params.set('streamId', request.streamId);
      params.set('tabId', String(request.tabId));
      params.set('windowId', String(request.windowId));
    }
    if (request.desktopStreamId) {
      params.set('desktopStreamId', request.desktopStreamId);
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?' + params.toString()) });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'OPEN_STUDIO') {
    const params = new URLSearchParams({
      view: request.view || 'studio'
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?' + params.toString()) });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'OPEN_CROPPED_SCREENSHOT') {
    const id = 'shot_' + Date.now();
    const dataUrl = request.dataUrl;
    if (!dataUrl || dataUrl.length < 50 || dataUrl === 'data:,') {
      console.error('[Background] OPEN_CROPPED_SCREENSHOT received empty/invalid dataUrl');
      sendResponse({ ok: false, error: 'Invalid dataUrl' });
      return true;
    }
    // Reply only once the write finished so the content script can report failures
    chrome.storage.local.set({ [id]: dataUrl, 'active_screenshot': dataUrl }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[Background] chrome.storage.local.set error:', err);
        sendResponse({ ok: false, error: err.message });
        return;
      }
      addLibraryIndexEntry({ id, type: 'screenshot', createdAt: Date.now() });
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?action=edit_screenshot&id=' + id) });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === 'CAPTURE_VISIBLE_TAB_RAW') {
    let responded = false;
    const safeSendResponse = (data) => {
      if (!responded) {
        responded = true;
        try { sendResponse(data); } catch (e) {}
      }
    };

    const targetWindowId = sender.tab ? sender.tab.windowId : undefined;

    const performCapture = (winId) => {
      const handleResult = (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err || !dataUrl) {
          safeSendResponse({ ok: false, error: err?.message || 'Capture returned empty data' });
        } else {
          safeSendResponse({ ok: true, dataUrl });
        }
      };

      try {
        if (winId !== undefined && winId !== null) {
          chrome.tabs.captureVisibleTab(winId, { format: 'png' }, handleResult);
        } else {
          chrome.tabs.captureVisibleTab({ format: 'png' }, handleResult);
        }
      } catch (e1) {
        try {
          chrome.tabs.captureVisibleTab({ format: 'png' }, handleResult);
        } catch (e2) {
          safeSendResponse({ ok: false, error: e2?.message || e1?.message || 'Failed to capture tab surface' });
        }
      }
    };

    if (targetWindowId !== undefined && targetWindowId !== null) {
      performCapture(targetWindowId);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = (tabs && tabs[0]) ? tabs[0] : null;
        const windowId = activeTab ? activeTab.windowId : undefined;
        performCapture(windowId);
      });
    }

    return true;
  }
});
