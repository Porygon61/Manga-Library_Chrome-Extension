export async function remoteLog(level, category, action, source, data = null) {
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

export function getParsedArray(str) {
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
