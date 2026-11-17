import { t } from "../../i18n/i18n.js";
import { el } from "../dom.js";

export function pipelineWindows(snapshot, step) {
    const { engine, separationWindows, totalWindows, completedWindows } =
        snapshot;
    if (!totalWindows) return null;
    if (step === "separate" && separationWindows)
        return {
            done: Math.min(completedWindows, separationWindows),
            total: separationWindows,
        };
    if (["browser", "game"].includes(step)) {
        const offset = separationWindows ?? 0;
        if (engine === "game-separated" && !offset) return null;
        return {
            done: Math.max(0, completedWindows - offset),
            total: totalWindows - offset,
        };
    }
    return null;
}

export function createPipelineView(host, list) {
    let engine, rows;

    return {
        reset() {
            host.hidden = true;
        },
        render(snapshot) {
            const separated = snapshot.engine === "game-separated";
            const inference =
                snapshot.engine === "basic-pitch" ? "browser" : "game";
            if (snapshot.engine !== engine) {
                engine = snapshot.engine;
                const steps = [
                    "prepare",
                    "load",
                    ...(separated ? ["separate"] : []),
                    inference,
                    "finish",
                ];
                rows = steps.map((step) => {
                    const label = t(`transcribe.pipeline.${step}`);
                    const row = el("li");
                    row.dataset.step = step;
                    const meter = el("progress");
                    meter.setAttribute("aria-label", label);
                    const detail = el("span", "", "muted");
                    row.append(el("strong", label), meter, detail);
                    if (step === "separate")
                        row.append(
                            el(
                                "span",
                                t("transcribe.pipeline.uvrDetail"),
                                "muted",
                            ),
                        );
                    return { step, row, meter, detail };
                });
                list.replaceChildren(...rows.map(({ row }) => row));
            }
            const currentStep = {
                preparing: "prepare",
                initializing: "load",
                loading: "load",
                warming: separated ? "separate" : inference,
                separating: "separate",
                "loading-game": "game",
                transcribing: inference,
                extracting: "finish",
            }[snapshot.stage];
            const current = rows.findIndex(({ step }) => step === currentStep);
            rows.forEach(({ step, row, meter, detail }, i) => {
                const state =
                    snapshot.status === "completed" || i < current
                        ? "done"
                        : i === current
                          ? snapshot.status
                          : "pending";
                row.dataset.state = state;
                if (i === current && state === "running")
                    row.setAttribute("aria-current", "step");
                else row.removeAttribute("aria-current");
                const windows =
                    state !== "pending" && pipelineWindows(snapshot, step);
                meter.hidden = state !== "running" && !windows;
                if (windows) {
                    meter.max = windows.total;
                    meter.value = windows.done;
                } else {
                    meter.removeAttribute("value");
                }
                const text = t(`transcribe.pipeline.${state}`);
                const summary = windows
                    ? `${text} · ${t("transcribe.diag.windows", windows)}`
                    : text;
                if (detail.textContent !== summary)
                    detail.textContent = summary;
            });
            host.hidden = false;
        },
    };
}
