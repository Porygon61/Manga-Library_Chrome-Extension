import { remoteLog, getParsedArray } from "../frontend/util/common.js";
let libraryData = [];
let pendingUpdates = [];
let masterConfig = {};
let viewMode = "grid";
let selectedIds = new Set();
let isEditing = false;
let currentViewedManga = null;
let isResolving = false;

function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return "";
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function init() {
    loadPreferences();
    await fetchData();
}

async function fetchData() {
    // Fetch config for settings logic
    try {
        const configRes = await fetch("http://localhost:3000/data/config");
        masterConfig = await configRes.json();

        if (masterConfig.settings) {
            const progToggle = document.getElementById("enableProgressSyncBtn");
            const addToggle = document.getElementById("enableAddNewMangaBtn");
            if (progToggle)
                progToggle.checked =
                    !!masterConfig.settings.enableProgressSyncBtn;
            if (addToggle)
                addToggle.checked =
                    !!masterConfig.settings.enableAddNewMangaBtn;
        }
    } catch (e) {
        console.error("Could not fetch config", e);
    }

    const libRes = await fetch("http://localhost:3000/data/library");
    libraryData = await libRes.json();
    const pendingRes = await fetch("http://localhost:3000/data/pending");
    pendingUpdates = await pendingRes.json();

    updateStats();
    populateGenreFilter();
    populateDynamicFilters();
    updateNotification();
    renderData();
}

function updateNotification() {
    const notif = document.getElementById("pendingNotification");
    if (pendingUpdates.length > 0) {
        notif.style.display = "block";
        document.getElementById("pendingCount").innerText =
            pendingUpdates.length;
    } else {
        notif.style.display = "none";
    }
}

function toggleGenreDropdown(id) {
    const dropdown = document.getElementById(id);
    const isCurrentlyShow = dropdown.classList.contains("show");

    document.querySelectorAll(".dropdown-content").forEach((d) => {
        d.classList.remove("show");
    });

    if (!isCurrentlyShow) {
        dropdown.classList.add("show");
    }
}

window.onclick = function (event) {
    if (
        !event.target.matches(".btn-std") &&
        !event.target.closest(".dropdown-content")
    ) {
        document.querySelectorAll(".dropdown-content").forEach((d) => {
            d.classList.remove("show");
        });
    }
};

function populateGenreFilter() {
    const genreSet = new Set();
    libraryData.forEach((manga) => {
        getParsedArray(manga.genres).forEach((g) => genreSet.add(g));
    });

    const genres = Array.from(genreSet).sort();

    const incList = document.getElementById("incGenresList");
    const excList = document.getElementById("excGenresList");

    const createItem = (genre, prefix) => `
                    <label onclick="event.stopPropagation()">
                        <input type="checkbox" class="${prefix}-chk" value="${escapeHtml(genre)}" onchange="renderData()">
                        ${escapeHtml(genre)}
                    </label>
                    `;

    incList.innerHTML = genres.map((g) => createItem(g, "inc")).join("");
    excList.innerHTML = genres.map((g) => createItem(g, "exc")).join("");
}

function populateDynamicFilters() {
    const statusFilter = document.getElementById("statusFilter");
    const websiteFilter = document.getElementById("websiteFilter");
    const typeFilter = document.getElementById("typeFilter");

    // Extract Unique Statuses
    const statuses = [...new Set(libraryData.map((m) => m.status))]
        .filter(Boolean)
        .sort();
    // Extract Unique Websites (domains)
    const websites = Array.from(
        new Set(
            libraryData
                .flatMap((m) => {
                    const parsed = getParsedArray(m.website);
                    return Array.isArray(parsed)
                        ? parsed.map((w) => w.trim())
                        : [];
                })
                .filter(Boolean),
        ),
    ).sort();
    // Extract Unique Types
    const types = [...new Set(libraryData.map((m) => m.type))]
        .filter(Boolean)
        .sort();

    // Clear existing except first option
    statusFilter.innerHTML =
        '<option value="">Status: All</option><option value="empty">Status: N/A</option>';
    websiteFilter.innerHTML =
        '<option value="">Website: All</option><option value="empty">Website: N/A</option>';
    typeFilter.innerHTML =
        '<option value="">Type: All</option><option value="empty">Type: N/A</option>';

    statuses.forEach((status) => {
        const opt = document.createElement("option");
        opt.value = status;
        opt.textContent = status;
        statusFilter.appendChild(opt);
    });

    websites.forEach((site) => {
        const opt = document.createElement("option");
        opt.value = site;
        opt.textContent = site;
        websiteFilter.appendChild(opt);
    });

    types.forEach((type) => {
        const opt = document.createElement("option");
        opt.value = type;
        opt.textContent = type;
        typeFilter.appendChild(opt);
    });
}

// --- SETTINGS & STATS ---
function loadPreferences() {
    const size = localStorage.getItem("libGridSize") || "270";
    const color = localStorage.getItem("libAccentColor") || "#38bdf8";
    document.getElementById("gridSizeSlider").value = size;
    document.getElementById("accentColorPicker").value = color;
    document.documentElement.style.setProperty("--grid-min", size + "px");
    document.documentElement.style.setProperty("--accent", color);
}
function updatePref(key, val, cssVar) {
    document.documentElement.style.setProperty(
        cssVar,
        val + (cssVar === "--grid-min" ? "px" : ""),
    );
    localStorage.setItem(key, val);
}

async function pushSettingsUpdate() {
    const progToggle = document.getElementById("enableProgressSyncBtn");
    const addToggle = document.getElementById("enableAddNewMangaBtn");

    if (!masterConfig.settings) masterConfig.settings = {};
    masterConfig.settings.enableProgressSyncBtn = progToggle.checked;
    masterConfig.settings.enableAddNewMangaBtn = addToggle.checked;

    try {
        await fetch("http://localhost:3000/data/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(masterConfig, null, 2),
        });
    } catch (e) {
        console.error("Failed to save settings", e);
    }
}

function openSettings() {
    document.getElementById("settingsOverlay").style.display = "block";
}
function closeSettings() {
    document.getElementById("settingsOverlay").style.display = "none";
}

function updateStats() {
    document.getElementById("statTotal").innerText = libraryData.length;
    let chs = 0;
    libraryData.forEach((m) => {
        const c = parseFloat(m.current_chapter);
        if (!isNaN(c)) chs += c;
    });
    document.getElementById("statChapters").innerText = Math.floor(chs);
}

async function cleanupCovers() {
    if (!confirm("Scan and delete orphaned covers?")) return;
    const res = await fetch(
        "http://localhost:3000/data/library/cleanup/covers",
        { method: "POST" },
    );
    const data = await res.json();
    alert(`Cleaned up ${data.deleted} orphaned cover images!`);
}

function exportLib() {
    const blob = new Blob([JSON.stringify(libraryData, null, 2)], {
        type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manga_library_backup.json";
    a.click();
}

function importLib(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const parsed = JSON.parse(event.target.result);
            await fetch("http://localhost:3000/data/library/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ library: parsed }),
            });
            alert("Import successful!");
            fetchData();
        } catch (err) {
            alert("Invalid JSON file.");
        }
    };
    reader.readAsText(file);
}

// --- VIEW TOGGLE ---
function toggleViewMode() {
    viewMode = viewMode === "grid" ? "table" : "grid";
    document.getElementById("viewToggleBtn").innerText =
        viewMode === "grid" ? "📊 Table Editor" : "🖼️ Grid View";
    renderData();
}

// --- FILTER & RENDER ---
function renderData() {
    document.getElementById("mangaGrid").style.display =
        viewMode === "grid" ? "grid" : "none";
    document.getElementById("tableView").style.display =
        viewMode === "table" ? "block" : "none";
    document.getElementById("detailView").style.display = "none";

    const search = document.getElementById("searchInput").value.toLowerCase();

    const incG = Array.from(document.querySelectorAll(".inc-chk:checked")).map(
        (c) => c.value.toLowerCase(),
    );
    const excG = Array.from(document.querySelectorAll(".exc-chk:checked")).map(
        (c) => c.value.toLowerCase(),
    );

    const nsfwF = document.getElementById("nsfwFilter").value;
    const sort = document.getElementById("sortSelect").value;

    const typeF = document.getElementById("typeFilter").value;
    const statusF = document.getElementById("statusFilter").value;
    const websiteF = document.getElementById("websiteFilter").value;

    let filtered = libraryData.filter((m) => {
        const isNsfw = m.nsfw === 1 || m.nsfw === "true" || m.nsfw === "1";
        if (nsfwF === "sfw" && isNsfw) return false;
        if (nsfwF === "nsfw" && !isNsfw) return false;

        const genres = getParsedArray(m.genres).map((g) => g.toLowerCase());
        if (incG.length > 0 && !incG.every((g) => genres.includes(g)))
            return false;
        if (excG.length > 0 && excG.some((g) => genres.includes(g)))
            return false;

        if (typeF === "empty") {
            if (m.type !== "" && m.type !== null) return false;
        } else if (typeF && m.type !== typeF) return false;
        if (statusF === "empty") {
            if (m.status !== "" && m.status !== null) return false;
        } else if (statusF && m.status !== statusF) return false;
        if (websiteF === "empty") {
            const sites = getParsedArray(m.website);
            if (sites.length > 0) return false;
        } else if (websiteF && !getParsedArray(m.website).includes(websiteF))
            return false;

        const alt = getParsedArray(m.alt_title).map((a) => a.toLowerCase());

        const titleSafe = (m.title || "").toLowerCase();
        return (
            titleSafe.includes(search) || alt.some((a) => a.includes(search))
        );
    });

    filtered.sort((a, b) => {
        if (sort === "updated_desc")
            return new Date(b.timestamp) - new Date(a.timestamp);
        if (sort === "title_asc")
            return (a.title || "")
                .toLowerCase()
                .localeCompare((b.title || "").toLowerCase());
        if (sort === "title_desc")
            return (b.title || "")
                .toLowerCase()
                .localeCompare((a.title || "").toLowerCase());
        if (sort === "rating_desc")
            return parseFloat(b.rating || 0) - parseFloat(a.rating || 0);
        if (sort === "year_desc")
            return (
                parseInt(b.release_year || 0) - parseInt(a.release_year || 0)
            );
        if (sort === "id_desc") return b.id - a.id;
        return 0;
    });

    if (viewMode === "grid") renderGrid(filtered);
    else renderTable(filtered);
}

function renderGrid(data) {
    const grid = document.getElementById("mangaGrid");
    grid.innerHTML = data
        .map((m) => {
            const isNsfw = m.nsfw == 1 || m.nsfw === "1" || m.nsfw === "true";
            const isSelected = selectedIds.has(m.id);
            return `
                    <div id="card-${m.id}" class="card ${isSelected ? "selected" : ""}" onclick="handleCardClick(event, ${m.id})">
                        <input type="checkbox" id="check-${m.id}" class="card-checkbox" ${isSelected ? "checked" : ""} onclick="toggleSelect(event, ${m.id})">
                        ${isNsfw ? '<div class="badge badge-nsfw">NSFW</div>' : ""}
                        ${m.type ? `<div class="badge badge-type">${escapeHtml(m.type)}</div>` : ""}
                        <img src="${escapeHtml(m.cover_image)}" class="card-img" onerror="this.src='http://localhost:3000/covers/placeholder.jpg';">
                        <div class="card-content">
                            <h4 class="card-title">${escapeHtml(m.title)}</h4>
                            <div class="card-meta">Ch. ${escapeHtml(m.current_chapter) || "0"} / ${escapeHtml(m.latest_chapter) || "?"}</div>
                            <div class="card-genres">${getParsedArray(m.genres)
                                .slice(0, 3)
                                .map(
                                    (g) =>
                                        `<span class="tag">${escapeHtml(g)}</span>`,
                                )
                                .join("")}</div>
                        </div>
                    </div>`;
        })
        .join("");
}

function renderTable(data) {
    const tbody = document.getElementById("tableBody");
    tbody.innerHTML = data
        .map((m) => {
            let siteLinksHtml = "";
            try {
                if (m.mappings) {
                    const mappings = JSON.parse(m.mappings);
                    const uniqueLinks = [];
                    mappings.forEach((mapping) => {
                        if (!mapping.url) return;
                        let faviconUrl = "";
                        try {
                            const webData = JSON.parse(mapping.website);
                            faviconUrl = webData.favicon || "";
                        } catch (e) {}

                        let iconHtml = faviconUrl
                            ? `<img src="http://localhost:3000${escapeHtml(faviconUrl)}" style="width: 16px; height: 16px; border-radius: 4px; vertical-align: middle; margin: 0; display: inline-block;">`
                            : `🔗`;

                        uniqueLinks.push(
                            `<a href="${escapeHtml(mapping.url)}" target="_blank" title="${escapeHtml(mapping.url)}" style="text-decoration: none; margin-left: 4px; border: 1px solid var(--secondary); border-radius: 5px; padding: 4px;">${iconHtml}</a>`,
                        );
                    });
                    siteLinksHtml = uniqueLinks.join(" ");
                }
            } catch (e) {
                siteLinksHtml = "⚠️";
            }

            return `
                    <tr>
                        <td style="color:var(--secondary)">${m.id}</td>
                        <td><img src="${escapeHtml(m.cover_image)}" onerror="this.src='http://localhost:3000/covers/placeholder.jpg';"></td>
                        <td><input type="text" value="${escapeHtml(m.title)}" onblur="inlineUpdate(${m.id}, 'title', this.value)"></td>
                        <td><input type="text" value="${escapeHtml(m.type)}" onblur="inlineUpdate(${m.id}, 'type', this.value)" style="width:70px"></td>
                        <td><input type="text" value="${escapeHtml(m.status)}" onblur="inlineUpdate(${m.id}, 'status', this.value)" style="width:80px"></td>
                        <td><input type="text" value="${escapeHtml(m.current_chapter)}" onblur="inlineUpdate(${m.id}, 'current_chapter', this.value)" style="width:50px"></td>
                        <td><input type="text" value="${escapeHtml(getParsedArray(m.genres).join(", "))}" onblur="inlineUpdate(${m.id}, 'genres', this.value)"></td>
                        <td style="white-space: nowrap;">${siteLinksHtml}</td>
                        <td><input type="text" value="${escapeHtml(getParsedArray(m.website).join(", "))}" onblur="inlineUpdate(${m.id}, 'website', this.value)"></td>
                    </tr>
                `;
        })
        .join("");
}

// --- INLINE & BULK EDITING ---
async function inlineUpdate(id, field, val) {
    const updates = {};
    if (["genres", "website"].includes(field)) {
        updates[field] = JSON.stringify(
            val
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
        );
    } else {
        updates[field] = val;
    }
    remoteLog("INFO", "UI", "INLINE_UPDATE", "index.html", {
        id,
        field,
        val,
    });
    await fetch("http://localhost:3000/data/library/entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, updates }),
    });
    const item = libraryData.find((m) => m.id === id);
    if (item) item[field] = updates[field];
}

function handleCardClick(e, id) {
    if (e.target.type === "checkbox") return;
    if (selectedIds.size > 0) {
        toggleSelect(e, id);
    } else {
        openDetail(id);
    }
}

function toggleSelect(e, id) {
    if (e) e.stopPropagation();

    const card = document.getElementById(`card-${id}`);
    const checkbox = document.getElementById(`check-${id}`);

    if (selectedIds.has(id)) {
        selectedIds.delete(id);
        if (card) card.classList.remove("selected");
        if (checkbox) checkbox.checked = false;
    } else {
        selectedIds.add(id);
        if (card) card.classList.add("selected");
        if (checkbox) checkbox.checked = true;
    }

    const bar = document.getElementById("bulkActionBar");
    if (selectedIds.size > 0) {
        bar.style.display = "flex";
        document.getElementById("bulkCount").innerText =
            `${selectedIds.size} selected`;
    } else {
        bar.style.display = "none";
    }
}

function clearSelection() {
    selectedIds.forEach((id) => {
        const card = document.getElementById(`card-${id}`);
        const checkbox = document.getElementById(`check-${id}`);
        if (card) card.classList.remove("selected");
        if (checkbox) checkbox.checked = false;
    });
    selectedIds.clear();
    document.getElementById("bulkActionBar").style.display = "none";
}

async function bulkAction(action, val = null) {
    if (
        action === "delete" &&
        !confirm(`Delete ${selectedIds.size} bookmarks?`)
    )
        return;

    remoteLog("WARN", "UI", "BULK_ACTION_INIT", "index.html", {
        action,
        val,
        count: selectedIds.size,
    });
    await fetch("http://localhost:3000/data/library/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ids: Array.from(selectedIds),
            action,
            value: val,
        }),
    });
    clearSelection();
    fetchData();
}

async function bulkActionType() {
    const type = prompt("Enter Type (Manga, Manhwa, Manhua):", "Manhwa");
    if (type !== null) bulkAction("type", type);
}

// --- DETAIL VIEW ---
function openDetail(id) {
    currentViewedManga = libraryData.find((m) => m.id === id);
    isEditing = false;
    document.getElementById("mangaGrid").style.display = "none";
    document.getElementById("controlsBar").style.display = "none";
    document.getElementById("detailView").style.display = "block";

    const btn = document.getElementById("btnEditMetadata");
    btn.innerText = "✏️ Edit Metadata";
    btn.style.background = "var(--accent)";

    document.getElementById("detailContent").innerHTML =
        renderDetailContent(currentViewedManga);
}

function closeDetail() {
    renderData();
    document.getElementById("controlsBar").style.display = "flex";
}

function renderDetailContent(m) {
    const genres = getParsedArray(m.genres);
    let altTitles = getParsedArray(m.alt_title);
    let authors = getParsedArray(m.author);
    let artists = getParsedArray(m.artist);
    const isNsfw = m.nsfw == 1 || m.nsfw === "true" || m.nsfw === "1";

    let siteLinksHtml = "";
    try {
        if (m.mappings) {
            const mappings = JSON.parse(m.mappings);
            const uniqueLinks = [];
            mappings.forEach((mapping) => {
                if (!mapping.url) return;
                let siteName = "Unknown Site";
                let faviconUrl = "";
                try {
                    const webData = JSON.parse(mapping.website);
                    siteName = webData.name || webData.id || siteName;
                    faviconUrl = webData.favicon || "";
                } catch (e) {
                    siteName = mapping.website || new URL(mapping.url).hostname;
                }

                let iconHtml = faviconUrl
                    ? `<img src="http://localhost:3000${escapeHtml(faviconUrl)}" style="width: 14px; height: 14px; border-radius: 2px; vertical-align: middle;">`
                    : `🔗`;

                uniqueLinks.push(
                    `<a href="${escapeHtml(mapping.url)}" target="_blank" style="background: var(--card); border: 1px solid var(--accent); color: var(--accent); padding: 5px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: bold; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px;">${iconHtml} ${escapeHtml(siteName)}</a>`,
                );
            });
            siteLinksHtml =
                uniqueLinks.length > 0
                    ? uniqueLinks.join(" ")
                    : "<span style='color: var(--secondary);'>No links available</span>";
        }
    } catch (e) {
        siteLinksHtml =
            "<span style='color: var(--danger);'>Error parsing links</span>";
    }

    const genreTags = genres
        .map((g) => `<span class="tag">${escapeHtml(g)}</span>`)
        .join("");

    if (isEditing) {
        return `
                    <div class="detail-header">
                        <img src="${escapeHtml(m.cover_image)}" class="detail-cover" onerror="this.onerror=null; this.src='http://localhost:3000/covers/placeholder.jpg';">
                        <div class="detail-info" style="flex:1;">
                            <label>Title</label>
                            <input type="text" class="edit-input" id="editTitle" value="${escapeHtml(m.title)}">

                            <label>Type (Manga, Manhwa, Manhua)</label>
                            <input type="text" class="edit-input" id="editType" value="${escapeHtml(m.type)}">

                            <label>Alt Titles (Comma separated)</label>
                            <input type="text" class="edit-input" id="editAltTitle" value="${escapeHtml(altTitles.join(", "))}">

                            <label>Status</label>
                            <input type="text" class="edit-input" id="editStatus" value="${escapeHtml(m.status)}">

                            <label>Release Year</label>
                            <input type="text" class="edit-input" id="editReleaseYear" value="${escapeHtml(m.release_year)}">

                            <label>Rating</label>
                            <input type="text" class="edit-input" id="editRating" value="${escapeHtml(m.rating)}">

                            <label>Author(s) (Comma separated)</label>
                            <input type="text" class="edit-input" id="editAuthor" value="${escapeHtml(authors.join(", "))}">

                            <label>Artist(s) (Comma separated)</label>
                            <input type="text" class="edit-input" id="editArtist" value="${escapeHtml(artists.join(", "))}">

                            <label>Genres (Comma separated)</label>
                            <input type="text" class="edit-input" id="editGenres" value="${escapeHtml(genres.join(", "))}">
                        </div>
                    </div>
                    <div style="background: #1e293b; padding: 20px; border-radius: 8px;">
                        <label>Summary</label>
                        <textarea class="edit-input" id="editSummary">${escapeHtml(m.summary)}</textarea>
                    </div>`;
    }

    return `
                <div class="detail-header">
                    <img src="${escapeHtml(m.cover_image)}" alt="Cover" class="detail-cover" onerror="this.onerror=null; this.src='http://localhost:3000/covers/placeholder.jpg';">
                    <div class="detail-info">
                        <h1>${escapeHtml(m.title)} <span style="font-size:14px; color:white; background:var(--secondary); padding:4px 8px; border-radius:4px; vertical-align:middle; margin-left:10px;">${escapeHtml(m.type) || "Unknown Type"}</span></h1>
                        ${altTitles.length > 0 ? `<p><strong>Alt Titles:</strong> ${escapeHtml(altTitles.join(" ; "))}</p>` : ""}

                        <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 10px 0;">
                            <strong style="color: white;">Site Links:</strong> ${siteLinksHtml}
                        </div>

                        <p><strong>Status:</strong> ${escapeHtml(m.status) || "Unknown"} | <strong>Release Year:</strong> ${escapeHtml(m.release_year) || "Unknown"}</p>
                        <p><strong>Progress:</strong> Chapter ${escapeHtml(m.current_chapter) || "0"} / ${escapeHtml(m.latest_chapter) || "?"}</p>
                        <p><strong>Rating:</strong> ${escapeHtml(m.rating) || "N/A"}</p>
                        <p><strong>Author:</strong> ${escapeHtml(authors.join(", ")) || "Unknown"} | <strong>Artist:</strong> ${escapeHtml(artists.join(", ")) || "Unknown"}</p>
                        <div style="margin: 15px 0; display: flex; flex-wrap: wrap; gap: 4px;">${genreTags}</div>
                        <p><strong>Last Updated:</strong> ${escapeHtml(m.latest_chapter_update_date) || "Unknown"} </p>
                        <p><strong>Timestamp:</strong> ${escapeHtml(m.timestamp) || "Unknown"}</p>

                        <div style="margin-top: 20px; display: flex; gap: 15px; align-items: center;">
                            <label style="color:var(--danger); font-weight:bold; cursor:pointer; background: #334155; padding: 8px 12px; border-radius: 6px; display: inline-flex; align-items: center; gap: 8px; user-select: none;">
                                <input type="checkbox" ${isNsfw ? "checked" : ""} onchange="toggleNsfw(this.checked, ${m.id})"> Mark as NSFW
                            </label>
                        </div>
                    </div>
                </div>
                <div style="background: #1e293b; padding: 20px; border-radius: 8px;">
                    <h3 style="margin-top:0; color:var(--accent);">Summary</h3>
                    <p style="line-height: 1.6; color: #cbd5e1;">${escapeHtml(m.summary) || "No summary available."}</p>
                </div>`;
}

function openMergeUI() {
    if (pendingUpdates.length === 0) return;
    document.getElementById("mergeCounter").innerText =
        `${pendingUpdates.length} left`;
    const update = pendingUpdates[0];
    const currentManga = libraryData.find((m) => m.id === update.bookmark_id);

    const fallbackTitle = currentManga ? currentManga.title : "Unknown Manga";

    const proposed = JSON.parse(update.proposed_data);

    document.getElementById("mergeMeta").innerText =
        `Editing: ${fallbackTitle}\n\nSource: ${update.source_url}\n`;
    const container = document.getElementById("compareContainer");
    container.innerHTML = "";

    document.getElementById("btnCreateNewEntry").onclick = () =>
        createNewEntry(update.id);
    document.getElementById("btnDiscardMerge").onclick = () =>
        discardMerge(update.id);

    Object.keys(proposed).forEach((field) => {
        const currentVal = currentManga ? currentManga[field] || "" : "";
        const proposedVal = proposed[field];
        let displayProposed = Array.isArray(proposedVal)
            ? proposedVal.join(", ")
            : proposedVal;
        let displayCurrent = currentVal;
        try {
            let parsedCurrent = JSON.parse(currentVal);
            if (Array.isArray(parsedCurrent))
                displayCurrent = parsedCurrent.join(", ");
        } catch (e) {}

        const coverImgStyle =
            "width: 80px; height: 120px; object-fit: cover; border-radius: 4px; display: block;";
        if (field === "cover_image") {
            displayCurrent = currentVal
                ? `<div style="display: inline-block; text-align: center;">
                                <img src="${currentVal}" style="${coverImgStyle}" onload="this.nextElementSibling.innerText = this.naturalWidth + ' × ' + this.naturalHeight + ' px'">
                                <div style="font-size: 10px; color: var(--secondary); margin-top: 4px; font-weight: bold;">Loading...</div>
                                </div>`
                : "None";

            // Use proxy to preview proposed external images to bypass 403s without saving
            let proposedSrc = proposedVal;
            if (
                proposedVal &&
                proposedVal.startsWith("http") &&
                !proposedVal.includes("localhost:3000")
            ) {
                proposedSrc = `http://localhost:3000/proxy-image?url=${encodeURIComponent(proposedVal)}`;
            }

            displayProposed = proposedVal
                ? `<div style="display: inline-block; text-align: center;">
                                <img src="${proposedSrc}" style="${coverImgStyle}" onload="this.nextElementSibling.innerText = this.naturalWidth + ' × ' + this.naturalHeight + ' px'">
                                <div style="font-size: 10px; color: var(--secondary); margin-top: 4px; font-weight: bold;">Loading...</div>
                                </div>`
                : "None";
        } else {
            displayCurrent = escapeHtml(displayCurrent);
            displayProposed = escapeHtml(displayProposed);
        }

        const row = document.createElement("div");
        row.className = "compare-row";
        row.innerHTML = `
                    <div><b>${field.toUpperCase()}</b></div>
                    <div class="val-box"><i>Current:</i><br><br>${displayCurrent || "Empty"}</div>
                    <div class="val-box"><i>Proposed:</i><br><br>${displayProposed}</div>
                    <div class="btn-group">
                        <button type="button" class="btn-keep" onclick="resolveField(event, this, ${update.id}, '${field}', 'keep')">Keep Old</button>
                        <button type="button" class="btn-replace" onclick="resolveField(event, this, ${update.id}, '${field}', 'replace')">Overwrite</button>
                        ${Array.isArray(proposedVal) ? `<button type="button" class="btn-merge" onclick="resolveField(event, this, ${update.id}, '${field}', 'merge')">Merge Arrays</button>` : ""}
                    </div>
                `;
        container.appendChild(row);
    });
    document.getElementById("mergeOverlay").style.display = "block";
}

async function createNewEntry(updateId) {
    if (isResolving) return;
    isResolving = true;
    const btn = document.getElementById("btnCreateNewEntry");
    const originalText = btn.innerText;
    btn.innerText = "Creating...";
    btn.disabled = true;

    try {
        await fetch("http://localhost:3000/data/pending/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                updateId: updateId,
                action: "create_new",
            }),
        });
        const libRes = await fetch("http://localhost:3000/data/library");
        libraryData = await libRes.json();
        const pendingRes = await fetch("http://localhost:3000/data/pending");
        pendingUpdates = await pendingRes.json();
        updateNotification();
        renderData();
        if (pendingUpdates.length > 0) openMergeUI();
        else closeMerge();
    } finally {
        isResolving = false;
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function discardMerge(updateId) {
    if (isResolving) return;
    isResolving = true;
    const btn = document.getElementById("btnDiscardMerge");
    const originalText = btn.innerText;
    btn.innerText = "Discarding...";
    btn.disabled = true;

    try {
        await fetch("http://localhost:3000/data/pending/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                updateId: updateId,
                action: "discard",
            }),
        });
        const libRes = await fetch("http://localhost:3000/data/library");
        libraryData = await libRes.json();
        const pendingRes = await fetch("http://localhost:3000/data/pending");
        pendingUpdates = await pendingRes.json();
        updateNotification();
        renderData();
        if (pendingUpdates.length > 0) openMergeUI();
        else closeMerge();
    } finally {
        isResolving = false;
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function resolveField(event, btnElement, updateId, field, action) {
    event.preventDefault();
    event.stopPropagation();
    if (isResolving) return;
    isResolving = true;

    const row = btnElement.closest(".compare-row");
    const allButtons = row.querySelectorAll("button");
    allButtons.forEach((b) => (b.disabled = true));
    btnElement.innerText = "Processing...";
    remoteLog("INFO", "UI", "RESOLVE_MERGE_FIELD", "index.html", {
        updateId,
        field,
        action,
    });

    try {
        await fetch("http://localhost:3000/data/pending/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updateId, field, action }),
        });
        row.remove();
        const container = document.getElementById("compareContainer");
        if (container.querySelectorAll(".compare-row").length === 0) {
            const libRes = await fetch("http://localhost:3000/data/library");
            libraryData = await libRes.json();
            const pendingRes = await fetch(
                "http://localhost:3000/data/pending",
            );
            pendingUpdates = await pendingRes.json();
            updateNotification();
            renderData();
            if (pendingUpdates.length > 0) openMergeUI();
            else closeMerge();
        }
    } catch (e) {
        remoteLog("ERROR", "API", "RESOLVE_MERGE_ERROR", "index.html", {
            error: err.message,
            updateId,
        });
    } finally {
        isResolving = false;
    }
}

function closeMerge() {
    document.getElementById("mergeOverlay").style.display = "none";
}

document.getElementById("btnEditMetadata").onclick = async function () {
    if (!currentViewedManga) return;
    if (isEditing) {
        this.innerText = "Saving...";
        const splitAndTrim = (str) =>
            str
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

        const updates = {
            title: document.getElementById("editTitle").value,
            type: document.getElementById("editType").value,
            alt_title: splitAndTrim(
                document.getElementById("editAltTitle").value,
            ),
            status: document.getElementById("editStatus").value,
            release_year: document.getElementById("editReleaseYear").value,
            rating: document.getElementById("editRating").value,
            author: splitAndTrim(document.getElementById("editAuthor").value),
            artist: splitAndTrim(document.getElementById("editArtist").value),
            genres: splitAndTrim(document.getElementById("editGenres").value),
            summary: document.getElementById("editSummary").value,
        };

        await fetch("http://localhost:3000/data/library/entry", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: currentViewedManga.id,
                updates,
            }),
        });
        await fetchData();
        this.innerText = "✏️ Edit Metadata";
        this.style.background = "var(--accent)";
        openDetail(currentViewedManga.id);
    } else {
        isEditing = true;
        this.innerText = "💾 Save Changes";
        this.style.background = "var(--success)";
        document.getElementById("detailContent").innerHTML =
            renderDetailContent(currentViewedManga);
    }
};

async function toggleNsfw(isNsfw, id) {
    const val = isNsfw ? 1 : 0;
    await fetch("http://localhost:3000/data/library/entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id, nsfw: val }),
    });
    const manga = libraryData.find((m) => m.id === id);
    if (manga) manga.nsfw = val;

    if (document.getElementById("mangaGrid").style.display !== "none") {
        renderData();
    }
}

init();
