import {
    TranscriptionStore as LegacyStore,
    validateTranscriptionDraft,
} from "./transcription-store.js";

const base = "/api/library";
const current = "funcuby:open-song";
const migrated = "funcuby:disk-library-migrated";

async function request(path, options) {
    const response = await fetch(base + path, {
        cache: "no-store",
        ...options,
    });
    if (!response.ok)
        throw Object.assign(new Error("Library HTTP " + response.status), {
            status: response.status,
        });
    return response;
}
export const vocalKey = (startMs, lengthMs) =>
    Math.round(startMs) + "-" + Math.round(lengthMs);

export class DiskLibrary {
    revisions = new Map();
    stems = new Map();
    pending = new Map();
    directory = "";
    active = null;

    select(id) {
        this.active = id;
        try {
            sessionStorage.setItem(current, id ?? "");
        } catch {
            /* optional tab selection */
        }
    }
    async listSongs() {
        const result = await (await request("")).json();
        this.directory = result.directory;
        return result.songs;
    }
    async loadSong(id) {
        await this.pending.get(id)?.catch(() => {});
        try {
            const { meta, state, stems } = await (
                await request("/" + id)
            ).json();
            const bytes = await (await request("/" + id + "/source")).blob();
            const record = validateTranscriptionDraft({
                source: {
                    version: 1,
                    id,
                    name: meta.name,
                    blob: bytes.slice(0, bytes.size, meta.type),
                },
                state,
            });
            this.stems.set(id, new Set(stems));
            this.revisions.set(id, meta.revision);
            return record;
        } catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }
    async load() {
        const songs = await this.listSongs();
        let id;
        try {
            id = sessionStorage.getItem(current);
        } catch {
            /* optional */
        }
        if (id === "") return null;
        id = songs.find((s) => s.id === id)?.id ?? songs[0]?.id;
        if (!id) return null;
        return this.loadSong(id);
    }
    queue(id, work) {
        const next = (this.pending.get(id) ?? Promise.resolve())
            .catch(() => {})
            .then(work);
        this.pending.set(id, next);
        return next.finally(() => {
            if (this.pending.get(id) === next) this.pending.delete(id);
        });
    }
    replace(source, state) {
        validateTranscriptionDraft({ source, state });
        const form = new FormData();
        form.set("source", source.blob, source.name);
        form.set("state", JSON.stringify(state));
        return this.queue(source.id, async () => {
            const meta = await (
                await request("/" + source.id, { method: "POST", body: form })
            ).json();
            this.revisions.set(source.id, meta.revision);
            return true;
        });
    }
    saveState(id, state) {
        const bytes = JSON.stringify(state);
        return this.queue(id, async () => {
            try {
                const meta = await (
                    await request("/" + id, {
                        method: "PUT",
                        headers: {
                            "If-Match": this.revisions.get(id) ?? "",
                            "Content-Type": "application/json",
                        },
                        body: bytes,
                    })
                ).json();
                this.revisions.set(id, meta.revision);
                return true;
            } catch (e) {
                if ([404, 409].includes(e.status)) return false;
                throw e;
            }
        });
    }
    saveStem(id, key, blob) {
        return this.queue(id, async () => {
            await request("/" + id + "/vocals/" + key, {
                method: "PUT",
                body: blob,
            });
            if (!this.stems.has(id)) this.stems.set(id, new Set());
            this.stems.get(id).add("vocals-" + key + ".wav");
        });
    }
    async loadStem(id, key) {
        if (!this.stems.get(id)?.has("vocals-" + key + ".wav")) return null;
        return (await request("/" + id + "/vocals/" + key)).blob();
    }
    clear(id) {
        if (!id) return Promise.resolve(false);
        return this.queue(id, async () => {
            try {
                await request("/" + id, {
                    method: "DELETE",
                    headers: { "If-Match": this.revisions.get(id) ?? "" },
                });
            } catch (e) {
                if ([404, 409].includes(e.status)) return false;
                throw e;
            }
            this.stems.delete(id);
            this.revisions.delete(id);
            if (this.active === id) this.select(null);
            return true;
        });
    }
    async migrateLegacy() {
        let databases;
        try {
            if (localStorage.getItem(migrated)) return;
            databases = await indexedDB.databases();
        } catch {
            return;
        }
        if (!databases.some((db) => db.name === "funcuby-transcription"))
            return;
        const old = new LegacyStore();
        const existing = new Set((await this.listSongs()).map((s) => s.id));
        const copy = async (record) => {
            if (!record || existing.has(record.source.id)) return;
            try {
                await this.replace(record.source, record.state);
            } catch (e) {
                if (e.status !== 409) throw e;
            }
        };
        for (const { id } of await old.listSongs())
            await copy(await old.loadSong(id));
        await copy(await old.load());
        try {
            localStorage.setItem(migrated, "1");
        } catch {
            /* copies are idempotent */
        }
    }
}
