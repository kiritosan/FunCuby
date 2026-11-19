import {
    applyVocalBoundary,
    editMelody,
    reviewFlags,
    workingNotes,
} from "../../core/transcription/melody-edit.js";
import { noteName } from "../../core/music.js";
import { t } from "../../i18n/i18n.js";
import { download, el } from "../dom.js";
import { createPhrasePlayer } from "./phrase-player.js";
import { markSoundingNotes } from "./sounding-notes.js";
import { phraseRanges } from "../../core/transcription/phrase-ranges.js";
import { phrasePreviewIndex } from "./audition.js";

const PAGE_SIZE = 60;
const MAX_HISTORY = 20;

export function createMelodyEditor({
    host,
    getContext,
    piano,
    getBuffer,
    getVocalStem,
    vocalHintKey,
    getVolume,
    getBeat,
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
    const sounding = el("span", "", "melody-sounding");
    let ranges = [],
        rangeNotes = null;
    let visibleRows = [],
        rowOffset = 0;
    status.setAttribute("role", "status");
    const transportState = el("span"),
        clock = el("span");
    clock.setAttribute("aria-hidden", "true");
    status.append(transportState, clock);
    const player = createPhrasePlayer(getContext, piano, {
        onError,
        onUpdate: (state) => {
            host.dataset.playing = state.active ? state.mode : "";
            const label = state.active
                ? `${text(state.loading ? "loading" : "playing")} · ${text(state.mode)}`
                : text("stopped");
            if (transportState.textContent !== label)
                transportState.textContent = label;
            clock.textContent = state.active
                ? ` · ${((state.positionMs ?? 0) / 1000).toFixed(2)} s`
                : "";
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
    async function play(mode, notes = workingNotes(capture)) {
        const [fromMs, toMs] = bounds();
        pauseSource();
        await player.play({
            mode,
            beat: mode === "beat" ? getBeat() : undefined,
            buffer: getBuffer(),
            vocalStem: getVocalStem(capture),
            notes,
            clipStartMs: capture.clipStartMs ?? 0,
            fromMs,
            toMs,
            loop: loop.checked,
            onSounding: (voices) => {
                const lastIndex = voices?.at(-1)?.displayIndex;
                if (
                    lastIndex !== undefined &&
                    !list.querySelector(`[data-index="${lastIndex}"]`)
                ) {
                    const at = visibleRows.findIndex(
                        (row) => row.index === lastIndex,
                    );
                    if (at >= 0)
                        drawRows(Math.floor(at / PAGE_SIZE) * PAGE_SIZE);
                } else if (!voices && rowOffset && capture) drawRows(0);
                markSoundingNotes(list, sounding, voices);
                const lit = list.querySelector("[data-sounding]");
                if (lit) {
                    const row = lit.getBoundingClientRect(),
                        viewport = list.getBoundingClientRect();
                    if (row.bottom > viewport.bottom)
                        list.scrollTop += row.bottom - viewport.bottom;
                    else if (row.top < viewport.top)
                        list.scrollTop += row.top - viewport.top;
                }
            },
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
        button("beat", () => play("beat")),
        button("stop", stop),
        loopLabel,
        sounding,
    );
    const navigation = el("div", "", "play-controls");
    const summary = el("p", "", "muted transcribe-status-line");
    function adjacent(direction) {
        const fromMs = from.input.valueAsNumber * 1000,
            toMs = to.input.valueAsNumber * 1000;
        return direction > 0
            ? ranges.find((r) => r.end > toMs + 0.01)
            : ranges.findLast((r) => r.start < fromMs - 0.01);
    }
    function move(direction) {
        const target = adjacent(direction);
        if (!target) return;
        stop();
        from.input.value = String(target.start / 1000);
        to.input.value = String(target.end / 1000);
        renderList();
    }
    const previous = button("previous", () => move(-1)),
        next = button("next", () => move(1));
    navigation.append(previous, next);
    const nextBoundary = button("nextBoundary", () => {
        const notes = workingNotes(capture);
        let index = notes.findIndex((n, i) => i > selection && n.boundary);
        if (index < 0) index = notes.findIndex((n) => n.boundary);
        if (index < 0) return;
        stop();
        selection = index;
        const note = notes[index];
        // Include both sides of the proposed rest even in a very long note.
        const release = note.timeMs + note.boundary.releaseMs;
        const resume =
            note.timeMs + (note.boundary.repeatMs ?? note.boundary.releaseMs);
        const begin = Math.max(0, release - 650);
        from.input.value = String(begin / 1000);
        to.input.value = String(
            Math.min(capture.clipMs, begin + 30000, resume + 800) / 1000,
        );
        renderList();
    });
    navigation.append(nextBoundary);
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
    const boundaryPanel = el("div", "", "play-controls");
    const boundaryDetail = el("span", "", "muted");
    boundaryPanel.append(
        boundaryDetail,
        button("previewBefore", () => play("piano")),
        button("previewAfter", () =>
            play(
                "piano",
                workingNotes(capture).flatMap((n, i) =>
                    i === selection
                        ? applyVocalBoundary(n).map((part) => ({
                              ...part,
                              displayIndex: i,
                          }))
                        : [{ ...n, displayIndex: i }],
                ),
            ),
        ),
        button("acceptBoundary", () =>
            change({ type: "boundary", index: selection }),
        ),
    );
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
        history.push(capture.editedNotes ?? null);
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
    const quick = el("div", "", "play-controls"),
        times = el("p", "", "muted");
    const quickButtons = ["lower", "higher", "shorter", "longer"].map(
        (key, i) =>
            button(key, () => {
                const n = workingNotes(capture)[selection];
                const changeTo =
                    i < 2
                        ? { note: n.note + (i ? 1 : -1) }
                        : {
                              durationMs: Math.min(
                                  capture.clipMs - n.timeMs,
                                  Math.max(
                                      20,
                                      n.durationMs + (i === 2 ? -50 : 50),
                                  ),
                              ),
                          };
                change({ type: "update", index: selection, note: changeTo });
            }),
    );
    quick.append(...quickButtons, undo);
    const precise = el("details");
    precise.append(el("summary", text("precise")), fields, actions);
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
        boundaryPanel,
        times,
        quick,
        precise,
        editedStatus,
    );
    function select(index) {
        selection = index;
        const note = workingNotes(capture)[index];
        times.textContent = note
            ? t("transcribe.editor.timestamps", {
                  source: (
                      (note.timeMs + (capture.clipStartMs ?? 0)) /
                      1000
                  ).toFixed(2),
                  clip: (note.timeMs / 1000).toFixed(2),
              })
            : "";
        quickButtons.forEach(
            (b, i) =>
                (b.disabled =
                    busy ||
                    !note ||
                    (i === 0 && note.note === 0) ||
                    (i === 1 && note.note === 127) ||
                    (i === 2 && note.durationMs <= 20) ||
                    (i === 3 &&
                        note.timeMs + note.durationMs >= capture.clipMs)),
        );
        boundaryPanel.hidden = !note?.boundary;
        if (note?.boundary) {
            const at = (offset) => ((note.timeMs + offset) / 1000).toFixed(2);
            boundaryDetail.textContent = t(
                note.boundary.repeatMs === undefined
                    ? "transcribe.editor.releaseDetail"
                    : "transcribe.editor.repeatDetail",
                {
                    at: at(note.boundary.releaseMs),
                    again: at(note.boundary.repeatMs ?? 0),
                },
            );
        }
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
        nextBoundary.hidden = !notes.some((n) => n.boundary);
        previous.disabled = busy || !adjacent(-1);
        next.disabled = busy || !adjacent(1);
        visibleRows = notes
            .map((note, index) => ({ note, index }))
            .filter(
                ({ note }) =>
                    note.timeMs < b && note.timeMs + note.durationMs > a,
            );
        if (!visibleRows.some((n) => n.index === selection))
            selection = visibleRows[0]?.index ?? -1;
        drawRows(0);
        select(selection);
    }
    function drawRows(offset) {
        list.replaceChildren();
        rowOffset = offset;
        const notes = workingNotes(capture);
        summary.textContent = t("transcribe.editor.count", {
            visible: Math.min(visibleRows.length - offset, PAGE_SIZE),
            total: visibleRows.length,
        });
        for (const { note, index } of visibleRows.slice(
            offset,
            offset + PAGE_SIZE,
        )) {
            const flags = reviewFlags(notes, index).map((key) => text(key));
            const node = el(
                "button",
                `${noteName(note.note)} · ${(note.timeMs / 1000).toFixed(3)} s · ${(note.durationMs / 1000).toFixed(3)} s${flags.length ? ` · ${flags.join(" / ")}` : ""}`,
            );
            node.type = "button";
            node.dataset.index = String(index);
            node.setAttribute("aria-pressed", String(index === selection));
            node.disabled = busy;
            node.addEventListener("click", () => select(index));
            list.append(node);
        }
        if (!visibleRows.length) list.append(el("p", text("empty"), "muted"));
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
            if (rangeNotes !== workingNotes(capture)) {
                rangeNotes = workingNotes(capture);
                ranges = phraseRanges(rangeNotes, capture.clipMs);
            }
            if (capture.notes !== original) {
                rowOffset = 0;
                original = capture.notes;
                history = [];
                selection = -1;
                const firstOnset =
                    rangeNotes[phrasePreviewIndex(rangeNotes)]?.timeMs;
                const opening =
                    ranges.find(
                        (r) => r.start <= firstOnset && firstOnset < r.end,
                    ) ?? ranges[0];
                from.input.value = String(opening.start / 1000);
                to.input.value = String(opening.end / 1000);
                stop();
            }
            from.input.max = to.input.max = String(capture.clipMs / 1000);
            for (const node of host.querySelectorAll("button,input"))
                node.disabled = busy;
            sourceButton.disabled = busy || !getBuffer();
            const hasVocal = Boolean(getVocalStem(capture));
            vocalButton.disabled = busy || !hasVocal;
            vocalHint.hidden = hasVocal;
            if (!hasVocal) vocalHint.textContent = text(vocalHintKey());
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
