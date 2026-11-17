import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";

const target = new URL("../.tools/UVR-MDX-NET-Voc_FT.onnx", import.meta.url);
const url =
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx";
const size = 66762490;
const hash = "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111";
await mkdir(new URL("../.tools/", import.meta.url), { recursive: true });
const deadline = Date.now() + 20 * 60 * 1000;
let offset = (await stat(target).catch(() => null))?.size ?? 0;
if (offset > size)
    throw new Error(
        "Unexpected cached model size; inspect it before retrying.",
    );
while (offset < size) {
    if (Date.now() > deadline)
        throw new Error("Download timed out; rerun to resume.");
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
                `Expected resumable response, got HTTP ${response.status}`,
            );
        const file = await open(target, "a");
        try {
            for await (const chunk of response.body) {
                if (offset + chunk.length > size)
                    throw new Error("Model exceeds pinned size");
                await file.writeFile(chunk);
                offset += chunk.length;
            }
        } finally {
            await file.close();
        }
        console.log(`UVR model: ${((offset / size) * 100).toFixed(1)}%`);
    } catch (error) {
        if (offset === initial) throw error;
        console.log(`Interrupted at ${offset} bytes; resuming`);
    }
}
const digest = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
if (digest !== hash)
    throw new Error("Model checksum mismatch. The cached model is not usable.");
console.log(
    "Verified UVR-MDX-NET-Voc_FT ONNX model (66.76 MB), CPU evaluation ready.",
);
