// Browser bundle entry for f5-core: re-exports everything the demo TTS worker
// needs. Bundled by tools/build-f5-browser.mjs into
// gh-pages-src/demo/f5-core.bundle.js (onnxruntime-web/common resolved from CDN).
export { F5TTS } from "./f5-tts.js";
export { Tensor } from "./tjs/utils/torch.js";
export * as torch from "./tjs/utils/torch.js";
export { calculateRMS, normalizeToInt16 } from "./audio.js";
export { createInferenceSession, deviceToExecutionProviders } from "./tjs/backends/onnx.js";
export { isWebGpuFp16Supported } from "./tjs/utils/devices.js";
