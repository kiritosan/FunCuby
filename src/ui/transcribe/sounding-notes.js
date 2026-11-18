import { noteName } from "../../core/music.js";
import { t } from "../../i18n/i18n.js";

export function markSoundingNotes(container, label, voices) {
    const active = new Set(voices?.map((n) => n.displayIndex));
    for (const row of container.querySelectorAll("[data-index]"))
        row.toggleAttribute(
            "data-sounding",
            active.has(Number(row.dataset.index)),
        );
    if (!voices) label.textContent = "";
    else if (!voices.length) label.textContent = t("transcribe.editor.rest");
    else
        label.textContent =
            "♪ " +
            [...new Set(voices.map((n) => noteName(n.note)))].join(" + ");
}
