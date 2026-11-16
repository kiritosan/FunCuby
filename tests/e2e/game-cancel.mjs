import assert from "node:assert/strict";
import process from "node:process";

const base = process.env.BASE_URL || "http://127.0.0.1:5173";
const headers = { Origin: base, "Content-Type": "application/octet-stream" };
const controller = new AbortController();
const response = await fetch(base + "/api/transcription/game", {
    method: "POST",
    headers,
    signal: controller.signal,
    body: new Float32Array(44100 * 219),
});
assert.equal(response.status, 200);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let text = "";
const timer = setTimeout(() => controller.abort(), 20000);
try {
    while (!text.includes('"warming"')) {
        const { value, done } = await reader.read();
        assert.equal(
            done,
            false,
            "inference ended before the cancellation checkpoint",
        );
        text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    await reader.cancel().catch(() => {});
} finally {
    clearTimeout(timer);
}

// The server keeps its semaphore until child exit/cleanup. Recovery well under
// its five-second kill grace proves this is not just a released busy flag.
const deadline = Date.now() + 3000;
let retry;
while (Date.now() < deadline) {
    retry = await fetch(base + "/api/transcription/game", {
        method: "POST",
        headers,
        body: new Float32Array(44100),
    });
    if (retry.status !== 409) break;
    await retry.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.equal(
    retry.status,
    200,
    "owned inference process did not cancel promptly",
);
const events = (await retry.text()).trim().split("\n").map(JSON.parse);
assert.equal(events.at(-1).type, "result");
console.log(
    "PASS: real ONNX inference cancels and an explicit retry completes",
);
