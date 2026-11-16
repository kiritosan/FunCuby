import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
const tools = new URL(".tools/", root);
const archive = new URL("GAME-1.0.3-small-onnx.zip", tools);
const url =
    "https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-small-onnx.zip";
const size = 45676364;
const sha256 =
    "00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8";
await mkdir(tools, { recursive: true });
const deadline = Date.now() + 12 * 60 * 1000;
let offset = (await stat(archive).catch(() => null))?.size ?? 0;
if (offset > size)
    throw new Error(
        "Unexpected model archive size; inspect the existing cache.",
    );
while (offset < size) {
    if (Date.now() > deadline)
        throw new Error("Model download timed out. Rerun to resume.");
    const initial = offset;
    try {
        const response = await fetch(url, {
            headers: {
                Range: `bytes=${offset}-${Math.min(size - 1, offset + 4 * 1024 * 1024 - 1)}`,
            },
            signal: AbortSignal.timeout(90000),
        });
        if (
            response.status !== 206 ||
            !response.headers
                .get("content-range")
                ?.startsWith(`bytes ${offset}-`)
        )
            throw new Error(
                `Expected a resumable model response, received ${response.status}`,
            );
        const file = await open(archive, "a");
        try {
            for await (const chunk of response.body) {
                if (offset + chunk.length > size)
                    throw new Error("Model response exceeds expected size");
                await file.writeFile(chunk);
                offset += chunk.length;
            }
        } finally {
            await file.close();
        }
        console.log(`GAME download: ${((offset / size) * 100).toFixed(1)}%`);
    } catch (error) {
        if (offset === initial) throw error;
        console.log(`GAME download interrupted at ${offset} bytes; resuming.`);
    }
}
const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
if (digest !== sha256)
    throw new Error("GAME archive checksum mismatch; model was not installed.");
const run = promisify(execFile);
const python =
    process.env.FUNCUBY_GAME_PYTHON || process.env.PYTHON || "python";
const target = fileURLToPath(new URL("game-model/", tools));
await run(python, ["-m", "zipfile", "-e", fileURLToPath(archive), target]);
console.log(`GAME 1.0.3 small ONNX: verified and extracted into ${target}`);
console.log(
    "Model weights: CC BY-NC-SA 4.0. See docs/melody-quality.md before redistribution.",
);
