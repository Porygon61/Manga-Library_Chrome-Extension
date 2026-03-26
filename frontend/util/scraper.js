// scraper.js
export function executeScraper(configs, domain) {
    const site = configs.websites[domain];
    if (!site || !site.selectors) return { Error: "No selectors for " + domain };

    let data = {};
    for (const [key, selRaw] of Object.entries(site.selectors)) {
        let isArrayType = typeof selRaw === "object" && selRaw !== null && selRaw.type === "array";
        let takeFirst = typeof selRaw === "object" && selRaw !== null && selRaw.take_first === true;
        let query = typeof selRaw === "object" && selRaw !== null ? selRaw.query : selRaw;
        let splitBy = isArrayType ? selRaw.split_by : null;

        if (!query || typeof query !== "string" || query.trim() === "") {
            data[key] = isArrayType ? [] : "";
            continue;
        }

        try {
            let elements = [];
            // Native XPath support
            if (query.startsWith("xpath:")) {
                const xpath = query.replace("xpath:", "").trim();
                const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < snapshot.snapshotLength; i++) {
                    elements.push(snapshot.snapshotItem(i));
                }
            } else {
                elements = Array.from(document.querySelectorAll(query));
            }

            if (elements.length > 0) {
                let extracted = elements.map((el) => {
                    const clone = el.cloneNode(true);
                    if (clone.tagName === "IMG") return clone.src;
                    if (clone.tagName === "A" && clone.getAttribute("title") && clone.textContent.trim() === "") return clone.getAttribute("title");

                    const exclusionSelector = site.selector_exclusions?.[key];
                    if (exclusionSelector) {
                        clone.querySelectorAll(exclusionSelector).forEach((ex) => ex.remove());
                    }

                    let finalText = "";
                    const textNodes = Array.from(clone.childNodes).filter((node) => node.nodeType === 3 && node.textContent.trim().length > 0);

                    if (textNodes.length > 0) {
                        finalText = textNodes.map((node) => node.textContent.trim()).join(" ");
                    } else {
                        finalText = clone.textContent.replace(/\s\s+/g, " ").trim();
                    }

                    const replacements = site.string_replacements?.[key];
                    if (replacements && Array.isArray(replacements)) {
                        replacements.forEach((str) => {
                            let regex;
                            if (str.startsWith("/") && str.match(/\/[gimsuy]*$/)) {
                                const lastSlash = str.lastIndexOf("/");
                                const pattern = str.substring(1, lastSlash);
                                const flags = str.substring(lastSlash + 1);
                                regex = new RegExp(pattern, flags);
                            } else {
                                const escapedStr = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                                regex = new RegExp(escapedStr, "gi");
                            }
                            finalText = finalText.replace(regex, "");
                        });
                    }

                    return finalText.trim();
                }).filter((val) => val !== "");

                if (takeFirst && extracted.length > 0) extracted = [extracted[0]];

                if (isArrayType) {
                    if (splitBy) {
                        const combinedDelimiters = new RegExp(`[${splitBy},/;|]|\\s&\\s`, "g");
                        data[key] = extracted.flatMap((str) => str.split(combinedDelimiters).map((s) => s.trim())).filter((s) => s !== "");
                    } else {
                        data[key] = extracted.flatMap((str) => str.split(/[,/;|]|\s&\s/g).map((s) => s.trim())).filter((s) => s !== "");
                    }
                } else {
                    data[key] = extracted.join(" ");
                }
            } else {
                data[key] = isArrayType ? [] : "";
            }
        } catch (error) {
            data[key] = isArrayType ? [] : "Error";
        }
    }
    return data;
}