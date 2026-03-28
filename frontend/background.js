import { executeScraper } from "./util/scraper.js";
import { remoteLog } from "./util/common.js";

const SERVER_URL = "http://localhost:3000/data/config";

chrome.runtime.onInstalled.addListener(() => {
    updateBadge(false);

    chrome.contextMenus.create({
        id: "checkLibraryContextMenu",
        title: "Check Manga in Library",
        contexts: ["link"],
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
        checkConnection();
    }
});

function updateBadge(connected) {
    const text = connected ? "ON" : "OFF";
    const color = connected ? "#4CAF50" : "#F44336";
    chrome.action.setBadgeText({ text: text });
    chrome.action.setBadgeBackgroundColor({ color: color });
    chrome.storage.local.set({ isConnected: connected });
}

async function checkConnection() {
    try {
        const response = await fetch(SERVER_URL, {
            method: "GET",
            cache: "no-store",
        });
        updateBadge(response.ok);
    } catch (error) {
        updateBadge(false);
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "extQuickSync") {
        const tabId = sender.tab.id;
        const url = sender.tab.url;
        handleBackgroundSync(url, tabId).then((success) =>
            sendResponse({ success: success }),
        );
        return true;
    }
    if (request.action === "checkServer") checkConnection();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "checkLibraryContextMenu") {
        const targetUrl = info.linkUrl;

        chrome.windows.create({
            url: chrome.runtime.getURL(
                `popup/popup.html?url=${encodeURIComponent(targetUrl)}`,
            ),
            type: "popup",
            width: 380,
            height: 620,
        });
    }
});

async function handleBackgroundSync(tabUrl, tabId) {
    try {
        remoteLog("INFO", "SYSTEM", "BACKGROUND_SYNC_START", "background.js", {
            url: tabUrl,
        });

        const configRes = await fetch("http://localhost:3000/data/config");
        const masterConfig = await configRes.json();

        const domain = new URL(tabUrl).hostname.replace("www.", "");
        const siteConfig = masterConfig.websites[domain];
        const isInfoPage = new RegExp(siteConfig.site_structure.info_page).test(
            tabUrl,
        );
        if (!siteConfig) return false;

        let mangaIdUrl = tabUrl;

        // Addition: Attempt to use manga_url_selector to extract root ID
        if (siteConfig.manga_url_selector && !isInfoPage) {
            try {
                const urlRes = await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (sel) => {
                        const el = document.querySelector(sel);
                        return el ? el.href : null;
                    },
                    args: [siteConfig.manga_url_selector],
                });
                if (urlRes && urlRes[0] && urlRes[0].result)
                    mangaIdUrl = urlRes[0].result;
            } catch (e) {
                remoteLog("ERROR", "UI", "MANGA_URL_SELECTOR", "background.js");
            }
        }

        // Apply formatting universally
        if (siteConfig.url_base) {
            let cleanUrl = mangaIdUrl.replace("www.", "");
            let cleanBase = siteConfig.url_base.replace("www.", "");
            if (cleanUrl.includes(cleanBase)) {
                const pathAfterBase = cleanUrl.replace(cleanBase, "");
                const mangaSlug = pathAfterBase.split("/")[0];
                mangaIdUrl = siteConfig.url_base + mangaSlug + "/";
            }
        }

        const entryRes = await fetch(
            `http://localhost:3000/data/library/search`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: mangaIdUrl }),
            },
        );
        const existingEntry = await entryRes.json();
        const currentProgress = existingEntry?.current_chapter || "0.0";
        const dbColumns = Object.keys(masterConfig.db.tables.bookmarks);

        chrome.scripting.executeScript(
            {
                target: { tabId: tabId },
                func: executeScraper,
                args: [masterConfig, domain],
            },
            async (results) => {
                const scraped = results[0]?.result;

                if (scraped && !scraped.Error) {
                    let filteredScraped = {};
                    dbColumns.forEach((col) => {
                        if (scraped[col] !== undefined) {
                            filteredScraped[col] = scraped[col];
                        }
                    });

                    const syncedEntry = {
                        ...filteredScraped,
                        url: mangaIdUrl,
                        current_chapter: currentProgress,
                        website: domain,
                    };
                    const res = await fetch(
                        "http://localhost:3000/data/library/entry",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                url: mangaIdUrl,
                                entry: syncedEntry,
                            }),
                        },
                    );

                    if (!res.ok) throw new Error("Server returned an error");

                    remoteLog(
                        "INFO",
                        "API",
                        "BACKGROUND_SYNC_SUCCESS",
                        "background.js",
                        { url: mangaIdUrl, entry: syncedEntry.title },
                    );
                } else {
                    remoteLog(
                        "WARN",
                        "SYSTEM",
                        "BACKGROUND_SCRAPE_FAILED",
                        "background.js",
                        { url: mangaIdUrl, error: scraped?.Error },
                    );
                }
            },
        );
        return true;
    } catch (err) {
        remoteLog("ERROR", "SYSTEM", "BACKGROUND_SYNC_ERROR", "background.js", {
            error: err.message,
            url: tabUrl,
        });
        return false;
    }
}

checkConnection();
