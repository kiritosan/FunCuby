import { tf } from "../../vendor/transcription-runtime.js";

self.onmessage = async () => {
    try {
        const initialized = await tf.setBackend("webgl");
        await tf.ready();
        const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
        const info = gl?.getExtension("WEBGL_debug_renderer_info");
        self.postMessage({
            webglReady: initialized && tf.getBackend() === "webgl",
            actualBackend: tf.getBackend(),
            tfjs: tf.version.tfjs,
            renderer: info
                ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
                : null,
        });
    } catch (error) {
        self.postMessage({
            webglReady: false,
            error: String(error?.message ?? error),
        });
    }
};
