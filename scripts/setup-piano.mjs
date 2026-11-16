import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../vendor/piano/", import.meta.url));
const revision = "efd8296360f9526e379bfbe5c1698ff54d6a1d34";
const samples = [
    ["A0.mp3", 113969, "0f8ccd9719dcad3fc5999b8cb3fd21486dfafd6a"],
    ["A1.mp3", 115061, "0b2ff3a2688c890f3aaa6b98805cb8959d997890"],
    ["A2.mp3", 81678, "c46996922c542f7a2ccf881a268e7a1ce008458b"],
    ["A3.mp3", 74526, "57924c5572fd136eca8e4dad444a8d8e22b7bbc5"],
    ["A4.mp3", 61148, "3b19af879f0e0bc07a02cff767b3ff4e95400884"],
    ["A5.mp3", 45747, "d17d5532527d4af7fccfbc7638af3dbc1ec5e9f3"],
    ["A6.mp3", 30013, "8464e29082f6ecff0491759b7c98ec424df60fda"],
    ["A7.mp3", 18730, "5e5aa4dc53b2825684740467a194ee9ac6fd76b8"],
    ["C1.mp3", 110199, "2b840fc55266201f40769bbfb3c721c7f6ed55fc"],
    ["C2.mp3", 110357, "3fca8d06f2544e9203439b83fc609ffdf7ff7174"],
    ["C3.mp3", 78036, "14daa30a2a796149883396b60ef84a3e16e48206"],
    ["C4.mp3", 78718, "d5f5819d32641247e33a452df3c81bd3f71422e8"],
    ["C5.mp3", 68920, "7064bc84bf13b14f2d8e7ec2dcfa69b2c80a8c06"],
    ["C6.mp3", 28065, "c8e20f649bc1ab5d91803c2d97e4c279553496cc"],
    ["C7.mp3", 18963, "4cf780bba322f85942dadfeb08f55693028569c0"],
    ["C8.mp3", 18914, "9297538c383fddc416b618a37697180e302d5b14"],
    ["Ds1.mp3", 120625, "a5d68f53d927dfdd405828984bd65dd6792c36d7"],
    ["Ds2.mp3", 110796, "9e7cf544f0656a3cb9fcebd2c6e9d4da4efb8eda"],
    ["Ds3.mp3", 78717, "ba3cc489b1fbde1fc14b5f5d6001bf76a3845721"],
    ["Ds4.mp3", 73519, "f13123332b689eaa5af6e15e8522c09b6823aeb0"],
    ["Ds5.mp3", 58179, "9a6a24b7076dbdf922a6540896dd058ab56841ec"],
    ["Ds6.mp3", 31395, "14b38cd4717f5f7cfa1c4748341dcf7de3fd294b"],
    ["Ds7.mp3", 22136, "ea3e885f21f330c7313350f74fd58911b5948777"],
    ["Fs1.mp3", 115010, "254ecc45bc5d91d6667095e9aa8f29e05b4a3fac"],
    ["Fs2.mp3", 102320, "3d1de69b4a8c8644512c775360561c0db6b6db35"],
    ["Fs3.mp3", 77933, "c0971905449a89cab35ec7c5d654ea344a9cb90b"],
    ["Fs4.mp3", 68219, "780ba594653d6774b55ef1bcdc3d7513156b269d"],
    ["Fs5.mp3", 51597, "5d4fcac5facadbe2a449af7a066fe24fb6dea782"],
    ["Fs6.mp3", 26478, "ba3e062847ff431b0f9cafdcff6ce7f6ee5a46f2"],
    ["Fs7.mp3", 22709, "431195300fbb91e9dbc3332b48063e17d35d9066"],
];
const hash = (bytes) =>
    createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");

await mkdir(directory, { recursive: true });
let cursor = 0;
await Promise.all(
    Array.from({ length: 4 }, async () => {
        while (cursor < samples.length) {
            const [name, size, expected] = samples[cursor++];
            const target = new URL(
                name,
                new URL("../vendor/piano/", import.meta.url),
            );
            const existing = await readFile(target).catch(() => null);
            if (existing?.length === size && hash(existing) === expected)
                continue;
            let bytes;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const response = await fetch(
                        `https://tonejs.github.io/audio/salamander/${name}`,
                        { signal: AbortSignal.timeout(30000) },
                    );
                    if (!response.ok)
                        throw new Error(`HTTP ${response.status}`);
                    bytes = Buffer.from(await response.arrayBuffer());
                    if (bytes.length !== size || hash(bytes) !== expected)
                        throw new Error(
                            `Piano sample integrity check failed: ${name}`,
                        );
                    break;
                } catch (error) {
                    if (attempt === 2) throw error;
                }
            }
            await writeFile(target, bytes);
            console.log(`Piano: ${name}`);
        }
    }),
);
await writeFile(
    new URL("../vendor/piano/NOTICE.txt", import.meta.url),
    [
        "Salamander Grand Piano v3 by Alexander Holm.",
        "Licensed under Creative Commons Attribution 3.0 Unported.",
        "https://creativecommons.org/licenses/by/3.0/",
        "MP3 distribution: https://github.com/Tonejs/audio/tree/master/salamander",
        `Source revision: ${revision}`,
        "Samples are copied without modification; playback repitches and envelopes them.",
        "Full attribution and license: THIRD_PARTY_NOTICES.md and licenses/CC-BY-3.0.txt.",
        "",
    ].join("\n"),
);
console.log("Piano: 30 verified local samples ready (2.01 MB)");
