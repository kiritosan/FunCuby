import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveTools } from "../server/audio-import.js";
import { transcriptionMidi } from "../src/core/arrangement.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const allowed = new Set(["--input", "--start", "--seconds", "--language"]);
const options = {};
for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || options[args[i]] !== undefined)
        throw new Error(
            "Usage: npm run evaluate:separation -- --input PATH --start 60 --seconds 24 --language zh",
        );
    options[args[i]] = args[i + 1];
}
if (!options["--input"])
    throw new Error("--input must name a local audio file");
const input = resolve(options["--input"]);
const start = Number(options["--start"] ?? 0);
const seconds = Number(options["--seconds"] ?? 24);
const language = options["--language"] ?? "zh";
if (
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(seconds) ||
    seconds < 1 ||
    seconds > 30 ||
    !["auto", "zh", "en", "ja", "yue"].includes(language)
)
    throw new Error(
        "Expected nonnegative start and 1-30 seconds, plus a supported language",
    );
const inputInfo = await stat(input);
if (!inputInfo.isFile() || inputInfo.size > 50 * 1024 * 1024)
    throw new Error("Expected a local file up to 50 MiB");
const artifacts = join(root, ".test-artifacts");
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(join(artifacts, "separation-"));
const tools = resolveTools({ root });
if (!tools.ffmpeg) throw new Error("ffmpeg is required");

function run(command, argv, timeout) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, argv, {
            cwd: root,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "inherit", "inherit"],
        });
        let failure = null;
        const timer = setTimeout(() => {
            failure = new Error("Evaluation exceeded its time budget");
            child.kill();
        }, timeout);
        const interrupt = () => {
            failure = new Error("Evaluation cancelled");
            child.kill();
        };
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", interrupt);
        child.once("error", (error) => {
            clearTimeout(timer);
            process.removeListener("SIGINT", interrupt);
            process.removeListener("SIGTERM", interrupt);
            reject(error);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            process.removeListener("SIGINT", interrupt);
            process.removeListener("SIGTERM", interrupt);
            if (failure || code !== 0)
                reject(
                    failure ||
                        new Error(`Owned evaluation process exited ${code}`),
                );
            else resolve();
        });
    });
}
// A new unique directory is used on every run; no existing artifacts are replaced.
const wav = join(output, "input.wav");
await run(
    tools.ffmpeg,
    [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(seconds),
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        wav,
    ],
    60000,
);
const python = process.env.FUNCUBY_GAME_PYTHON || "python";
await run(
    python,
    [
        join(root, "scripts", "evaluate-separation.py"),
        "--input",
        wav,
        "--output-dir",
        output,
        "--language",
        language,
    ],
    20 * 60 * 1000,
);
const reportPath = join(output, "comparison.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
report.source = {
    sha256: createHash("sha256")
        .update(await readFile(input))
        .digest("hex"),
    startSeconds: start,
    requestedSeconds: seconds,
};
await writeFile(reportPath, JSON.stringify(report, null, 2));
for (const [name, notes] of Object.entries(report.candidates))
    await writeFile(
        join(output, `${name}.mid`),
        transcriptionMidi(notes, {
            bpm: 120,
            name: `${name} unverified draft`,
        }),
    );
await writeFile(
    join(output, "compare.html"),
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Local Separation Comparison</title>
<style>body{font:18px Georgia,serif;max-width:800px;margin:3rem auto;padding:0 1rem;background:#f4f1e9;color:#22342e}section{border-top:1px solid #bcc6bd;padding:1rem 0}audio{width:100%}a{color:#155f4d}</style>
<h1>Local Separation Comparison</h1><p>Unverified drafts, not a reference score. Audio uses one shared gain, not separate loudness normalization. Compare the same timestamps; play one source at a time.</p>
${["mix", "vocals", "accompaniment"].map((name) => `<section><h2>${name}</h2><audio controls src="${name}.wav"></audio>${name !== "accompaniment" ? `<p><a href="${name}.mid" download>Download ${name} GAME draft MIDI</a> (${report.candidates[name].length} notes)</p>` : ""}</section>`).join("")}
<p>Import either MIDI in FunCuby for identical piano rendering. Stem isolation and fewer notes do not prove lead accuracy.</p>
<a href="comparison.json">Parameters and comparison data</a></html>`,
);
if (!isAbsolute(output))
    throw new Error("Expected absolute artifact directory");
console.log(`Comparison ready: ${join(output, "compare.html")}`);
console.log(
    "No main workbench audio, model defaults or saved edits were replaced.",
);
