import {
    editMelody,
    reviewFlags,
    workingNotes,
} from "../../core/transcription/melody-edit.js";
import { noteName } from "../../core/music.js";
import { t } from "../../i18n/i18n.js";
import { download, el } from "../dom.js";
import { createPhrasePlayer } from "./phrase-player.js";

const PAGE_SIZE = 60;
const MAX_HISTORY = 20;

export function createMelodyEditor({
    host,
    getContext,
    piano,
    getBuffer,
    getVocalStem,
    getVolume,
    pauseSource,
    onChange,
    onError,
    getName,
}) {
    let capture = null,
        original = null,
        selection = -1,
        history = [],
        busy = false;
    const text = (key) => t(`transcribe.editor.${key}`);
    const button = (key, action) => {
        const node = el("button", text(key));
        node.type = "button";
        node.dataset.action = key;
        node.addEventListener("click", () => {
            try {
                Promise.resolve(action()).catch(onError);
            } catch (error) {
                onError(error);
            }
        });
        return node;
    };
    const number = (key, value, min, max, step) => {
        const label = el("label"),
            input = el("input");
        input.type = "number";
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
        input.dataset.field = key;
        label.append(el("span", text(key)), input);
        return { label, input };
    };
    const heading = el("h3", text("title"));
    const hint = el("p", text("hint"), "muted play-hint");
    const range = el("div", "", "transcribe-fields");
    const from = number("from", 0, 0, 600, 0.01);
    const to = number("to", 10, 0, 600, 0.01);
    const loopLabel = el("label", "", "melody-editor-loop"),
        loop = el("input");
    loop.type = "checkbox";
    loop.dataset.field = "loop";
    loopLabel.append(loop, el("span", text("loop")));
    const status = el("p", "", "muted transcribe-status-line");
    status.setAttribute("role", "status");
    const player = createPhrasePlayer(getContext, piano, {
        onError,
        onUpdate: (state) => {
            host.dataset.playing = state.active ? state.mode : "";
            status.textContent = state.active
                ? `${text(state.loading ? "loading" : "playing")} · ${text(state.mode)} · ${((state.positionMs ?? 0) / 1000).toFixed(2)} s`
                : text("stopped");
        },
    });
    function stop() {
        player.stop();
    }
    function bounds() {
        const a = from.input.valueAsNumber * 1000,
            b = to.input.valueAsNumber * 1000;
        if (
            !capture ||
            !Number.isFinite(a) ||
            !Number.isFinite(b) ||
            a < 0 ||
            b - a < 100 ||
            b > capture.clipMs + 1 ||
            b - a > 30000
        )
            throw new Error(text("invalidRange"));
        return [a, b];
    }
    async function play(mode) {
        const [fromMs, toMs] = bounds();
        pauseSource();
        await player.play({
            mode,
            buffer: getBuffer(),
            vocalStem: getVocalStem(capture),
            notes: workingNotes(capture),
            clipStartMs: capture.clipStartMs ?? 0,
            fromMs,
            toMs,
            loop: loop.checked,
            volume: getVolume(),
        });
    }
    const sourceButton = button("source", () => play("source"));
    const vocalButton = button("vocals", () => play("vocals"));
    const pianoButton = button("piano", () => play("piano"));
    const compareButton = button("compare", () => play("compare"));
    const vocalHint = el(
        "p",
        text("vocalHint"),
        "muted transcribe-status-line",
    );
    range.append(from.label, to.label);
    const transport = el("div", "", "play-controls");
    transport.append(
        sourceButton,
        vocalButton,
        pianoButton,
        compareButton,
        button("stop", stop),
        loopLabel,
    );
    const navigation = el("div", "", "play-controls");
    const summary = el("p", "", "muted transcribe-status-line");
    function move(direction) {
        stop();
        const width = Math.min(
            30000,
            Math.max(
                100,
                to.input.valueAsNumber * 1000 - from.input.valueAsNumber * 1000,
            ),
        );
        const begin = Math.max(
            0,
            Math.min(
                capture.clipMs - width,
                from.input.valueAsNumber * 1000 + direction * width,
            ),
        );
        from.input.value = String(begin / 1000);
        to.input.value = String(Math.min(capture.clipMs, begin + width) / 1000);
        renderList();
    }
    navigation.append(
        button("previous", () => move(-1)),
        button("next", () => move(1)),
    );
    const list = el("div", "", "melody-editor-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", text("notes"));
    const fields = el("div", "", "transcribe-fields");
    const pitch = number("pitch", 60, 0, 127, 1);
    const start = number("start", 0, 0, 600, 0.001);
    const duration = number("duration", 0.25, 0.001, 600, 0.001);
    const split = number("splitAt", 0.125, 0, 600, 0.001);
    fields.append(pitch.label, start.label, duration.label, split.label);
    const actions = el("div", "", "play-controls");
    const noteInput = () => ({
        note: pitch.input.valueAsNumber,
        timeMs: start.input.valueAsNumber * 1000,
        durationMs: duration.input.valueAsNumber * 1000,
    });
    function change(command) {
        if (busy || !capture) return;
        const before = workingNotes(capture);
        let after;
        try {
            after = editMelody(before, command, capture.clipMs);
        } catch {
            throw new Error(text("invalidEdit"));
        }
        history.push(before);
        if (history.length > MAX_HISTORY) history.shift();
        stop();
        onChange(after);
    }
    const update = button("apply", () =>
        change({ type: "update", index: selection, note: noteInput() }),
    );
    const add = button("add", () => change({ type: "add", note: noteInput() }));
    const remove = button("delete", () =>
        change({ type: "delete", index: selection }),
    );
    const splitButton = button("split", () =>
        change({
            type: "split",
            index: selection,
            atMs: split.input.valueAsNumber * 1000,
        }),
    );
    const merge = button("merge", () =>
        change({ type: "merge", index: selection }),
    );
    const undo = button("undo", () => {
        if (!history.length) return;
        stop();
        onChange(history.pop());
    });
    const reset = button("reset", () => {
        if (!window.confirm(text("confirmReset"))) return;
        history.push(workingNotes(capture));
        if (history.length > MAX_HISTORY) history.shift();
        stop();
        onChange(null);
    });
    const exportButton = button("export", () => {
        const [fromMs, toMs] = bounds();
        download(
            new Blob(
                [
                    JSON.stringify(
                        {
                            schema: "funcuby.melody-review",
                            version: 1,
                            referenceStatus: "unverified-draft",
                            sourceName: getName(),
                            clipStartMs: capture.clipStartMs ?? 0,
                            clipMs: capture.clipMs,
                            range: { fromMs, toMs },
                            recognizerNotes: capture.notes,
                            workingNotes: workingNotes(capture),
                        },
                        null,
                        2,
                    ),
                ],
                { type: "application/json" },
            ),
            `${getName()} · melody-review.json`,
        );
    });
    actions.append(
        update,
        add,
        remove,
        splitButton,
        merge,
        undo,
        reset,
        exportButton,
    );
    const editedStatus = el("p", "", "muted transcribe-status-line");
    host.append(
        heading,
        hint,
        range,
        transport,
        vocalHint,
        status,
        navigation,
        summary,
        list,
        fields,
        actions,
        editedStatus,
    );
    function select(index) {
        selection = index;
        const note = workingNotes(capture)[index];
        if (note) {
            pitch.input.value = String(note.note);
            start.input.value = String(Number((note.timeMs / 1000).toFixed(3)));
            duration.input.value = String(
                Number((note.durationMs / 1000).toFixed(3)),
            );
            split.input.value = String(
                Number(((note.timeMs + note.durationMs / 2) / 1000).toFixed(3)),
            );
        }
        for (const node of list.children)
            node.setAttribute(
                "aria-pressed",
                String(Number(node.dataset.index) === selection),
            );
        for (const node of [update, remove, splitButton, merge])
            node.disabled = busy || !note;
        merge.disabled ||=
            !note || workingNotes(capture)[index + 1]?.note !== note.note;
    }
    function renderList() {
        list.replaceChildren();
        if (!capture) return;
        const a = from.input.valueAsNumber * 1000,
            b = to.input.valueAsNumber * 1000;
        const notes = workingNotes(capture);
        const visible = notes
            .map((note, index) => ({ note, index }))
            .filter(
                ({ note }) =>
                    note.timeMs < b && note.timeMs + note.durationMs > a,
            );
        summary.textContent = t("transcribe.editor.count", {
            visible: Math.min(visible.length, PAGE_SIZE),
            total: visible.length,
        });
        for (const { note, index } of visible.slice(0, PAGE_SIZE)) {
            const flags = reviewFlags(notes, index).map((key) => text(key));
            const node = el(
                "button",
                `${noteName(note.note)} · ${(note.timeMs / 1000).toFixed(3)} s · ${(note.durationMs / 1000).toFixed(3)} s${flags.length ? ` · ${flags.join(" / ")}` : ""}`,
            );
            node.type = "button";
            node.dataset.index = String(index);
            node.disabled = busy;
            node.addEventListener("click", () => select(index));
            list.append(node);
        }
        if (!visible.length) list.append(el("p", text("empty"), "muted"));
        if (!visible.some((n) => n.index === selection))
            selection = visible[0]?.index ?? -1;
        select(selection);
    }
    for (const input of [from.input, to.input])
        input.addEventListener("change", () => {
            stop();
            renderList();
        });
    loop.addEventListener("change", stop);
    return {
        stop,
        render(value, disabled = false) {
            busy = disabled;
            capture = value;
            host.hidden = !capture;
            if (!capture) {
                original = null;
                history = [];
                stop();
                return;
            }
            if (capture.notes !== original) {
                original = capture.notes;
                history = [];
                selection = -1;
                from.input.value = "0";
                to.input.value = String(Math.min(10, capture.clipMs / 1000));
                stop();
            }
            from.input.max = to.input.max = String(capture.clipMs / 1000);
            for (const node of host.querySelectorAll("button,input"))
                node.disabled = busy;
            sourceButton.disabled = busy || !getBuffer();
            const hasVocal = Boolean(getVocalStem(capture));
            vocalButton.disabled = busy || !hasVocal;
            vocalHint.hidden = hasVocal;
            pianoButton.disabled = busy;
            compareButton.disabled = sourceButton.disabled;
            undo.disabled = busy || !history.length;
            reset.disabled = busy || capture.editedNotes === undefined;
            editedStatus.textContent = text(
                capture.editedNotes === undefined ? "raw" : "edited",
            );
            renderList();
        },
    };
}
