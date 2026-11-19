import { randomUUID } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { isAllowedHost } from "./audio-import.js";
import {
    MAX_FILE_BYTES,
    MAX_AUDIO_SECONDS,
} from "../src/core/transcription/config.js";
import { validateDraftState } from "../src/core/storage/transcription-store.js";
import {
    arrangeTranscription,
    PLAYABLE_VERSIONS,
    transcriptionMidi,
} from "../src/core/arrangement.js";

const base = "/api/library";
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const stemKey = /^\d{1,6}-\d{1,6}$/;
const maxState = 48 * 1024 * 1024;
const maxStem = 44100 * MAX_AUDIO_SECONDS * 4 + 44;
const fail = (status, message) => {
    throw Object.assign(new Error(message), { status });
};
const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));

async function body(req, max) {
    if (Number(req.headers["content-length"]) > max)
        fail(413, "File too large");
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > max) fail(413, "File too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function atomic(path, bytes) {
    const temp = path + "." + randomUUID() + ".tmp";
    try {
        await writeFile(temp, bytes);
        await rename(temp, path);
    } finally {
        await rm(temp, { force: true });
    }
}

// Publish a complete score snapshot with a single rename of song.json.
// The previous snapshot remains usable if rendering a MIDI or writing fails.
async function publish(dir, meta, state) {
    try {
        validateDraftState(meta.id, state);
    } catch {
        fail(400, "Invalid song state");
    }
    const revision = randomUUID();
    const snapshot = join(dir, revision);
    await mkdir(snapshot);
    try {
        await writeFile(join(snapshot, "draft.json"), JSON.stringify(state));
        for (const version of [
            ...(state.clipVersions ?? []).map(([, value]) => value),
            state,
        ]) {
            const fields = version.settings;
            for (const [key, capture] of version.captures) {
                const start = Math.round(
                    capture.clipStartMs ??
                        Number(fields["transcribe-start"] || 0) * 1000,
                );
                const folder = join(
                    snapshot,
                    start + "-" + Math.round(capture.clipMs) + "ms",
                    key.replace(":", "-"),
                );
                await mkdir(folder, { recursive: true });
                const bpm = Number(fields["transcribe-bpm"] || 120);
                const options = { bpm, name: meta.name };
                const working = capture.editedNotes ?? capture.notes;
                await writeFile(
                    join(folder, "recognition.mid"),
                    transcriptionMidi(capture.notes, options),
                );
                if (capture.editedNotes)
                    await writeFile(
                        join(folder, "edited.mid"),
                        transcriptionMidi(working, options),
                    );
                for (const level of PLAYABLE_VERSIONS) {
                    const arrangement = arrangeTranscription(working, {
                        level,
                        autoHarmony: fields["transcribe-harmony"] === "auto",
                        bpm,
                        firstNote: version.firstNote ?? state.firstNote ?? 60,
                        transpose: Number(fields["transcribe-transpose"] || 0),
                        originMs: Number(fields["transcribe-origin"] || 0),
                        minPitch: Number(fields["transcribe-min-pitch"] || 0),
                        maxPitch: Number(fields["transcribe-max-pitch"] || 127),
                    });
                    await writeFile(
                        join(folder, level + ".mid"),
                        transcriptionMidi(arrangement.notes, {
                            ...options,
                            bpm: arrangement.bpm,
                        }),
                    );
                }
            }
        }
        const next = { ...meta, revision, updated: Date.now() };
        await atomic(join(dir, "song.json"), JSON.stringify(next));
        if (meta.revision)
            await rm(join(dir, meta.revision), {
                recursive: true,
                force: true,
            }).catch(() => {});
        return next;
    } catch (error) {
        await rm(snapshot, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

export function createSongLibrary({ directory, port }) {
    const pending = new Map();
    function serial(id, fn) {
        const task = (pending.get(id) ?? Promise.resolve())
            .catch(() => {})
            .then(fn);
        pending.set(id, task);
        return task.finally(() => {
            if (pending.get(id) === task) pending.delete(id);
        });
    }
    return {
        async handle(req, res) {
            const url = new URL(req.url, "http://localhost");
            if (url.pathname !== base && !url.pathname.startsWith(base + "/"))
                return false;
            const json = (status, data) => {
                res.writeHead(status, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                });
                res.end(JSON.stringify(data));
            };
            try {
                if (
                    !isAllowedHost(
                        req.headers.host,
                        port || req.socket.localPort,
                    ) ||
                    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
                        req.socket.remoteAddress,
                    ) ||
                    req.headers["sec-fetch-site"] === "cross-site" ||
                    (req.method !== "GET" &&
                        req.headers.origin !== "http://" + req.headers.host)
                )
                    fail(403, "Local requests only");
                const [, , , id, part, key, extra] = url.pathname.split("/");
                if (!id && req.method === "GET" && url.pathname === base) {
                    let folders = [];
                    try {
                        folders = await readdir(directory);
                    } catch (e) {
                        if (e.code !== "ENOENT") throw e;
                    }
                    const songs = await Promise.all(
                        folders
                            .filter((x) => uuid.test(x))
                            .map(async (id) => {
                                try {
                                    return await readJSON(
                                        join(directory, id, "song.json"),
                                    );
                                } catch (e) {
                                    if (e.code !== "ENOENT") throw e;
                                    return null;
                                }
                            }),
                    );
                    json(200, {
                        directory,
                        songs: songs
                            .filter(Boolean)
                            .sort((a, b) => b.updated - a.updated),
                    });
                    return true;
                }
                if (!uuid.test(id ?? "") || extra !== undefined)
                    fail(404, "Unknown song");
                await serial(id, async () => {
                    const dir = join(directory, id);
                    if (!part && req.method === "POST") {
                        await mkdir(directory, { recursive: true });
                        const data = await body(
                            req,
                            MAX_FILE_BYTES + maxState + 8192,
                        );
                        const form = await new Response(data, {
                            headers: {
                                "Content-Type":
                                    req.headers["content-type"] ?? "",
                            },
                        }).formData();
                        const file = form.get("source");
                        if (
                            !(file instanceof Blob) ||
                            !file.size ||
                            file.size > MAX_FILE_BYTES ||
                            !file.name
                        )
                            fail(400, "Invalid audio");
                        const state = JSON.parse(form.get("state"));
                        const ext = extname(file.name).toLowerCase();
                        const audio =
                            "source" +
                            (/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ".audio");
                        const temp = await mkdtemp(join(directory, ".import-"));
                        try {
                            await writeFile(
                                join(temp, audio),
                                new Uint8Array(await file.arrayBuffer()),
                            );
                            const meta = await publish(
                                temp,
                                { id, name: file.name, type: file.type, audio },
                                state,
                            );
                            try {
                                await rename(temp, dir);
                            } catch (e) {
                                if (
                                    ["EEXIST", "ENOTEMPTY", "EPERM"].includes(
                                        e.code,
                                    ) &&
                                    (await readJSON(
                                        join(dir, "song.json"),
                                    ).catch(() => null))
                                )
                                    fail(409, "Song already exists");
                                throw e;
                            }
                            json(201, meta);
                        } finally {
                            await rm(temp, { recursive: true, force: true });
                        }
                        return;
                    }
                    const meta = await readJSON(join(dir, "song.json"));
                    if (req.method === "GET") {
                        if (!part) {
                            json(200, {
                                meta,
                                state: await readJSON(
                                    join(dir, meta.revision, "draft.json"),
                                ),
                                stems: (await readdir(dir)).filter(
                                    (s) =>
                                        s.endsWith(".wav") &&
                                        s.startsWith("vocals-"),
                                ),
                            });
                            return;
                        }
                        const vocal =
                            part === "vocals" && stemKey.test(key ?? "");
                        if (!vocal && (part !== "source" || key))
                            fail(404, "Unknown artifact");
                        const bytes = await readFile(
                            join(
                                dir,
                                vocal ? "vocals-" + key + ".wav" : meta.audio,
                            ),
                        );
                        res.writeHead(200, {
                            "Content-Type": vocal
                                ? "audio/wav"
                                : "application/octet-stream",
                            "Cache-Control": "no-store",
                            "Content-Length": bytes.length,
                            "X-Content-Type-Options": "nosniff",
                        });
                        res.end(bytes);
                        return;
                    }
                    if (
                        part === "vocals" &&
                        req.method === "PUT" &&
                        stemKey.test(key ?? "")
                    ) {
                        const bytes = await body(req, maxStem);
                        if (
                            bytes.length <= 44 ||
                            bytes.toString("ascii", 0, 4) !== "RIFF" ||
                            bytes.toString("ascii", 8, 12) !== "WAVE"
                        )
                            fail(400, "Invalid WAV");
                        await atomic(
                            join(dir, "vocals-" + key + ".wav"),
                            bytes,
                        );
                        json(200, { saved: true });
                        return;
                    }
                    if (!part && ["PUT", "DELETE"].includes(req.method)) {
                        if (req.headers["if-match"] !== meta.revision)
                            fail(409, "Song changed in another session");
                        if (req.method === "PUT")
                            json(
                                200,
                                await publish(
                                    dir,
                                    meta,
                                    JSON.parse(await body(req, maxState)),
                                ),
                            );
                        else {
                            await rm(dir, { recursive: true, force: true });
                            json(200, { deleted: true });
                        }
                        return;
                    }
                    fail(405, "Unsupported operation");
                });
            } catch (e) {
                if (!res.headersSent)
                    json(
                        e.status ??
                            (e.code === "ENOENT"
                                ? 404
                                : e instanceof SyntaxError
                                  ? 400
                                  : 500),
                        {
                            error: e.status
                                ? e.message
                                : "Library operation failed",
                        },
                    );
            }
            return true;
        },
    };
}
