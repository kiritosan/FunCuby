import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor");

const version = async (name) =>
    JSON.parse(
        await readFile(
            join(root, "node_modules", name, "package.json"),
            "utf8",
        ),
    ).version;

await mkdir(vendor, { recursive: true });
await build({
    entryPoints: [join(root, "scripts", "transcription-runtime.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome100",
    outfile: join(vendor, "transcription-runtime.js"),
    minify: true,
    logLevel: "warning",
});

// The Basic Pitch model ships inside the package; the worker loads it same-origin.
await mkdir(join(vendor, "basic-pitch"), { recursive: true });
await cp(
    join(root, "node_modules", "@spotify", "basic-pitch", "model"),
    join(vendor, "basic-pitch"),
    { recursive: true },
);
await cp(
    join(root, "node_modules", "@spotify", "basic-pitch", "LICENSE"),
    join(vendor, "basic-pitch", "LICENSE"),
);
await mkdir(join(vendor, "licenses"), { recursive: true });
await cp(
    join(root, "node_modules", "@spotify", "basic-pitch", "LICENSE"),
    join(vendor, "licenses", "Apache-2.0.txt"),
);
await cp(
    join(root, "node_modules", "esbuild", "LICENSE.md"),
    join(vendor, "licenses", "esbuild-LICENSE.md"),
);

const tfjs = await version("@tensorflow/tfjs");
const pitch = await version("@spotify/basic-pitch");
const bundler = await version("esbuild");
await writeFile(
    join(vendor, "licenses", "NOTICE.txt"),
    [
        "FunCuby transcription runtime — bundled third-party components",
        "",
        `@tensorflow/tfjs@${tfjs} — Apache-2.0 (license text reproduced in Apache-2.0.txt; the package ships no license file)`,
        `@spotify/basic-pitch@${pitch} — Apache-2.0, see ../basic-pitch/LICENSE and Apache-2.0.txt`,
        `esbuild@${bundler} — MIT, see esbuild-LICENSE.md`,
        "",
        "Full attribution: THIRD_PARTY_NOTICES.md at the repository root.",
        "",
    ].join("\n"),
);

console.log(
    `vendor/transcription-runtime.js + vendor/basic-pitch/ built (${pitch}, tfjs ${tfjs})`,
);
