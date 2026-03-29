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
async function initContentScript() {
    const { isConnected, masterConfig } = await chrome.storage.local.get([
        "isConnected",
        "masterConfig",
    ]);

    const oldBtn = document.getElementById("manga-sync-fixed-btn");
    if (oldBtn) oldBtn.remove();

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
                injectButton("🕮", "Sync Progress", handleReaderSync);
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

function injectButton(icon, title, clickHandler) {
    const btn = document.createElement("button");
    btn.id = "manga-sync-fixed-btn";
    btn.innerHTML = `<span>${icon}</span>`;
    btn.title = title;
    Object.assign(btn.style, {
        position: "fixed",
        top: "20px",
        right: "20px",
        zIndex: "2147483647",
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
    document.body.appendChild(btn);
}

async function handleReaderSync() {
    const btn = document.getElementById("manga-sync-fixed-btn");
    const selector = pageConfig.selectors?.read_chapter_num;

    // Safety check for empty selector
    if (!selector || selector.trim() === "") {
        updateBtn(btn, "Config Err", "#e74c3c", "🕮", true);
        return;
    }

    const chEl = document.querySelector(selector);
    if (!chEl) {
        updateBtn(btn, "Not Found", "#e74c3c", "🕮", true);
        return;
    }

    // Text Cleaning
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
    cleanNum = cleanNum.replace(/[^0-9.]/g, "").trim();

    try {
        let baseUrl = window.location.href;
        const isInfoPage = new RegExp(pageConfig.site_structure.info_page).test(
            baseUrl,
        );

        // 1. Try to fetch from DOM using manga_url_selector
        if (pageConfig.manga_url_selector && !isInfoPage) {
            const linkEl = document.querySelector(
                pageConfig.manga_url_selector,
            );
            if (linkEl && linkEl.href) {
                baseUrl = linkEl.href;
            }
        }

        // 2. ALWAYS apply url_base formatting if it exists, regardless of where baseUrl came from
        if (pageConfig.url_base) {
            let cleanUrl = baseUrl.replace("www.", "");
            let cleanBase = pageConfig.url_base.replace("www.", "");
            if (cleanUrl.includes(cleanBase)) {
                const pathAfterBase = cleanUrl.replace(cleanBase, "");
                const mangaSlug = pathAfterBase.split("/")[0];
                baseUrl = pageConfig.url_base + mangaSlug + "/";
            }
        }

        const res = await fetch("http://localhost:3000/data/library/entry", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: baseUrl, new_chapter: cleanNum }),
        });

        const result = await res.json();
        if (result.success) {
            updateBtn(btn, "✓", "#27ae60", "🕮", true);
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
            url: baseUrl,
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
        setTimeout(initContentScript, 1000);
    }
}).observe(document, { subtree: true, childList: true });

initContentScript();
