import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import process from "node:process";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openTestBrowser(profile) {
    const browser = spawn(
        process.env.BROWSER ||
            "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            "--lang=zh-CN",
            "--autoplay-policy=no-user-gesture-required",
            `--user-data-dir=${resolve(".test-artifacts", profile)}`,
            "about:blank",
        ],
        { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const endpoint = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
            () => reject(new Error("Browser startup timed out")),
            20000,
        );
        browser.stderr.on("data", (chunk) => {
            output += chunk;
            const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        browser.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    const targets = await (
        await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)
    ).json();
    const socket = new WebSocket(
        targets.find((item) => item.type === "page").webSocketDebuggerUrl,
    );
    await once(socket, "open");
    const pending = new Map(),
        errors = [];
    let seq = 0;
    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) {
            const callback = pending.get(message.id);
            if (!callback) return;
            pending.delete(message.id);
            clearTimeout(callback.timer);
            message.error
                ? callback.reject(new Error(JSON.stringify(message.error)))
                : callback.resolve(message.result);
        } else if (message.method === "Runtime.exceptionThrown")
            errors.push(message.params.exceptionDetails);
        else if (
            message.method === "Runtime.consoleAPICalled" &&
            message.params.type === "error"
        )
            errors.push(
                message.params.args.map(
                    (item) => item.value ?? item.description,
                ),
            );
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, {
                resolve,
                reject,
                timer: setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`CDP ${method} timed out`));
                }, 20000),
            });
            socket.send(JSON.stringify({ id, method, params }));
        });
    const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails)
            throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const until = async (expression) => {
        for (let i = 0; i < 200; i++) {
            if (await evaluate(expression)) return true;
            await wait(100);
        }
        throw new Error(`Timed out: ${expression}`);
    };
    await send("Runtime.enable");
    await send("Page.enable");
    return {
        send,
        evaluate,
        until,
        errors,
        async close() {
            const exited = once(browser, "exit");
            await Promise.race([
                send("Browser.close").catch(() => {}),
                wait(2000),
            ]);
            await Promise.race([exited, wait(5000)]);
            socket.close();
            for (const item of pending.values()) {
                clearTimeout(item.timer);
                item.reject(new Error("Test browser closed"));
            }
            pending.clear();
            if (browser.exitCode === null) browser.kill();
        },
    };
}
