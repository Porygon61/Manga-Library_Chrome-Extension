const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const axios = require("axios");
const {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdir,
    unlinkSync,
} = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, "manga_db.sqlite");
const CONFIG_PATH = path.join(__dirname, "config.json");
const COVERS_DIR = path.join(__dirname, "covers");
const FAVICONS_DIR = path.join(__dirname, "favicons");

if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });
if (!existsSync(FAVICONS_DIR)) mkdirSync(FAVICONS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/covers", express.static(COVERS_DIR));
app.use("/favicons", express.static(FAVICONS_DIR));

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("❌ Database connection error:", err.message);
    } else {
        db.run("PRAGMA journal_mode = WAL;");
        db.run("PRAGMA synchronous = NORMAL;");
        db.configure("busyTimeout", 5000);
    }
});

db.on("error", (err) => {
    console.error("🔥 Global Database Error:", err);
});

/**
 * NORMALIZATION HELPERS
 */
function normalizeDate(dateStr) {
    if (!dateStr) return null;
    dateStr = dateStr.toString().trim().toLowerCase();
    const now = new Date();
    let parsedDate = new Date(dateStr);

    if (dateStr.includes("ago")) {
        const match = dateStr.match(
            /(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago/i,
        );
        if (match) {
            const amount = parseInt(match[1]);
            const unit = match[2];
            const multiplier = {
                year: 31536000000,
                month: 2592000000,
                week: 604800000,
                day: 86400000,
                hour: 3600000,
                minute: 60000,
                second: 1000,
            };
            parsedDate = new Date(now.getTime() - amount * multiplier[unit]);
        }
    } else if (dateStr === "today") {
        parsedDate = now;
    } else if (dateStr === "yesterday") {
        parsedDate = new Date(now.getTime() - 86400000);
    }

    if (!isNaN(parsedDate)) {
        return parsedDate.toISOString().split("T")[0];
    }
    return dateStr;
}

function toTitleCase(str) {
    if (!str) return str;
    return str.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(),
    );
}

async function normalizeEntryData(entry) {
    let extractedType = null;
    const typeKeywords = ["manga", "manhwa", "manhua"];

    const getMappings = (type) =>
        new Promise((resolve) => {
            const mainT = type + "s";
            const mapT = type + "_mapping";
            const idCol = type + "_id";
            const query =
                type === "genre"
                    ? `SELECT m.name as alias, t.name as main, t.nsfw FROM ${mapT} m JOIN ${mainT} t ON m.${idCol} = t.id`
                    : `SELECT m.name as alias, t.name as main, 0 as nsfw FROM ${mapT} m JOIN ${mainT} t ON m.${idCol} = t.id`;
            db.all(query, (err, rows) => resolve(rows || []));
        });

    const getMainEntities = (type) =>
        new Promise((resolve) => {
            db.all(`SELECT * FROM ${type}s`, (err, rows) =>
                resolve(rows || []),
            );
        });

    const genreMap = await getMappings("genre");
    const authorMap = await getMappings("author");
    const artistMap = await getMappings("artist");

    // Fetch all main entities so we know what already exists
    const mainGenres = await getMainEntities("genre");
    const mainAuthors = await getMainEntities("author");
    const mainArtists = await getMainEntities("artist");

    // Made this async so we can safely await database insertions
    const mapItems = async (
        itemsStr,
        mappings,
        mainList,
        isGenre,
        typeName,
    ) => {
        if (!itemsStr) return [];
        let parsed = [];
        try {
            parsed = Array.isArray(itemsStr) ? itemsStr : JSON.parse(itemsStr);
        } catch (e) {
            parsed =
                typeof itemsStr === "string"
                    ? itemsStr.split(",").map((s) => s.trim())
                    : [itemsStr];
        }

        let result = [];
        for (const item of parsed) {
            if (!item) continue;
            let cleanItem = item.toString().trim();
            let lowerItem = cleanItem.toLowerCase();

            if (isGenre && typeKeywords.includes(lowerItem)) {
                extractedType = toTitleCase(cleanItem);
                continue; // Skip adding type to genres
            }

            const matchedAlias = mappings.find(
                (m) => m.alias.toLowerCase() === lowerItem,
            );
            if (matchedAlias) {
                if (matchedAlias.main.toUpperCase() === "IGNORE") {
                    continue;
                }
                result.push(matchedAlias.main);
                if (isGenre && matchedAlias.nsfw === 1) entry.nsfw = 1;
            } else {
                const matchedMain = mainList.find(
                    (m) => m.name.toLowerCase() === lowerItem,
                );
                if (isGenre && matchedMain && matchedMain.nsfw === 1) {
                    entry.nsfw = 1;
                }

                // NEW: Auto-insert if completely unknown
                if (!matchedMain && cleanItem !== "") {
                    const titleCased = toTitleCase(cleanItem);
                    await new Promise((resolve) => {
                        const insertSql = isGenre
                            ? `INSERT OR IGNORE INTO ${typeName}s (name, nsfw) VALUES (?, 0)`
                            : `INSERT OR IGNORE INTO ${typeName}s (name) VALUES (?)`;
                        db.run(insertSql, [titleCased], () => resolve());
                    });
                    // Optimistically add to list for this run
                    mainList.push({ name: titleCased, nsfw: 0 });
                }
                if (toTitleCase(cleanItem).toUpperCase() === "IGNORE") continue;

                result.push(toTitleCase(cleanItem));
            }
        }
        return [...new Set(result)];
    };

    // Note the 'await' and the 'typeName' string passed at the end
    entry.genres = JSON.stringify(
        await mapItems(entry.genres, genreMap, mainGenres, true, "genre"),
    );
    entry.author = JSON.stringify(
        await mapItems(entry.author, authorMap, mainAuthors, false, "author"),
    );
    entry.artist = JSON.stringify(
        await mapItems(entry.artist, artistMap, mainArtists, false, "artist"),
    );

    if (extractedType && (!entry.type || entry.type.trim() === ""))
        entry.type = extractedType;
    else if (entry.type) entry.type = toTitleCase(entry.type.trim());

    if (entry.status) entry.status = toTitleCase(entry.status.trim());
    if (entry.website) entry.website = entry.website.toLowerCase().trim();

    return entry;
}

/**
 * MIGRATION ENGINE
 */
function syncTableSchema() {
    if (!existsSync(CONFIG_PATH)) return;
    try {
        const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        const tables = config.db?.tables;

        db.serialize(() => {
            db.run("PRAGMA foreign_keys = ON");
            for (const [tableName, schema] of Object.entries(tables)) {
                const columnEntries = Object.entries(schema).filter(
                    ([k]) => !k.startsWith("FOREIGN KEY"),
                );
                const foreignKeyEntries = Object.entries(schema).filter(([k]) =>
                    k.startsWith("FOREIGN KEY"),
                );
                const colDefinitions = columnEntries
                    .map(([c, t]) => `"${c}" ${t}`)
                    .join(", ");
                const constraints = foreignKeyEntries
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ");
                const fullSchema = constraints
                    ? `${colDefinitions}, ${constraints}`
                    : colDefinitions;

                db.run(
                    `CREATE TABLE IF NOT EXISTS ${tableName} (${fullSchema})`,
                );

                db.all(
                    `PRAGMA table_info(${tableName})`,
                    (err, existingCols) => {
                        if (err) return;
                        const existingNames = existingCols.map((c) => c.name);
                        columnEntries.forEach(([colName, colType]) => {
                            if (!existingNames.includes(colName)) {
                                db.run(
                                    `ALTER TABLE ${tableName} ADD COLUMN "${colName}" ${colType}`,
                                );
                            }
                        });
                    },
                );
            }
        });
    } catch (e) {
        console.error("❌ Schema Error:", e.message);
    }
}
syncTableSchema();

/**
 * LOGGING
 */

function sysLog(level, category, action, source, data = null) {
    const dataStr = data ? JSON.stringify(data) : null;
    db.run(
        `INSERT INTO logs (level, category, action, source, data) VALUES (?, ?, ?, ?, ?)`,
        [level, category, action, source, dataStr],
    );
    console.log(
        `[${new Date().toLocaleString()}] ${level} [${category}]: ${action}`,
    );
}

app.use((req, res, next) => {
    // Log the incoming request
    sysLog("INFO", "API", req.method, req.originalUrl, {
        body: req.body,
        params: req.params,
        query: req.query,
    });
    next();
});

app.post("/data/logs", (req, res) => {
    const { level, category, action, source, data } = req.body;
    sysLog(level, category, action, source, data);
    res.json({ success: true });
});

/**
 * ASSET MANAGEMENT
 */
async function downloadFavicon(url) {
    try {
        const domain = new URL(url).hostname;
        const filename = `${domain}.png`;
        const filePath = path.join(FAVICONS_DIR, filename);
        if (existsSync(filePath)) return `/favicons/${filename}`;

        const iconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
        const response = await axios({
            url: iconUrl,
            method: "GET",
            responseType: "stream",
        });
        const writer = createWriteStream(filePath);
        response.data.pipe(writer);
        return new Promise((resolve) => {
            writer.on("finish", () => resolve(`/favicons/${filename}`));
            writer.on("error", () => resolve(null));
        });
    } catch (e) {
        return null;
    }
}

async function downloadCover(url) {
    if (!url || !url.startsWith("http")) return url;
    if (url.includes("localhost:3000/covers/")) return url;

    const filename = crypto.randomUUID() + ".jpg";
    const filePath = path.join(COVERS_DIR, filename);

    const headers = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: new URL(url).origin + "/",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    };

    try {
        const response = await axios({
            url,
            method: "GET",
            responseType: "stream",
            timeout: 10000,
            headers: headers,
        });
        const writer = createWriteStream(filePath);
        response.data.pipe(writer);
        return await new Promise((resolve, reject) => {
            writer.on("finish", () =>
                resolve(`http://localhost:3000/covers/${filename}`),
            );
            writer.on("error", (e) => reject(e));
        });
    } catch (e) {
        console.error(`❌ Failed to download cover [${url}]:`, e.message);
        return "";
    }
}

async function linkUrl(bookmarkId, url, websiteName, res) {
    const faviconPath = await downloadFavicon(url);
    const domain = new URL(url).hostname.replace("www.", "");
    const websiteObj = JSON.stringify({
        id: domain,
        name: websiteName,
        favicon: faviconPath,
    });

    const sql = `INSERT OR IGNORE INTO url_mapping (bookmark_id, url, website) VALUES (?, ?, ?)`;
    db.run(sql, [bookmarkId, url, websiteObj], function (err) {
        if (err && res) return res.status(500).json({ error: err.message });
        if (res) res.json({ success: true, bookmarkId: bookmarkId });
    });
}

/**
 * ENDPOINTS
 */

/* MAPPING ENDPOINTS */
app.get("/data/mappings/:type", (req, res) => {
    const type = req.params.type;
    const mainTable = type + "s";
    const mapTable = type + "_mapping";
    const idCol = type + "_id";

    db.all(
        `SELECT t.id, t.name, ${type === "genre" ? "t.nsfw" : "0 as nsfw"}, json_group_array(m.name) as aliases 
            FROM ${mainTable} t LEFT JOIN ${mapTable} m ON t.id = m.${idCol} GROUP BY t.id`,
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            rows = rows.map((r) => {
                let aliases = JSON.parse(r.aliases);
                if (aliases.length === 1 && aliases[0] === null) aliases = [];
                return { ...r, aliases };
            });
            res.json(rows);
        },
    );
});

app.patch("/data/mappings/:type/main/:id", (req, res) => {
    const table = req.params.type + "s";
    db.run(
        `UPDATE ${table} SET nsfw = ? WHERE id = ?`,
        [req.body.nsfw ? 1 : 0, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        },
    );
});

app.post("/data/mappings/:type/alias", (req, res) => {
    const { mainId, alias } = req.body;
    const mapTable = req.params.type + "_mapping";
    const mainTable = req.params.type + "s";
    const idCol = req.params.type + "_id";

    db.serialize(() => {
        db.run(
            `INSERT INTO ${mapTable} (name, ${idCol}) VALUES (?, ?)`,
            [alias, mainId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run(
                    `DELETE FROM ${mainTable} WHERE name = ?`,
                    [alias],
                    () => {
                        res.json({ success: true });
                    },
                );
            },
        );
    });
});

app.delete("/data/mappings/:type/alias/:name", (req, res) => {
    const mapTable = req.params.type + "_mapping";
    db.run(
        `DELETE FROM ${mapTable} WHERE name = ?`,
        [req.params.name],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        },
    );
});
/* END MAPPING ENDPOINTS */

/* PROXY ENDPOINT */
app.get("/proxy-image", async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl || imageUrl === "undefined" || imageUrl === "null") {
        return res.status(400).send("No valid URL provided");
    }

    try {
        let origin = "https://google.com";
        try {
            origin = new URL(imageUrl).origin + "/";
        } catch (e) {
            console.error("Malformed URL passed to proxy:", imageUrl);
        }

        const headers = {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Referer: origin,
            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        };

        const response = await axios({
            url: imageUrl,
            method: "GET",
            responseType: "stream",
            timeout: 15000,
            headers: headers,
            validateStatus: false,
        });

        if (response.headers["content-type"]) {
            res.setHeader("Content-Type", response.headers["content-type"]);
        }

        response.data.pipe(res);
    } catch (error) {
        console.error(`❌ Proxy crash for [${imageUrl}]:`, error.message);
        res.status(404).send("Image could not be proxied");
    }
});
/* END PROXY ENDPOINT */

app.get("/data/config", (req, res) => {
    if (existsSync(CONFIG_PATH))
        res.json(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    else res.status(404).json({ error: "Config not found" });
});

app.post("/data/config", (req, res) => {
    try {
        require("fs").writeFileSync(
            CONFIG_PATH,
            JSON.stringify(req.body, null, 2),
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/data/library/search", (req, res) => {
    const { url } = req.body;
    const sql = `SELECT b.* FROM bookmarks b JOIN url_mapping m ON b.id = m.bookmark_id WHERE m.url = ?`;
    db.get(sql, [url], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || null);
    });
});

app.post("/data/library/entry", async (req, res) => {
    let { url, entry, delete: isDelete } = req.body;

    if (isDelete) {
        db.get(
            `SELECT bookmark_id FROM url_mapping WHERE url = ?`,
            [url],
            (err, row) => {
                if (row) {
                    db.run(`DELETE FROM bookmarks WHERE id = ?`, [
                        row.bookmark_id,
                    ]);
                    db.run(`DELETE FROM url_mapping WHERE bookmark_id = ?`, [
                        row.bookmark_id,
                    ]);
                    db.run(
                        `DELETE FROM pending_updates WHERE bookmark_id = ?`,
                        [row.bookmark_id],
                    );
                }
                return res.json({ success: true });
            },
        );
        return;
    }

    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    if (entry.latest_chapter_update_date) {
        entry.latest_chapter_update_date = normalizeDate(
            entry.latest_chapter_update_date,
        );
    }

    entry = await normalizeEntryData(entry);

    const originalWebsite = entry.website;

    db.get(
        `SELECT bookmark_id FROM url_mapping WHERE url = ?`,
        [url],
        (err, mappingRow) => {
            if (err) return res.status(500).json({ error: err.message });

            db.all("SELECT * FROM bookmarks", async (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });

                let existingManga = null;

                if (mappingRow) {
                    existingManga = rows.find(
                        (row) => row.id === mappingRow.bookmark_id,
                    );
                }

                if (!existingManga) {
                    existingManga = rows.find((row) => {
                        const dbMainTitle = row.title
                            ? row.title
                                  .toLowerCase()
                                  .trim()
                                  .replace(/[’‘`]/g, "'")
                            : null;
                        let dbAltTitles = [];
                        try {
                            dbAltTitles = JSON.parse(row.alt_title || "[]")
                                .filter((t) => t != null)
                                .map((t) =>
                                    t
                                        .toString()
                                        .toLowerCase()
                                        .trim()
                                        .replace(/[’‘`]/g, "'"),
                                )
                                .filter((t) => t !== "" && t !== "none");
                        } catch (e) {}

                        const incomingMainTitle = entry.title
                            ? entry.title
                                  .toLowerCase()
                                  .trim()
                                  .replace(/[’‘`]/g, "'")
                            : null;
                        let incomingAltTitles = [];
                        try {
                            const rawAlt = Array.isArray(entry.alt_title)
                                ? entry.alt_title
                                : JSON.parse(entry.alt_title || "[]");
                            incomingAltTitles = rawAlt
                                .filter((t) => t != null)
                                .map((t) =>
                                    t
                                        .toString()
                                        .toLowerCase()
                                        .trim()
                                        .replace(/[’‘`]/g, "'"),
                                )
                                .filter((t) => t !== "" && t !== "none");
                        } catch (e) {}

                        const mainMatch =
                            dbMainTitle &&
                            incomingMainTitle &&
                            dbMainTitle === incomingMainTitle;
                        const incomingMainInDbAlts =
                            incomingMainTitle &&
                            dbAltTitles.includes(incomingMainTitle);
                        const altMatch = incomingAltTitles.some((t) => {
                            if (!t) return false;
                            return t === dbMainTitle || dbAltTitles.includes(t);
                        });

                        return mainMatch || incomingMainInDbAlts || altMatch;
                    });
                }

                if (existingManga) {
                    let conflicts = {};

                    config.settings.validation.requires_approval.forEach(
                        (field) => {
                            const existingVal = existingManga[field] || "";
                            const incomingVal = entry[field];

                            if (field === "cover_image" && incomingVal) {
                                if (
                                    !existingVal.includes(incomingVal) &&
                                    incomingVal.startsWith("http") &&
                                    !incomingVal.includes(
                                        "localhost:3000/covers/",
                                    )
                                ) {
                                    conflicts[field] = incomingVal;
                                }
                            } else if (
                                field !== "summary" && // Prevent summary strings starting with [ from acting like arrays
                                (Array.isArray(incomingVal) ||
                                    (typeof incomingVal === "string" &&
                                        incomingVal.startsWith("[")))
                            ) {
                                let existingArr = [];
                                try {
                                    existingArr = JSON.parse(existingVal);
                                } catch (e) {
                                    existingArr = existingVal
                                        ? [existingVal]
                                        : [];
                                }
                                let incomingArr = [];
                                try {
                                    incomingArr = Array.isArray(incomingVal)
                                        ? incomingVal
                                        : JSON.parse(incomingVal);
                                } catch (e) {
                                    incomingArr = [incomingVal];
                                }

                                const existingSorted = [...existingArr]
                                    .sort()
                                    .join("|");
                                const incomingSorted = [...incomingArr]
                                    .sort()
                                    .join("|");

                                if (
                                    incomingArr.length > 0 &&
                                    existingSorted !== incomingSorted
                                ) {
                                    conflicts[field] = incomingArr;
                                }
                            } else if (
                                incomingVal &&
                                existingVal !== incomingVal
                            ) {
                                conflicts[field] = incomingVal;
                            }
                        },
                    );

                    if (Object.keys(conflicts).length > 0) {
                        db.run(
                            `INSERT INTO pending_updates (bookmark_id, proposed_data, full_entry, source_url) VALUES (?, ?, ?, ?)`,
                            [
                                existingManga.id,
                                JSON.stringify(conflicts),
                                JSON.stringify(entry),
                                url,
                            ],
                        );
                    }

                    if (entry.website) {
                        let existingWebsites = [];
                        try {
                            existingWebsites = JSON.parse(
                                existingManga.website || "[]",
                            );
                        } catch (e) {
                            existingWebsites = [existingManga.website].filter(
                                Boolean,
                            );
                        }
                        if (!existingWebsites.includes(entry.website)) {
                            existingWebsites.push(entry.website);
                            db.run(
                                `UPDATE bookmarks SET website = ? WHERE id = ?`,
                                [
                                    JSON.stringify(existingWebsites),
                                    existingManga.id,
                                ],
                                (err) => {
                                    if (!err)
                                        sysLog(
                                            "INFO",
                                            "DB",
                                            "UPDATE_WEBSITE",
                                            "server.js",
                                            {
                                                id: existingManga.id,
                                                website: entry.website,
                                            },
                                        );
                                },
                            );
                        }
                    }

                    // Apply newly generated NSFW flag automatically
                    if (entry.nsfw === 1 && existingManga.nsfw !== 1) {
                        db.run(
                            `UPDATE bookmarks SET nsfw = 1 WHERE id = ?`,
                            [existingManga.id],
                            (err) => {
                                if (!err)
                                    sysLog(
                                        "INFO",
                                        "DB",
                                        "UPDATE_NSFW",
                                        "server.js",
                                        { id: existingManga.id },
                                    );
                            },
                        );
                    }

                    config.settings.validation.auto_update.forEach((field) => {
                        if (field === "website") return;
                        let incomingVal = entry[field];

                        if (
                            incomingVal !== undefined &&
                            incomingVal !== "" &&
                            !(
                                Array.isArray(incomingVal) &&
                                incomingVal.length === 0
                            )
                        ) {
                            let existingVal = existingManga[field];
                            let valToSave = Array.isArray(entry[field])
                                ? JSON.stringify(entry[field])
                                : entry[field];

                            // Specific comparison logic for chapters to avoid lowering values
                            if (field === "latest_chapter") {
                                let incomingNum = parseFloat(
                                    String(incomingVal).replace(/[^\d.]/g, ""),
                                );
                                let existingNum = parseFloat(
                                    String(existingVal || "0").replace(
                                        /[^\d.]/g,
                                        "",
                                    ),
                                );

                                if (
                                    !isNaN(incomingNum) &&
                                    (isNaN(existingNum) ||
                                        incomingNum <= existingNum)
                                ) {
                                    return; // Skip updating if the incoming chapter is not greater
                                }
                            }

                            // Match the date logic to the chapter upgrade logic
                            if (field === "latest_chapter_update_date") {
                                let incomingChapNum = parseFloat(
                                    String(entry.latest_chapter || "0").replace(
                                        /[^\d.]/g,
                                        "",
                                    ),
                                );
                                let existingChapNum = parseFloat(
                                    String(
                                        existingManga.latest_chapter || "0",
                                    ).replace(/[^\d.]/g, ""),
                                );
                                if (
                                    !isNaN(incomingChapNum) &&
                                    !isNaN(existingChapNum) &&
                                    incomingChapNum <= existingChapNum
                                ) {
                                    return; // Skip date update if chapter didn't increment
                                }
                            }

                            db.run(
                                `UPDATE bookmarks SET "${field}" = ? WHERE id = ?`,
                                [valToSave, existingManga.id],
                                (err) => {
                                    if (!err)
                                        sysLog(
                                            "INFO",
                                            "DB",
                                            "AUTO_UPDATE_FIELD",
                                            "server.js",
                                            {
                                                id: existingManga.id,
                                                field,
                                                value: valToSave,
                                            },
                                        );
                                },
                            );
                        }
                    });

                    return linkUrl(existingManga.id, url, originalWebsite, res);
                } else {
                    if (entry.cover_image)
                        entry.cover_image = await downloadCover(
                            entry.cover_image,
                        );

                    Object.keys(entry).forEach((key) => {
                        if (Array.isArray(entry[key]))
                            entry[key] = JSON.stringify(entry[key]);
                    });

                    if (entry.website && !entry.website.startsWith("[")) {
                        entry.website = JSON.stringify([entry.website]);
                    }

                    const bookmarkKeys = Object.keys(entry).filter(
                        (k) => k !== "url" && k !== "website_source",
                    );
                    const placeholders = bookmarkKeys.map(() => "?").join(",");
                    const sql = `INSERT INTO bookmarks (${bookmarkKeys.map((k) => `"${k}"`).join(",")}) VALUES (${placeholders})`;

                    db.run(
                        sql,
                        bookmarkKeys.map((k) => entry[k]),
                        function (err) {
                            if (err) {
                                sysLog(
                                    "ERROR",
                                    "DB",
                                    "INSERT_ENTRY_FAILED",
                                    "server.js",
                                    { error: err.message, entry },
                                );
                                return res
                                    .status(500)
                                    .json({ error: err.message });
                            }
                            sysLog(
                                "INFO",
                                "DB",
                                "INSERT_NEW_ENTRY",
                                "server.js",
                                { id: this.lastID, title: entry.title },
                            );
                            linkUrl(this.lastID, url, originalWebsite, res);
                        },
                    );
                }
            });
        },
    );
});

// INTELLIGENT PATCH ENDPOINT
app.patch("/data/library/entry", (req, res) => {
    const { id, url, new_chapter, nsfw, updates } = req.body;

    const performUpdate = (bookmarkId, res) => {
        if (updates) {
            const keys = Object.keys(updates);
            if (keys.length === 0) return res.json({ success: true });

            const setClause = keys.map((k) => `"${k}" = ?`).join(", ");
            const values = keys.map((k) => {
                const val = updates[k];
                return Array.isArray(val) ? JSON.stringify(val) : val;
            });

            db.run(
                `UPDATE bookmarks SET ${setClause} WHERE id = ?`,
                [...values, bookmarkId],
                (err) => {
                    if (err)
                        return res.status(500).json({
                            error: `${err.message} -> Error while updating entry`,
                        });
                    res.json({ success: true });
                },
            );
        } else if (new_chapter !== undefined) {
            db.get(
                `SELECT latest_chapter FROM bookmarks WHERE id = ?`,
                [bookmarkId],
                (err, row) => {
                    if (err)
                        return res.status(500).json({
                            error: `${err.message} -> Error while fetching latest chapter`,
                        });
                    let latestParsed = parseFloat(
                        String(row?.latest_chapter || "0").replace(
                            /[^\d.]/g,
                            "",
                        ),
                    );
                    let currentParsed = parseFloat(
                        String(new_chapter).replace(/[^\d.]/g, ""),
                    );
                    let updateSql = `UPDATE bookmarks SET current_chapter = ?`;
                    let params = [new_chapter];
                    if (
                        !isNaN(currentParsed) &&
                        (isNaN(latestParsed) || currentParsed > latestParsed)
                    ) {
                        updateSql += `, latest_chapter = ?`;
                        params.push(new_chapter);
                    }
                    updateSql += ` WHERE id = ?`;
                    params.push(bookmarkId);
                    db.run(updateSql, params, (err) => {
                        if (err)
                            return res.status(500).json({
                                error: `${err.message} -> Error while updating latest chapter`,
                            });
                        res.json({ success: true, new_chapter });
                    });
                },
            );
        } else if (nsfw !== undefined) {
            db.run(
                `UPDATE bookmarks SET nsfw = ? WHERE id = ?`,
                [nsfw, bookmarkId],
                (err) => {
                    if (err)
                        return res.status(500).json({
                            error: `${err.message} -> Error while updating nsfw`,
                        });
                    res.json({ success: true, nsfw });
                },
            );
        } else {
            res.json({
                success: false,
                message: "No updatable fields provided",
            });
        }
    };

    if (id) {
        performUpdate(id, res);
    } else if (url) {
        db.get(
            `SELECT b.id FROM bookmarks b JOIN url_mapping m ON b.id = m.bookmark_id WHERE m.url = ?`,
            [url],
            (err, row) => {
                if (err || !row)
                    return res
                        .status(404)
                        .json({ error: "Bookmark not found in library" });
                performUpdate(row.id, res);
            },
        );
    } else {
        res.status(400).json({ error: "No ID or URL provided" });
    }
});

app.patch("/data/library/bulk", (req, res) => {
    const { ids, action, value } = req.body;
    if (!ids || ids.length === 0)
        return res.status(400).json({ error: "No IDs provided" });

    if (action === "delete") {
        const placeholders = ids.map(() => "?").join(",");
        db.run(
            `DELETE FROM bookmarks WHERE id IN (${placeholders})`,
            ids,
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                db.run(
                    `DELETE FROM url_mapping WHERE bookmark_id IN (${placeholders})`,
                    ids,
                );
                db.run(
                    `DELETE FROM pending_updates WHERE bookmark_id IN (${placeholders})`,
                    ids,
                );
                res.json({ success: true });
            },
        );
    } else if (action === "nsfw") {
        const placeholders = ids.map(() => "?").join(",");
        db.run(
            `UPDATE bookmarks SET nsfw = ? WHERE id IN (${placeholders})`,
            [value, ...ids],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            },
        );
    } else if (action === "type") {
        const placeholders = ids.map(() => "?").join(",");
        const typeNormalized = toTitleCase(value);
        db.run(
            `UPDATE bookmarks SET type = ? WHERE id IN (${placeholders})`,
            [typeNormalized, ...ids],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ success: true });
            },
        );
    } else {
        res.status(400).json({ error: "Invalid action" });
    }
});

app.post("/data/library/cleanup/covers", (req, res) => {
    db.all(`SELECT cover_image FROM bookmarks`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const dbCovers = rows
            .map((r) => {
                if (!r.cover_image) return null;
                const parts = r.cover_image.split("/");
                return parts[parts.length - 1];
            })
            .filter(Boolean);

        readdir(COVERS_DIR, (err, files) => {
            if (err) return res.status(500).json({ error: err.message });
            let deletedCount = 0;
            files.forEach((file) => {
                if (file !== "placeholder.jpg" && !dbCovers.includes(file)) {
                    unlinkSync(path.join(COVERS_DIR, file));
                    deletedCount++;
                }
            });
            res.json({ success: true, deleted: deletedCount });
        });
    });
});

app.post("/data/library/import", async (req, res) => {
    const { library } = req.body;
    if (!library || !Array.isArray(library))
        return res.status(400).json({ error: "Invalid array" });

    let processed = 0;
    for (const item of library) {
        const keys = Object.keys(item).filter(
            (k) => k !== "id" && k !== "mappings",
        );
        const placeholders = keys.map(() => "?").join(",");
        const values = keys.map((k) =>
            typeof item[k] === "object" ? JSON.stringify(item[k]) : item[k],
        );

        await new Promise((resolve) => {
            db.run(
                `INSERT OR IGNORE INTO bookmarks (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${placeholders})`,
                values,
                function (err) {
                    if (!err && this.lastID && item.mappings) {
                        try {
                            const mappings =
                                typeof item.mappings === "string"
                                    ? JSON.parse(item.mappings)
                                    : item.mappings;
                            mappings.forEach((map) => {
                                if (map.url) {
                                    db.run(
                                        `INSERT OR IGNORE INTO url_mapping (bookmark_id, url, website) VALUES (?, ?, ?)`,
                                        [this.lastID, map.url, map.website],
                                    );
                                }
                            });
                        } catch (e) {
                            console.error("Mapping restore error:", e);
                        }
                    }
                    resolve();
                },
            );
        });
        processed++;
    }
    res.json({ success: true, processed });
});

app.get("/data/pending", (req, res) => {
    db.all(`SELECT * FROM pending_updates`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.get("/data/library", (req, res) => {
    const query = `
        SELECT 
            b.*, 
            json_group_array(json_object('url', m.url, 'website', m.website)) AS mappings
        FROM bookmarks b
        LEFT JOIN url_mapping m ON b.id = m.bookmark_id
        GROUP BY b.id
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post("/data/pending/resolve", async (req, res) => {
    const { updateId, field, action } = req.body;
    db.get(
        `SELECT * FROM pending_updates WHERE id = ?`,
        [updateId],
        async (err, pendingRow) => {
            if (err || !pendingRow)
                return res.status(500).json({ error: "Update not found" });

            if (action === "create_new") {
                const entry = JSON.parse(pendingRow.full_entry);
                if (
                    entry.cover_image &&
                    entry.cover_image.startsWith("http") &&
                    !entry.cover_image.includes("localhost:3000")
                ) {
                    entry.cover_image = await downloadCover(entry.cover_image);
                }
                Object.keys(entry).forEach((key) => {
                    if (Array.isArray(entry[key]))
                        entry[key] = JSON.stringify(entry[key]);
                });

                if (entry.website && !entry.website.startsWith("[")) {
                    entry.website = JSON.stringify([entry.website]);
                }

                const bookmarkKeys = Object.keys(entry).filter(
                    (k) => k !== "url" && k !== "website_source",
                );

                // Handle bypassing the UNIQUE constraint on "title" safely
                db.get(
                    `SELECT id FROM bookmarks WHERE title = ?`,
                    [entry.title],
                    (err, existingRow) => {
                        if (existingRow) {
                            try {
                                const domain = new URL(
                                    pendingRow.source_url,
                                ).hostname.replace("www.", "");
                                entry.title = `${entry.title} (${domain})`;
                            } catch (e) {
                                entry.title = `${entry.title} (New)`;
                            }
                        }

                        const placeholders = bookmarkKeys
                            .map(() => "?")
                            .join(",");
                        db.run(
                            `INSERT INTO bookmarks (${bookmarkKeys.map((k) => `"${k}"`).join(",")}) VALUES (${placeholders})`,
                            bookmarkKeys.map((k) => entry[k]),
                            function (err) {
                                if (err)
                                    return res
                                        .status(500)
                                        .json({ error: err.message });

                                const newId = this.lastID;
                                db.run(
                                    `UPDATE url_mapping SET bookmark_id = ? WHERE url = ?`,
                                    [newId, pendingRow.source_url],
                                    () => {
                                        db.run(
                                            `DELETE FROM pending_updates WHERE id = ?`,
                                            [updateId],
                                            () => res.json({ success: true }),
                                        );
                                    },
                                );
                            },
                        );
                    },
                );
                return;
            }

            if (action === "discard") {
                db.run(
                    `DELETE FROM pending_updates WHERE id = ?`,
                    [updateId],
                    () => res.json({ success: true }),
                );
                return;
            }

            let proposed = JSON.parse(pendingRow.proposed_data);
            let proposedVal = proposed[field];

            if (action === "keep") {
                delete proposed[field];
                if (Object.keys(proposed).length === 0)
                    db.run(
                        `DELETE FROM pending_updates WHERE id = ?`,
                        [updateId],
                        () => res.json({ success: true }),
                    );
                else
                    db.run(
                        `UPDATE pending_updates SET proposed_data = ? WHERE id = ?`,
                        [JSON.stringify(proposed), updateId],
                        () => res.json({ success: true }),
                    );
                return;
            }

            db.get(
                `SELECT * FROM bookmarks WHERE id = ?`,
                [pendingRow.bookmark_id],
                async (err, bookmark) => {
                    if (err || !bookmark)
                        return res
                            .status(500)
                            .json({ error: "Bookmark not found" });
                    let newVal = proposedVal;
                    if (action === "merge" && Array.isArray(proposedVal)) {
                        let existingArr = [];
                        try {
                            existingArr = JSON.parse(bookmark[field] || "[]");
                        } catch (e) {
                            existingArr = bookmark[field]
                                ? [bookmark[field]]
                                : [];
                        }
                        newVal = [...new Set([...existingArr, ...proposedVal])];
                    } else if (
                        action === "replace" &&
                        field === "cover_image"
                    ) {
                        newVal = await downloadCover(proposedVal);
                    }

                    let valToSave = Array.isArray(newVal)
                        ? JSON.stringify(newVal)
                        : newVal;
                    db.run(
                        `UPDATE bookmarks SET "${field}" = ? WHERE id = ?`,
                        [valToSave, pendingRow.bookmark_id],
                        (err) => {
                            if (err)
                                return res
                                    .status(500)
                                    .json({ error: err.message });
                            delete proposed[field];
                            if (Object.keys(proposed).length === 0)
                                db.run(
                                    `DELETE FROM pending_updates WHERE id = ?`,
                                    [updateId],
                                    () => res.json({ success: true }),
                                );
                            else
                                db.run(
                                    `UPDATE pending_updates SET proposed_data = ? WHERE id = ?`,
                                    [JSON.stringify(proposed), updateId],
                                    () => res.json({ success: true }),
                                );
                        },
                    );
                },
            );
        },
    );
});

app.use((err, req, res, next) => {
    console.error(
        `🔥 API Error on ${req.method} ${req.originalUrl}:`,
        err.message,
    );
    res.status(500).json({
        success: false,
        error: "Internal Server Error",
        details: err.message,
    });
});

app.listen(PORT, () => console.log(`🚀 Manga Backend Running on Port ${PORT}`));
app.use(express.static(__dirname));

// --- SAFETY NET: Prevent Node.js Process Crashes ---
process.on("uncaughtException", (err) => {
    console.error("🔥 UNCAUGHT EXCEPTION: Keeping server alive.", err);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("🔥 UNHANDLED REJECTION: Keeping server alive.", reason);
});
