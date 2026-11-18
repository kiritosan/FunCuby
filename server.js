import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createAudioImport } from "./server/audio-import.js";
import { createGameTranscription } from "./server/game-transcription.js";
import { createSongLibrary } from "./server/song-library.js";
const root = dirname(fileURLToPath(import.meta.url));
const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
};
const notFound = (res) => {
    res.writeHead(404);
    res.end("Not found");
};

/**
 * Builds the local FunCuby server. `audioImport` may be replaced by tests with
 * a fake {handle(req,res)=>Promise<boolean>} — production always uses the real
 * yt-dlp/ffmpeg backed importer.
 */
export function createServer({
    port = Number(process.env.PORT || 5173),
    libraryDirectory = process.env.FUNCUBY_LIBRARY_DIR ||
        resolve(root, ".funcuby-library"),
    audioImport = createAudioImport({ port, root }),
    gameTranscription = createGameTranscription({ port, root }),
} = {}) {
    const libraryRoot = resolve(libraryDirectory);
    const library = createSongLibrary({
        directory: libraryRoot,
        port,
    });
    const server = http.createServer(async (req, res) => {
        try {
            if (await library.handle(req, res)) return;
            if (await audioImport.handle(req, res)) return;
            if (await gameTranscription.handle(req, res)) return;
            if (!["GET", "HEAD"].includes(req.method)) {
                res.writeHead(405);
                res.end();
                return;
            }
            const path = decodeURIComponent(
                new URL(req.url, "http://localhost").pathname,
            );
            const file = resolve(
                root,
                "." + (path === "/" ? "/index.html" : path),
            );
            const fromLibrary = relative(libraryRoot, file);
            const insideLibrary =
                !isAbsolute(fromLibrary) &&
                fromLibrary !== ".." &&
                !fromLibrary.startsWith(".." + sep);
            if (
                insideLibrary ||
                !file.startsWith(root + sep) ||
                path.includes("\\") ||
                path.split("/").some((s) => s.startsWith("."))
            ) {
                res.writeHead(403);
                res.end();
                return;
            }
            if (!(await stat(file)).isFile()) {
                notFound(res);
                return;
            }
            res.writeHead(200, {
                "Content-Type":
                    types[extname(file)] || "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy":
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
                "Permissions-Policy":
                    "bluetooth=(self), screen-wake-lock=(self)",
            });
            res.end(req.method === "HEAD" ? undefined : await readFile(file));
        } catch {
            notFound(res);
        }
    });
    return server;
}

const isMain =
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const port = Number(process.env.PORT || 5173),
        host = process.env.HOST || "127.0.0.1";
    createServer({ port }).listen(port, host, () =>
        console.log(`FunCuby: http://${host}:${port}`),
    );
}
