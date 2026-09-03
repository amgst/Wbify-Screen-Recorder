// Background Service Worker for Awesome Screen Recorder Pro
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "capture_visible",
    title: "Capture Visible Screenshot",
    contexts: ["page", "selection", "image", "link"]
  });
  chrome.contextMenus.create({
    id: "open_studio",
    title: "Open Screen Recorder Studio",
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
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?' + params.toString()) });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'OPEN_STUDIO') {
    const params = new URLSearchParams({
      view: request.view || 'studio'
    });
    if (request.directCapture) params.append('directCapture', '1');
    chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?' + params.toString()) });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'OPEN_CROPPED_SCREENSHOT') {
    const id = 'shot_' + Date.now();
    chrome.storage.local.set({ [id]: request.dataUrl, 'active_screenshot': request.dataUrl }, () => {
      addLibraryIndexEntry({ id, type: 'screenshot', createdAt: Date.now() });
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?action=edit_screenshot&id=' + id) });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'CAPTURE_VISIBLE_TAB_RAW') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = (tabs && tabs[0]) ? tabs[0] : null;
      const windowId = activeTab ? activeTab.windowId : undefined;

      const handleResult = (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message });
          return;
        }
        sendResponse({ ok: true, dataUrl });
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
    return true;
  }
});
