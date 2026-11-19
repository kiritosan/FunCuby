import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "../../server.js";
import { openTestBrowser } from "./browser.mjs";

// Use the real file picker, page handoff, BLE MIDI decoder and audio scheduler.
// Only the physical peripheral is simulated.
await mkdir(".test-artifacts", { recursive: true });
const libraryDirectory = await mkdtemp(resolve(".test-artifacts/practice-"));
const port = 18597,
    base = "http://127.0.0.1:" + port;
const server = createServer({ port, libraryDirectory });
server.listen(port, "127.0.0.1");
await once(server, "listening");
let browser;
try {
    const id = crypto.randomUUID(),
        state = {
            version: 1,
            sourceId: id,
            level: "melody",
            firstNote: 60,
            settings: {
                "transcribe-engine": "basic-pitch",
                "transcribe-start": "0",
                "transcribe-length": "6",
                "transcribe-bpm": "120",
                "transcribe-origin": "0",
                "transcribe-transpose": "5",
            },
            captures: [
                [
                    "basic-pitch",
                    {
                        clipMs: 6000,
                        clipStartMs: 0,
                        notes: [0, 500, 1000, 1500].map((timeMs, i) => ({
                            note: 60 + i,
                            timeMs,
                            durationMs: 250,
                            velocity: 80,
                        })),
                    },
                ],
            ],
        };
    const wav = Buffer.alloc(44 + 6 * 16000 * 2);
    wav.write("RIFF");
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(wav.length - 44, 40);
    for (let i = 0; i < 96000; i++)
        wav.writeInt16LE(
            Math.round(6000 * Math.sin((i * 2 * Math.PI * 220) / 16000)),
            44 + i * 2,
        );
    const form = new FormData();
    form.set("state", JSON.stringify(state));
    form.set("source", new Blob([wav], { type: "audio/wav" }), "practice.wav");
    assert.equal(
        (
            await fetch(base + "/api/library/" + id, {
                method: "POST",
                headers: { Origin: base },
                body: form,
            })
        ).status,
        201,
    );
    browser = await openTestBrowser("practice-challenge");
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `const peripheral=new EventTarget(), ch=new EventTarget();
        ch.properties={notify:true,writeWithoutResponse:true};ch.startNotifications=async()=>ch;
        peripheral.name="EP-1S";peripheral.gatt={connected:true,connect:async()=>({getPrimaryService:async()=>({getCharacteristic:async()=>ch})})};
        Object.defineProperty(navigator,"bluetooth",{value:{requestDevice:async()=>peripheral}});
        window.pressMidi=(note,velocity=80)=>{ch.value=new DataView(Uint8Array.of(128,128,144,note,velocity).buffer);ch.dispatchEvent(new Event("characteristicvaluechanged"))};
        window.starts=[];const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(when,offset,...rest){if(this.buffer?.sampleRate===24000)starts.push({offset,when,duration:this.buffer.duration});return start.call(this,when,offset,...rest)};`,
    });
    await browser.send("Page.navigate", { url: base + "/#transcribe" });
    const click = (id) =>
        browser.evaluate(`document.getElementById("${id}").click()`);
    await browser.until(
        "document.querySelector('#transcribe-practice')?.disabled === false",
    );
    await click("transcribe-practice");
    await browser.until("location.hash==='#teach'");
    await click("teach-demo");
    await browser.until(
        "document.getElementById('teach-demo').textContent.includes('停止')",
    );
    await click("teach-demo");
    await click("teach-connect");
    await browser.until("!document.getElementById('teach-start').disabled");
    await click("teach-challenge");
    await browser.until(
        "starts.length===1 && document.querySelector('#panel-teach').classList.contains('practice-focus')",
    );
    await click("teach-pause");
    await click("teach-pause");
    await browser.until("starts.length===2");
    await click("teach-stop");
    await browser.until("!document.getElementById('teach-results').hidden");
    assert.equal(
        await browser.evaluate(
            "document.getElementById('teach-final-rank').hidden",
        ),
        true,
    );
    assert.match(
        await browser.evaluate(
            "document.getElementById('teach-result-timing').textContent",
        ),
        /0\/4/,
    );
    await click("teach-replay");
    await browser.until(
        "!document.getElementById('teach-results').hidden && !document.getElementById('teach-final-rank').hidden",
        12000,
    );
    assert.ok(
        await browser.evaluate(
            "Object.keys(localStorage).some(k=>k.includes('teach:best:'))",
        ),
    );
    await click("teach-retry-weak");
    await browser.until(
        "!document.querySelector('#teach-assist').hidden",
        10000,
    );
    const before = await browser.evaluate(
        "document.getElementById('teach-count').textContent",
    );
    await browser.evaluate(
        "for(let n=60;n<=84;n++){pressMidi(n);pressMidi(n,0)}",
    );
    assert.notEqual(
        await browser.evaluate(
            "document.getElementById('teach-count').textContent",
        ),
        before,
    );
    await click("teach-stop");
    await browser.evaluate(
        `(async()=>{const {transcriptionMidi}=await import('/src/core/arrangement.js');const bytes=transcriptionMidi([48,60,64].map((note,i)=>({note,timeMs:i*500,durationMs:200,velocity:90})));const data=new DataTransfer();data.items.add(new File([bytes],"range.mid"));const f=document.querySelector("#teach-file");f.files=data.files;f.dispatchEvent(new Event("change"));})()`,
    );
    await browser.until(
        "document.querySelector('#teach-summary').textContent.includes('range.mid') && !document.querySelector('#teach-range-tools').hidden",
    );
    assert.equal(
        await browser.evaluate(
            "document.querySelector('#teach-start').disabled",
        ),
        true,
    );
    await browser.evaluate(
        "const policy=document.querySelector('#teach-range-policy');policy.value='12';policy.dispatchEvent(new Event('change'))",
    );
    await browser.until("!document.querySelector('#teach-start').disabled");
    assert.deepEqual(browser.errors, []);
    console.log(
        "PASS: preview, connect, focus, transposed backing, pause/resume, partial grading, personal record, missed bars, follow input and octave preflight",
    );
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
}
