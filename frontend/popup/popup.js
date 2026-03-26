import { executeScraper } from "../util/scraper.js";
import { remoteLog } from "../util/common.js";

let currentUrl = "";
let masterConfig = {};
let currentSiteConfig = null;
let currentPageType = null;
let currentEntry = null;

async function init() {
    const urlParams = new URLSearchParams(window.location.search);
    let targetUrl = urlParams.get("url");

    let tabId = null;
    if (targetUrl) {
        currentUrl = targetUrl;
    } else {
        const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
        });
        currentUrl = tab.url;
        tabId = tab.id;
    }

    // Safety check for non-http URLs (e.g., chrome:// extensions page)
    let domain = "";
    try {
        domain = new URL(currentUrl).hostname.replace("www.", "");
    } catch (e) {
        document.body.innerHTML = `
            <div style="padding:20px; text-align:center; color: #546e7a;">
                <h3>Invalid Page</h3>
                <p style="font-size:12px;">Open the popup on a valid manga webpage.</p>
            </div>`;
        return;
    }

    chrome.runtime.sendMessage({ action: "checkServer" });
    chrome.storage.local.get(["isConnected"], (result) => {
        if (!result.isConnected)
            showStatus("Server Offline - Content may not save", "error");
    });

    try {
        const configRes = await fetch("http://localhost:3000/data/config");
        masterConfig = await configRes.json();
    } catch (err) {
        showStatus("Failed to load config", "error");
        return;
    }

    currentSiteConfig = masterConfig.websites
        ? masterConfig.websites[domain]
        : null;

    if (!currentSiteConfig) {
        document.body.innerHTML = `
            <div style="padding:20px; text-align:center; color: #546e7a;">
                <h3>Site Not Supported</h3>
                <p style="font-size:12px;">Add <b>${domain}</b> to your config to track this manga.</p>
                <button id="btnEmergencySettings" style="margin-top: 15px; padding: 10px; background: #575757; color: white; border: none; border-radius: 6px; cursor: pointer;">Open Settings</button>
            </div>`;

        document.getElementById("btnEmergencySettings").onclick = () => {
            document.body.innerHTML = "";
            document.body.innerHTML = `
                <div style="padding: 15px;">
                    <h3 style="margin: 0 0 5px 0; color: #455a64">Emergency Config</h3>
                    <textarea id="emConfig" style="width: 100%; height: 400px; font-family: monospace; font-size: 11px;">${JSON.stringify(masterConfig, null, 2)}</textarea>
                    <button id="emSave" style="width: 100%; padding: 10px; background: #27ae60; color: white; border: none; margin-top: 10px;">Save Config</button>
                </div>
            `;
            document.getElementById("emSave").onclick = async () => {
                try {
                    const parsed = JSON.parse(
                        document.getElementById("emConfig").value,
                    );
                    await fetch("http://localhost:3000/data/config", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(parsed, null, 2),
                    });
                    location.reload();
                } catch (e) {
                    alert("Invalid JSON");
                }
            };
        };
        return;
    }

    currentPageType = getPageType(currentUrl, currentSiteConfig);

    const searchUrl = await getMangaIdFromUrl(
        currentUrl,
        currentSiteConfig,
        targetUrl ? null : tabId,
    );
    currentUrl = searchUrl;

    const quickSyncBtn = document.getElementById("btnQuickSync");
    const canSync =
        currentSiteConfig.features.quickSync.includes(currentPageType) &&
        !targetUrl;

    if (quickSyncBtn) {
        quickSyncBtn.disabled = !canSync;
        quickSyncBtn.style.opacity = canSync ? "1" : "0.5";
        quickSyncBtn.title = canSync
            ? "Sync Metadata"
            : targetUrl
              ? "Cannot Quick Sync from right-click menu."
              : "Metadata only available on Info Page";
    }

    fetch(`http://localhost:3000/data/library/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: currentUrl }),
    })
        .then((res) => res.json())
        .then((entry) => {
            if (entry) renderTracker(entry);
            else showNoData();
        })
        .catch(() => showNoData());

    const progToggle = document.getElementById("enableProgressSyncBtn");
    const addToggle = document.getElementById("enableAddNewMangaBtn");

    if (progToggle && addToggle) {
        if (masterConfig.settings) {
            progToggle.checked = !!masterConfig.settings.enableProgressSyncBtn;
            addToggle.checked = !!masterConfig.settings.enableAddNewMangaBtn;
        }

        [progToggle, addToggle].forEach((toggle) => {
            toggle.onchange = () => pushSettingsUpdate();
        });
    }
}

function renderTracker(entry) {
    currentEntry = entry;
    hideAll();
    const view = document.getElementById("trackView");
    view.classList.remove("hidden");
    view.style.display = "flex";

    document.getElementById("btnDelete").style.display = "block";
    document.getElementById("btnDelete").classList.remove("hidden");
    document.getElementById("btnManual").style.display = "block";
    document.getElementById("btnManual").classList.remove("hidden");

    document.getElementById("curCh").innerText = entry.current_chapter || "0.0";

    const coverCont = document.getElementById("coverContainer");
    coverCont.innerHTML = "";
    if (entry.cover_image) {
        const img = document.createElement("img");
        img.src = entry.cover_image;
        img.className = "tracker-cover";
        img.onerror = function () {
            this.onerror = null;
            this.src = "http://localhost:3000/covers/placeholder.jpg";
            this.style.opacity = "0.5";
        };
        coverCont.appendChild(img);
    }

    const meta = document.getElementById("metaDisplay");
    meta.innerHTML = "";

    Object.entries(entry).forEach(([key, val]) => {
        if (
            [
                "id",
                "url",
                "current_chapter",
                "cover_image",
                "read_chapter_num",
                "nsfw",
            ].includes(key)
        )
            return;

        let displayVal = val;
        try {
            let parsed = JSON.parse(val);
            if (Array.isArray(parsed)) displayVal = parsed.join(", ");
        } catch (e) {}

        const div = document.createElement("div");
        div.className = "info-row";
        div.innerHTML = `<div class="info-label">${key.replace(/_/g, " ")}</div><div class="info-value">${displayVal || "---"}</div>`;
        meta.appendChild(div);
    });
}

function showNoData() {
    currentEntry = null;
    hideAll();
    const view = document.getElementById("trackView");
    view.classList.remove("hidden");
    view.style.display = "flex";

    document.getElementById("btnManual").style.display = "block";
    document.getElementById("btnManual").classList.remove("hidden");
    document.getElementById("btnDelete").style.display = "none";

    document.getElementById("curCh").innerText = "---";
    document.getElementById("coverContainer").innerHTML = "";
    document.getElementById("metaDisplay").innerHTML =
        "<center style='color:#999; padding:20px;'>No data found for this URL.<br><br>Click 'Quick Sync' or 'Manual Add'.</center>";
}

function renderEditor(values = {}) {
    hideAll();

    document.getElementById("btnSettings").classList.add("hidden");
    document.getElementById("btnSettings").style.display = "none";
    document.getElementById("btnDelete").style.display = "none";
    document.getElementById("btnManual").style.display = "none";

    document.getElementById("btnBack").classList.remove("hidden");
    document.getElementById("btnBack").style.display = "block";

    const view = document.getElementById("editView");
    view.classList.remove("hidden");
    view.style.display = "flex";

    const container = document.getElementById("dynamicInputs");
    container.innerHTML = "";

    const schema = masterConfig.db.tables.bookmarks;
    Object.keys(schema).forEach((key) => {
        if (key === "url") return;

        const row = document.createElement("div");
        row.className = "field-row";
        const isId = key.toLowerCase() === "id";
        const isTimestamp = key.toLowerCase() === "timestamp"; // Protect timestamp modification

        if (key.toLowerCase() === "nsfw") {
            const isChecked =
                values[key] == 1 ||
                values[key] == "1" ||
                values[key] === true ||
                values[key] === "true";
            row.innerHTML = `
                <label style="display:inline-block; margin-right: 10px;">${key.toUpperCase()}</label>
                <input type="checkbox" id="field_${key}" ${isChecked ? "checked" : ""} style="width:auto; display:inline-block;">
            `;
        } else {
            let displayVal = values[key] || "";
            try {
                // If it's an array stored as a string, unfold it for manual editing
                if (
                    typeof displayVal === "string" &&
                    displayVal.startsWith("[")
                ) {
                    let parsed = JSON.parse(displayVal);
                    if (Array.isArray(parsed)) displayVal = parsed.join(", ");
                }
            } catch (e) {}

            row.innerHTML = `
                <label>${key.replace("_", " ").toUpperCase()}</label>
                <input type="text" id="field_${key}" value="${displayVal}" 
                       ${isId || isTimestamp ? 'disabled title="Protected Database Field"' : ""}>
            `;
        }
        container.appendChild(row);
    });
}

document.getElementById("btnBack").onclick = init;

document.getElementById("btnSettings").onclick = () => {
    hideAll();
    document.getElementById("btnSettings").classList.add("hidden");
    document.getElementById("btnSettings").style.display = "none";
    document.getElementById("btnDelete").style.display = "none";
    document.getElementById("btnManual").style.display = "none";

    document.getElementById("btnBack").classList.remove("hidden");
    document.getElementById("btnBack").style.display = "block";

    const view = document.getElementById("settingsView");
    view.classList.remove("hidden");
    view.style.display = "flex";

    document.getElementById("configInput").value = JSON.stringify(
        masterConfig,
        null,
        2,
    );
};

document.getElementById("btnEditMode").onclick = () => {
    const currentValues = currentEntry ? { ...currentEntry } : {};
    currentValues.current_chapter = document.getElementById("curCh").innerText;
    const existingImg = document.querySelector(".tracker-cover");
    if (existingImg) currentValues["cover_image"] = existingImg.src;
    renderEditor(currentValues);
};

document.getElementById("btnManual").onclick = () => renderEditor({});

document.getElementById("btnDelete").onclick = () => {
    if (confirm("Delete this bookmark? This cannot be undone.")) {
        remoteLog("INFO", "UI", "DELETE_BOOKMARK_INIT", "popup.js", {
            url: currentUrl,
        });
        fetch("http://localhost:3000/data/library/entry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: currentUrl, delete: true }, null, 2),
        })
            .then((response) => response.json())
            .then((data) => {
                if (data.success) {
                    showStatus("Deleted!", "success");
                    remoteLog(
                        "INFO",
                        "DB",
                        "DELETE_BOOKMARK_SUCCESS",
                        "popup.js",
                        { url: currentUrl },
                    );
                    init();
                }
            })
            .catch((err) =>
                remoteLog("ERROR", "API", "DELETE_BOOKMARK_ERROR", "popup.js", {
                    error: err.message,
                    url: currentUrl,
                }),
            );
    }
};

document.getElementById("btnQuickSync").onclick = async () => {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    const domain = new URL(tab.url).hostname.replace("www.", "");

    if (currentPageType !== "info_page") {
        showStatus("Can only sync from Info Page", "error");
        return;
    }

    const dbColumns = Object.keys(masterConfig.db.tables.bookmarks);

    fetch(`http://localhost:3000/data/library/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: currentUrl }),
    })
        .then((res) => res.json())
        .then((existingEntry) => {
            const currentProgress = existingEntry
                ? existingEntry.current_chapter
                : "0.0";

            chrome.scripting.executeScript(
                {
                    target: { tabId: tab.id },
                    func: executeScraper,
                    args: [masterConfig, domain],
                },
                (results) => {
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
                            current_chapter: currentProgress,
                            website: domain,
                        };

                        fetch("http://localhost:3000/data/library/entry", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                url: currentUrl,
                                entry: syncedEntry,
                            }),
                        })
                            .then((res) => res.json())
                            .then((data) => {
                                if (data.error) throw new Error(data.error);
                                renderTracker(syncedEntry);
                                showStatus("Synced & Saved!");
                            })
                            .catch((err) =>
                                showStatus(
                                    "Server Error: " + err.message,
                                    "error",
                                ),
                            );
                    } else {
                        showStatus(scraped?.Error || "Scrape Error", "error");
                    }
                },
            );
        });
};

document.getElementById("saveEntryBtn").onclick = () => {
    const domain = new URL(currentUrl).hostname.replace("www.", "");
    let newEntry = { url: currentUrl, website: domain };

    const schema = masterConfig.db.tables.bookmarks;
    const arrayFields = ["alt_title", "genres", "author", "artist", "website"]; // Known array types

    Object.keys(schema).forEach((key) => {
        const el = document.getElementById(`field_${key}`);
        if (el) {
            if (el.type === "checkbox") {
                newEntry[key] = el.checked ? 1 : 0;
            } else {
                let rawVal = el.value.trim();
                // Ensure arrays are formatted correctly before sending to the backend
                if (arrayFields.includes(key)) {
                    if (rawVal === "") {
                        newEntry[key] = [];
                    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
                        try {
                            newEntry[key] = JSON.parse(rawVal);
                        } catch (e) {
                            newEntry[key] = [rawVal];
                        }
                    } else {
                        newEntry[key] = rawVal
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                    }
                } else {
                    newEntry[key] = rawVal;
                }
            }
        }
    });

    if (!newEntry.current_chapter) newEntry.current_chapter = "0.0";

    remoteLog("INFO", "UI", "SAVE_MANUAL_ENTRY", "popup.js", {
        entry: newEntry.title,
    });

    if (currentEntry && currentEntry.id) {
        delete newEntry.url; // Prevent mapping error
        fetch(`http://localhost:3000/data/library/entry`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: currentEntry.id, updates: newEntry }),
        })
            .then((res) => res.json())
            .then(() => {
                showStatus("Bookmark Updated!");
                init();
            });
    } else {
        fetch(`http://localhost:3000/data/library/entry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: currentUrl, entry: newEntry }),
        })
            .then((res) => res.json())
            .then(() => {
                showStatus("Bookmark Saved!");
                init();
            });
    }
};

function adjustChapter(amt) {
    fetch(`http://localhost:3000/data/library/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: currentUrl }),
    })
        .then((response) => response.json())
        .then((entry) => {
            let cur = parseFloat(entry?.current_chapter || 0);
            if (isNaN(cur)) cur = 0; // Fix NaN edge case

            let newChapter = (cur + amt).toFixed(1);
            if (newChapter < 0) newChapter = "0.0";
            if (newChapter.endsWith(".0"))
                newChapter = parseInt(newChapter).toString(); // Strip unnecessary decimals

            return fetch(`http://localhost:3000/data/library/entry`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: currentUrl,
                    new_chapter: newChapter,
                }),
            });
        })
        .then((response) => response.json())
        .then((data) => {
            if (data && data.success) {
                document.getElementById("curCh").innerText = data.new_chapter;
                // Keep the active object memory updated so manual edit pulls the new value
                if (currentEntry)
                    currentEntry.current_chapter = data.new_chapter;
                showStatus("Chapter Updated!");
            }
        })
        .catch((err) => console.error("Chapter Update Error:", err));
}

document.getElementById("plusBtn").onclick = () => adjustChapter(1);
document.getElementById("minusBtn").onclick = () => adjustChapter(-1);

function hideAll() {
    [
        "trackView",
        "editView",
        "settingsView",
        "btnBack",
        "btnSettings",
        "btnDelete",
        "btnManual",
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add("hidden");
            el.style.display = "none";
        }
    });
    document.getElementById("btnSettings").classList.remove("hidden");
    document.getElementById("btnSettings").style.display = "block";
}

async function getMangaIdFromUrl(url, siteConfig, tabId = null) {
    const isInfoPage = new RegExp(siteConfig.site_structure.info_page).test(
        url,
    );
    let resultUrl = url;

    // Extract from selector if available
    if (siteConfig.manga_url_selector && tabId && !isInfoPage) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: (sel) => {
                    const el = document.querySelector(sel);
                    return el ? el.href : null;
                },
                args: [siteConfig.manga_url_selector],
            });
            if (results && results[0] && results[0].result) {
                resultUrl = results[0].result;
            }
        } catch (e) {}
    }

    // Apply formatting to whatever URL we ended up with
    if (siteConfig.url_base) {
        let cleanUrl = resultUrl.replace("www.", "");
        let cleanBase = siteConfig.url_base.replace("www.", "");
        if (cleanUrl.includes(cleanBase)) {
            let pathAfterBase = cleanUrl.replace(cleanBase, "");
            let mangaSlug = pathAfterBase.split("/")[0];
            return siteConfig.url_base + mangaSlug + "/";
        }
    }

    return resultUrl;
}

function showStatus(msg, type = "success") {
    const s = document.createElement("div");
    s.innerText = msg;
    Object.assign(s.style, {
        position: "fixed",
        top: "15px",
        left: "50%",
        transform: "translateX(-50%)",
        background: type === "success" ? "#2ecc71" : "#e74c3c",
        color: "white",
        padding: "10px 20px",
        borderRadius: "25px",
        fontSize: "13px",
        zIndex: "9999",
        fontWeight: "bold",
        boxShadow: "0 4px 15px rgba(0,0,0,0.2)",
        transition: "opacity 0.5s",
    });
    document.body.appendChild(s);
    setTimeout(() => {
        s.style.opacity = "0";
        setTimeout(() => s.remove(), 500);
    }, 2000);
}

function getPageType(currentUrl, siteConfig) {
    if (!siteConfig || !siteConfig.site_structure) return null;
    const cleanUrl = currentUrl.split("?")[0].split("#")[0];
    for (const [type, pattern] of Object.entries(siteConfig.site_structure)) {
        const regex = new RegExp(pattern);
        if (regex.test(cleanUrl)) return type;
    }
    return "unknown";
}

document.getElementById("saveConfigBtn").onclick = () => {
    try {
        const configInput = document.getElementById("configInput");
        const parsed = JSON.parse(configInput.value);

        parsed.settings = {
            enableProgressSyncBtn: document.getElementById(
                "enableProgressSyncBtn",
            ).checked,
            enableAddNewMangaBtn: document.getElementById(
                "enableAddNewMangaBtn",
            ).checked,
        };

        fetch("http://localhost:3000/data/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed, null, 2),
        })
            .then((response) => response.json())
            .then((data) => {
                if (data.success) {
                    masterConfig = parsed;
                    configInput.value = JSON.stringify(masterConfig, null, 2);
                    showStatus("Configuration Saved");
                } else {
                    showStatus("Failed to save configuration", "error");
                }
            });
    } catch (e) {
        showStatus("Invalid JSON Format", "error");
        document.getElementById("configInput").style.border = "2px solid red";
        setTimeout(() => {
            document.getElementById("configInput").style.border = "";
        }, 2000);
    }
};

async function pushSettingsUpdate() {
    const progToggle = document.getElementById("enableProgressSyncBtn");
    const addToggle = document.getElementById("enableAddNewMangaBtn");

    if (!progToggle || !addToggle) return;

    try {
        masterConfig.settings = {
            enableProgressSyncBtn: progToggle.checked,
            enableAddNewMangaBtn: addToggle.checked,
        };

        const response = await fetch("http://localhost:3000/data/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(masterConfig, null, 2),
        });

        const data = await response.json();
        if (data.success) {
            showStatus("Settings Saved");
            const configInput = document.getElementById("configInput");
            if (configInput)
                configInput.value = JSON.stringify(masterConfig, null, 2);
        }
    } catch (e) {
        showStatus("Connection Error", "error");
    }
}

document.getElementById("exportBtn").onclick = () => {
    const blob = new Blob([document.getElementById("configInput").value], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "manga_scraper_config.json";
    a.click();
};

window.addEventListener("blur", () => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("url")) window.close();
});

document.addEventListener("DOMContentLoaded", init);
