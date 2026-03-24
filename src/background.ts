/// <reference types="chrome" />

const TARGET_URL = /^https?:\/\/boards\.4chan\.org\/[^\/]+\/thread\/[^\/]+.*$/;

/^https?:\/\/boards\.4chan\.org\/[^\/]+\/thread\/[^\/]+.*$/

function isTargetUrl(url?: string): boolean {
  return typeof url === "string" && TARGET_URL.test(url);
}

async function updatePageActionForTab(tabId: number, url?: string): Promise<void> {
  if (isTargetUrl(url)) {
    await chrome.pageAction.show(tabId);
  } else {
    await chrome.pageAction.hide(tabId);
  }
}

async function syncAllTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});

  for (const tab of tabs) {
    if (typeof tab.id === "number") {
      await updatePageActionForTab(tab.id, tab.url);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void syncAllTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void updatePageActionForTab(tabId, changeInfo.url ?? tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  await updatePageActionForTab(tabId, tab.url);
});

chrome.pageAction.onClicked.addListener(async (tab) => {
  if (typeof tab.id !== "number" || !isTargetUrl(tab.url)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "INSERT_BUFFER" });
  } catch {
    // Ignore messaging errors when the content script is unavailable.
  }
});