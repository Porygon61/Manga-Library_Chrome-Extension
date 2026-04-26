let pageConfig = null;
let globalSettings = {
    enableProgressSyncBtn: true,
    enableAddNewMangaBtn: true,
};

async function remoteLog(level, category, action, source, data = null) {
    try {
        await fetch("http://localhost:3000/data/logs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level, category, action, source, data }),
        });
    } catch (e) {
        console.error("Remote logging failed:", e);
    }
}

async function getBaseUrl() {
    let baseUrl = window.location.href;
    const isInfoPage = new RegExp(pageConfig.site_structure.info_page).test(
        baseUrl,
    );

    // 1. Try to fetch from DOM using manga_url_selector
    if (pageConfig.manga_url_selector && !isInfoPage) {
        const linkEl = document.querySelector(pageConfig.manga_url_selector);
        if (linkEl && linkEl.href) {
            baseUrl = linkEl.href;
        }
    }

    // 2. ALWAYS apply url_base formatting if it exists
    if (pageConfig.url_base) {
        let cleanUrl = baseUrl.replace("www.", "");
        let cleanBase = pageConfig.url_base.replace("www.", "");
        if (cleanUrl.includes(cleanBase)) {
            const pathAfterBase = cleanUrl.replace(cleanBase, "");
            let mangaSlug = pathAfterBase.split("/")[0];

            // Strip volatile hex codes from the slug
            if (pageConfig.slug_cleaner) {
                const regex = new RegExp(pageConfig.slug_cleaner, "i");
                mangaSlug = mangaSlug.replace(regex, "");
            }

            baseUrl = pageConfig.url_base + mangaSlug + "/";
        }
    }
    return baseUrl;
}

function getScrapedChapter() {
    const selector = pageConfig.selectors?.read_chapter_num;
    if (!selector || selector.trim() === "") return null;

    let chEl = null;
    try {
        if (selector.startsWith("xpath:")) {
            const xpath = selector.replace("xpath:", "").trim();
            const snapshot = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null,
            );
            chEl = snapshot.singleNodeValue;
        } else {
            chEl = document.querySelector(selector);
        }
    } catch (e) {
        console.warn("Failed to parse read_chapter_num selector:", e);
        return null;
    }

    if (!chEl) return null;

    let cleanNum = chEl.innerText;
    const replacements = pageConfig.string_replacements?.read_chapter_num;
    if (replacements && Array.isArray(replacements)) {
        replacements.forEach((str) => {
            let regex;
            if (str.startsWith("/") && str.match(/\/[gimsuy]*$/)) {
                const lastSlash = str.lastIndexOf("/");
                regex = new RegExp(
                    str.substring(1, lastSlash),
                    str.substring(lastSlash + 1),
                );
            } else {
                const escapedStr = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                regex = new RegExp(escapedStr, "gi");
            }
            cleanNum = cleanNum.replace(regex, "");
        });
    }
    return cleanNum.replace(/[^0-9.]/g, "").trim();
}

function getMaxChapterFromDropdown() {
    const selector = pageConfig.selectors?.chapter_list_dropdown;
    if (!selector || selector.trim() === "") return null;

    let elements = [];
    try {
        if (selector.startsWith("xpath:")) {
            const xpath = selector.replace("xpath:", "").trim();
            const snapshot = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
            );
            for (let i = 0; i < snapshot.snapshotLength; i++) {
                elements.push(snapshot.snapshotItem(i));
            }
        } else {
            elements = Array.from(document.querySelectorAll(selector));
        }
    } catch (e) {
        console.warn("Failed to parse chapter_list_dropdown selector:", e);
        return null;
    }

    if (elements.length === 0) return null;

    let maxChapter = 0;

    elements.forEach((el) => {
        // Check 'value' attribute first (for <option> tags), fallback to innerText
        let text = el.value || el.innerText;

        // Strip out everything except numbers and decimals
        let cleanNum = parseFloat(String(text).replace(/[^\d.]/g, ""));

        if (!isNaN(cleanNum) && cleanNum > maxChapter) {
            maxChapter = cleanNum;
        }
    });

    return maxChapter > 0 ? maxChapter.toString() : null;
}

async function initContentScript() {
    const { isConnected, masterConfig } = await chrome.storage.local.get([
        "isConnected",
        "masterConfig",
    ]);

    const oldContainer = document.getElementById(
        "manga-sync-fixed-btn-container",
    );
    if (oldContainer) oldContainer.remove();

    const oldBtn = document.getElementById("manga-sync-fixed-btn");
    if (oldBtn) oldBtn.remove(); // Cleanup stray buttons just in case

    if (!isConnected || !masterConfig) return;

    try {
        const domain = window.location.hostname.replace("www.", "");
        pageConfig = masterConfig.websites[domain];

        if (masterConfig.settings) globalSettings = masterConfig.settings;

        if (pageConfig) {
            const url = window.location.href;
            const isReader = new RegExp(
                pageConfig.site_structure.reading_page,
            ).test(url);
            const isInfo = new RegExp(pageConfig.site_structure.info_page).test(
                url,
            );

            if (isReader && globalSettings.enableProgressSyncBtn) {
                const baseUrl = await getBaseUrl();
                const scrapedChapter = getScrapedChapter() || "?";
                let savedChapter = "?";
                let displayLatest = getMaxChapterFromDropdown() || "?";

                try {
                    const res = await fetch(
                        "http://localhost:3000/data/library/search",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ url: baseUrl }),
                        },
                    );
                    const entry = await res.json();

                    if (entry) {
                        if (entry.current_chapter)
                            savedChapter = entry.current_chapter;
                        if (entry.latest_chapter && displayLatest === "?")
                            displayLatest = entry.latest_chapter;

                        // --- SILENT UPDATE LOGIC ---
                        if (displayLatest !== "?") {
                            const dbLatest = parseFloat(
                                String(entry.latest_chapter || "0").replace(
                                    /[^\d.]/g,
                                    "",
                                ),
                            );
                            const parsedDropdownMax = parseFloat(displayLatest);

                            if (parsedDropdownMax > dbLatest) {
                                fetch(
                                    "http://localhost:3000/data/library/entry",
                                    {
                                        method: "PATCH",
                                        headers: {
                                            "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                            url: baseUrl,
                                            updates: {
                                                latest_chapter: displayLatest,
                                            },
                                        }),
                                    },
                                )
                                    .then(() =>
                                        remoteLog(
                                            "INFO",
                                            "UI",
                                            "SILENT_UPDATE_LATEST",
                                            "content.js",
                                            {
                                                url: baseUrl,
                                                latest: displayLatest,
                                            },
                                        ),
                                    )
                                    .catch((e) => {});
                            }
                        }
                    }
                } catch (e) {}

                injectButton(
                    "🕮",
                    "Sync Progress",
                    () => handleReaderSync(displayLatest),
                    savedChapter,
                    scrapedChapter,
                    displayLatest,
                );
            } else if (isInfo && globalSettings.enableAddNewMangaBtn) {
                injectButton("+", "Quick Add/Sync", () => {
                    const btn = document.getElementById("manga-sync-fixed-btn");
                    updateBtn(btn, "Syncing...", "#e67e22", "+");
                    chrome.runtime.sendMessage(
                        { action: "extQuickSync" },
                        (res) => {
                            if (res && res.success) {
                                updateBtn(btn, "Done", "#27ae60", "+", true);
                            } else {
                                updateBtn(btn, "Failed", "#e74c3c", "+", true);
                            }
                        },
                    );
                });
            }
        }
    } catch (e) {
        console.error("MangaTracker Init Error:", e);
    }
}

function injectButton(
    icon,
    title,
    clickHandler,
    saved = null,
    scraped = null,
    latest = null,
) {
    const container = document.createElement("div");
    container.id = "manga-sync-fixed-btn-container";
    Object.assign(container.style, {
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: "2147483647",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "6px",
    });

    if (saved !== null && scraped !== null) {
        const infoDisplay = document.createElement("div");
        Object.assign(infoDisplay.style, {
            background: "rgba(44, 62, 80, 0.95)",
            color: "#ecf0f1",
            padding: "6px 10px",
            borderRadius: "6px",
            fontSize: "12px",
            fontFamily: "Arial, sans-serif",
            backdropFilter: "blur(4px)",
            border: "1px solid #34495e",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
            display: "flex",
            gap: "8px",
        });
        let latestHtml =
            latest && latest !== "?"
                ? `<span style="color:#7f8c8d">|</span><span>Latest: <b style="color:#9b59b6">${latest}</b></span>`
                : "";

        infoDisplay.innerHTML = `
            <span>Saved: <b style="color:#f1c40f">${saved}</b></span>
            <span style="color:#7f8c8d">|</span>
            <span>New: <b style="color:#2ecc71">${scraped}</b></span>
            ${latestHtml}
        `;
        container.appendChild(infoDisplay);
    }

    const btn = document.createElement("button");
    btn.id = "manga-sync-fixed-btn";
    btn.innerHTML = `<span>${icon}</span>`;
    btn.title = title;
    Object.assign(btn.style, {
        padding: "12px 18px",
        backgroundColor: "#2c3e50",
        color: "white",
        border: "2px solid #34495e",
        borderRadius: "8px",
        cursor: "pointer",
        fontSize: "18px",
        boxShadow: "0 4px 15px rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
    });
    btn.onclick = (e) => {
        e.preventDefault();
        clickHandler();
    };

    container.appendChild(btn);
    document.body.appendChild(container);
}

async function handleReaderSync(currentLatest) {
    const btn = document.getElementById("manga-sync-fixed-btn");
    const cleanNum = getScrapedChapter();

    if (!cleanNum) {
        updateBtn(btn, "Err/Not Found", "#e74c3c", "🕮", true);
        return;
    }

    try {
        const baseUrl = await getBaseUrl();

        const res = await fetch("http://localhost:3000/data/library/entry", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: baseUrl, new_chapter: cleanNum }),
        });

        const result = await res.json();
        if (result.success) {
            updateBtn(btn, "✓", "#27ae60", "🕮", true);

            // Immediately update the visual display bar above the button
            const container = document.getElementById(
                "manga-sync-fixed-btn-container",
            );
            if (
                container &&
                container.firstChild &&
                container.firstChild.id !== "manga-sync-fixed-btn"
            ) {
                // Re-fetch the latest so we don't lose it on the visual refresh
                const latestNum =
                    getMaxChapterFromDropdown() || currentLatest || "?";
                let latestHtml =
                    latestNum !== "?"
                        ? `<span style="color:#7f8c8d">|</span><span>Latest: <b style="color:#9b59b6">${latestNum}</b></span>`
                        : "";

                container.firstChild.innerHTML = `
                    <span>Saved: <b style="color:#f1c40f">${cleanNum}</b></span>
                    <span style="color:#7f8c8d">|</span>
                    <span>New: <b style="color:#2ecc71">${cleanNum}</b></span>
                    ${latestHtml}
                `;
            }

            remoteLog("INFO", "UI", "READER_SYNC_SUCCESS", "content.js", {
                url: baseUrl,
                chapter: cleanNum,
            });
        } else {
            updateBtn(btn, "Not in Lib", "#e67e22", "🕮", true);
            remoteLog("WARN", "UI", "READER_SYNC_NOT_FOUND", "content.js", {
                url: baseUrl,
            });
        }
    } catch (err) {
        updateBtn(btn, "Offline", "#e74c3c", "🕮");
        remoteLog("ERROR", "API", "READER_SYNC_OFFLINE", "content.js", {
            error: err.message,
            url: window.location.href, // fallback
        });
    }
}

function updateBtn(btn, text, color, originalIcon, reset = false) {
    if (!btn) return;
    btn.innerText = text;
    btn.style.backgroundColor = color;
    if (reset) {
        setTimeout(() => {
            btn.innerHTML = `<span>${originalIcon}</span>`;
            btn.style.backgroundColor = "#2c3e50";
        }, 2500);
    }
}

let lastUrl = location.href;
new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
        lastUrl = url;

        const oldContainer = document.getElementById(
            "manga-sync-fixed-btn-container",
        );
        if (oldContainer) oldContainer.remove();

        setTimeout(initContentScript, 1000);
    }
}).observe(document, { subtree: true, childList: true });

initContentScript();
