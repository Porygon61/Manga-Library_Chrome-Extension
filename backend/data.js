import { readFileSync, writeFileSync } from "fs";

// Helper to normalize strings: removes punctuation, standardizes spacing, and converts to lowercase
function normalizeString(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .replace(/['"’‘`\-,\.!\?:;]/g, "") // Strip symbols/punctuation
        .replace(/\s+/g, " ") // Normalize spaces
        .trim();
}

// Helper to safely parse the alt_title arrays from the DB
function getParsedArray(str) {
    if (!str) return [];
    try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) return parsed.map(String);
    } catch (e) {}
    return String(str)
        .replace(/[\[\]"]/g, "")
        .split(/[,;]/)
        .map((g) => g.trim())
        .filter(Boolean);
}

// Helper to normalize URLs for comparison (removes trailing slashes)
function normalizeUrl(url) {
    if (!url) return "";
    return url.trim().replace(/\/$/, "");
}

async function migrateData() {
    console.log("Fetching library data from database...");
    let libraryData = [];
    try {
        // Fetch existing data from your local server
        const libRes = await fetch("http://localhost:3000/data/library");
        libraryData = await libRes.json();
    } catch (e) {
        console.error(
            "❌ Failed to fetch library. Make sure your server (server.js) is running.",
        );
        return;
    }

    console.log("Reading data.json...");
    let jsonData = [];
    try {
        jsonData = JSON.parse(readFileSync("data.json", "utf-8"));
    } catch (e) {
        console.error("❌ Failed to read data.json.", e.message);
        return;
    }

    const matched = [];
    const missing = [];

    // 1. Cross-reference JSON against the DB
    for (const item of jsonData) {
        const searchTitle = normalizeString(item.Title);

        // Check if the manga exists in the library using fuzzy title/alt-title matching
        let foundMatch = libraryData.find((libItem) => {
            const libTitle = normalizeString(libItem.title);
            const altTitles = getParsedArray(libItem.alt_title).map(
                normalizeString,
            );

            return libTitle === searchTitle || altTitles.includes(searchTitle);
        });

        if (foundMatch) {
            matched.push({ jsonItem: item, dbItem: foundMatch });
        } else {
            missing.push(item);
        }
    }

    console.log(`\n--- 📊 MIGRATION REPORT ---`);
    console.log(`Total in JSON:   ${jsonData.length}`);
    console.log(`Matched in DB:   ${matched.length}`);
    console.log(`Missing in DB:   ${missing.length}`);

    // 2. Output missing manga
    console.log(`\n--- 🔎 MISSING MANGA (Need to search and add) ---`);
    missing.forEach((m) =>
        console.log(
            `- ${m.Title} (Ch: ${m.Chapter}, Site: ${m.Website || "N/A"})`,
        ),
    );

    // Save missing entries to a file so you have a checklist
    if (missing.length > 0) {
        writeFileSync("missing_manga.json", JSON.stringify(missing, null, 2));
        console.log(`\n✅ Saved missing manga list to 'missing_manga.json'`);
    }

    // 3. Auto-update progress for matched manga
    console.log(`\n--- 🚀 UPDATING MATCHED MANGA PROGRESS ---`);
    let updateCount = 0;

    for (const match of matched) {
        const { jsonItem, dbItem } = match;
        const currentDbCh = parseFloat(dbItem.current_chapter || 0);
        const jsonCh = parseFloat(jsonItem.Chapter || 0);

        // Only update if the JSON chapter progress is further along than the Database
        if (jsonCh > currentDbCh) {
            console.log(
                `Updating '${dbItem.title}': Ch ${currentDbCh} -> ${jsonCh}`,
            );
            try {
                const res = await fetch(
                    "http://localhost:3000/data/library/entry",
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            id: dbItem.id,
                            new_chapter: jsonCh.toString(),
                        }),
                    },
                );
                if (res.ok) updateCount++;
            } catch (e) {
                console.error(
                    `❌ Failed to update ${dbItem.title}:`,
                    e.message,
                );
            }
        }
    }

    console.log(
        `\n✅ Migration complete! Updated chapters for ${updateCount} manga.`,
    );
}

// New function to check Mangago bookmarks against URL mappings
async function checkMangagoBookmarks() {
    console.log("\n--- 🌐 CHECKING MANGAGO BOOKMARKS ---");

    let libraryData = [];
    try {
        const libRes = await fetch("http://localhost:3000/data/library");
        libraryData = await libRes.json();
    } catch (e) {
        console.error("❌ Failed to fetch library data.", e.message);
        return;
    }

    // Extract all registered URLs from the library mappings
    const dbUrls = new Set();
    libraryData.forEach((item) => {
        try {
            // mappings is returned as a JSON string from SQLite
            const mappings = JSON.parse(item.mappings || "[]");
            mappings.forEach((map) => {
                if (map.url) {
                    dbUrls.add(normalizeUrl(map.url));
                }
            });
        } catch (e) {}
    });

    // Read the Mangago bookmarks file
    let mangagoBookmarks = [];
    try {
        mangagoBookmarks = JSON.parse(
            readFileSync("Mangago-Bookmark.json", "utf-8"),
        );
    } catch (e) {
        console.error("❌ Failed to read Mangago-Bookmark.json.", e.message);
        return;
    }

    const missingLinks = [];
    let matchCount = 0;

    // Check which bookmarks are missing
    mangagoBookmarks.forEach((bookmark) => {
        const link = bookmark.manga_link;
        if (!link) return;

        if (dbUrls.has(normalizeUrl(link))) {
            matchCount++;
        } else {
            missingLinks.push(bookmark);
        }
    });

    console.log(`Total Mangago Bookmarks:  ${mangagoBookmarks.length}`);
    console.log(`Matched URLs in DB:       ${matchCount}`);
    console.log(`Missing URLs in DB:       ${missingLinks.length}`);

    if (missingLinks.length > 0) {
        writeFileSync(
            "missing_mangago_links.json",
            JSON.stringify(missingLinks, null, 2),
        );
        console.log(
            `✅ Saved missing Mangago links to 'missing_mangago_links.json'`,
        );
    }
}

// Run both scripts
async function run() {
    //await migrateData();
    await checkMangagoBookmarks();
}

run();
