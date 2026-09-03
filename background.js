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

function captureVisibleTab() {
  chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
    if (chrome.runtime.lastError || !dataUrl) {
      openStudio('screenshot');
      return;
    }
    const id = 'shot_' + Date.now();
    chrome.storage.local.set({ [id]: dataUrl, 'active_screenshot': dataUrl }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?action=edit_screenshot&id=' + id) });
    });
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
      chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?action=edit_screenshot&id=' + id) });
    });
    sendResponse({ ok: true });
    return true;
  }
});
