// URL allow-list and canonicalization for the audio import endpoint.
// Pure functions only — no I/O — so they stay unit-testable.

export class AudioUrlError extends Error {
    constructor(code, detail = "") {
        super(detail || code);
        this.name = "AudioUrlError";
        this.code = code;
    }
}

export const MAX_URL_LENGTH = 2048;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_VIDEO = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]+)\/?$/;

const YOUTUBE_HOSTS = new Set([
    "www.youtube.com",
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
]);
const BILIBILI_HOSTS = new Set([
    "www.bilibili.com",
    "bilibili.com",
    "m.bilibili.com",
]);
const SHORTLINK_HOSTS = new Set(["b23.tv"]);
const ALLOWED_HOSTS = new Set([
    ...YOUTUBE_HOSTS,
    ...BILIBILI_HOSTS,
    ...SHORTLINK_HOSTS,
]);

/** Hosts a b23.tv redirect chain may pass through (video platforms + shortlinks). */
export const REDIRECT_HOSTS = ALLOWED_HOSTS;

function parse(raw) {
    if (typeof raw !== "string") throw new AudioUrlError("invalid-url");
    const input = raw.trim();
    if (!input || input.length > MAX_URL_LENGTH)
        throw new AudioUrlError("invalid-url");
    let url;
    try {
        url = new URL(input);
    } catch {
        throw new AudioUrlError("invalid-url");
    }
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") throw new AudioUrlError("invalid-url");
    if (url.username || url.password || url.port)
        throw new AudioUrlError("invalid-url");
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) throw new AudioUrlError("unsupported-url");
    return { url, host };
}

function canonicalYouTube(url, host) {
    const watch = (id) => ({
        url: `https://www.youtube.com/watch?v=${id}`,
        kind: "youtube",
    });
    const path = url.pathname;
    if (path === "/watch" || path === "/watch/") {
        const id = url.searchParams.get("v");
        if (id && VIDEO_ID.test(id)) return watch(id);
        throw new AudioUrlError("unsupported-url");
    }
    const segment = path.match(/^\/(shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/);
    if (segment) return watch(segment[2]);
    if (host === "youtu.be") {
        const short = path.match(/^\/([A-Za-z0-9_-]{11})\/?$/);
        if (short) return watch(short[1]);
    }
    throw new AudioUrlError("unsupported-url");
}

function canonicalBilibili(url) {
    const match = url.pathname.match(BILIBILI_VIDEO);
    if (!match) throw new AudioUrlError("unsupported-url");
    // Always emit an explicit page so metadata and download select the same
    // single part of a multi-part video (verified against yt-dlp --no-playlist:
    // no p means first part, ?p=N means part N).
    const page = url.searchParams.get("p");
    const part =
        page && /^[0-9]+$/.test(page) && Number(page) > 0 ? Number(page) : 1;
    return {
        url: `https://www.bilibili.com/video/${match[1]}?p=${part}`,
        kind: "bilibili",
    };
}

/**
 * Validates a user-supplied URL against the platform allow-list and returns a
 * canonical https URL plus its kind: "youtube", "bilibili" or "shortlink"
 * (b23.tv links still need manual redirect resolution).
 */
export function canonicalizeAudioUrl(raw) {
    const { url, host } = parse(raw);
    if (SHORTLINK_HOSTS.has(host))
        return { url: url.toString(), kind: "shortlink" };
    if (YOUTUBE_HOSTS.has(host)) return canonicalYouTube(url, host);
    if (BILIBILI_HOSTS.has(host)) return canonicalBilibili(url);
    throw new AudioUrlError("unsupported-url");
}

/**
 * Follows a b23.tv shortlink manually: at most `maxHops` redirects, each
 * Location must be HTTPS on an allow-listed host with no credentials or
 * non-default port. Returns the final non-redirect URL.
 */
export async function resolveShortlink(
    startUrl,
    { fetchImpl = fetch, signal, timeoutMs = 10000, maxHops = 3 } = {},
) {
    let current = startUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response;
        try {
            response = await fetchImpl(current, {
                method: "GET",
                redirect: "manual",
                signal: combined,
            });
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            throw new AudioUrlError(
                "unsupported-shortlink",
                `shortlink request failed: ${error?.message ?? error}`,
            );
        }
        // Only headers matter for redirect resolution — cancel the body
        // instead of buffering an arbitrary HTML page.
        try {
            await response.body?.cancel();
        } catch {
            /* body already consumed or absent */
        }
        const location = response.headers.get("location");
        const isRedirect =
            response.status >= 300 &&
            response.status < 400 &&
            Boolean(location);
        if (isRedirect && hop >= maxHops)
            throw new AudioUrlError("unsupported-shortlink");
        if (isRedirect) {
            let next;
            try {
                next = new URL(location, current);
            } catch {
                throw new AudioUrlError("unsupported-shortlink");
            }
            if (
                next.protocol !== "https:" ||
                next.username ||
                next.password ||
                next.port ||
                !REDIRECT_HOSTS.has(next.hostname.toLowerCase())
            )
                throw new AudioUrlError("unsupported-shortlink");
            current = next.toString();
            continue;
        }
        return current;
    }
    throw new AudioUrlError("unsupported-shortlink");
}
