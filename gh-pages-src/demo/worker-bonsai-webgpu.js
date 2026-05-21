// Bonsai-WebGPU inference worker
// Directly implements the bonsai-webgpu Space inference engine
// Uses @huggingface/transformers v4 with ONNX-community Bonsai ONNX models
// ref: https://huggingface.co/spaces/webml-community/bonsai-webgpu

import {
  pipeline,
  TextStreamer,
  DynamicCache,
  InterruptableStoppingCriteria,
} from "@huggingface/transformers";

// Bonsai ONNX models from onnx-community
const MODEL_IDS = {
  "1.7b": "onnx-community/Bonsai-1.7B-ONNX",
  "4b": "onnx-community/Bonsai-4B-ONNX",
  "8b": "onnx-community/Bonsai-8B-ONNX",
};

// Check WebGPU support
async function checkWebGPU() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU not supported (no adapter found)");
    const device = await adapter.requestDevice();
    device.queue; // Keep reference alive
    return true;
  } catch (e) {
    self.postMessage({ type: 'error', message: `WebGPU unavailable: ${e.toString()}` });
    return false;
  }
}

class BonsaiPipeline {
  static instances = new Map();

  static getInstance(modelSize, onProgress = null) {
    const modelId = MODEL_IDS[modelSize];
    if (!modelId) throw new Error(`Unknown model size: ${modelSize}`);

    if (!this.instances.has(modelSize)) {
      this.instances.set(
        modelSize,
        pipeline("text-generation", modelId, {
          device: "webgpu",
          dtype: "q1",  // Bonsai native 1-bit quantization
          progress_callback: onProgress,
        })
      );
    }
    return this.instances.get(modelSize);
  }
}

const stoppingCriteria = new InterruptableStoppingCriteria();
let pastKeyValuesCache = null;
let currentModelSize = null;

function disposePastKeyValues() {
  pastKeyValuesCache?.dispose?.();
  pastKeyValuesCache = null;
}

async function loadModel(modelSize) {
  if (currentModelSize && currentModelSize !== modelSize) {
    disposePastKeyValues();
  }
  currentModelSize = modelSize;

  self.postMessage({ type: 'status', status: "loading", message: `Loading Bonsai-${modelSize}...` });

  const generator = await BonsaiPipeline.getInstance(modelSize, (info) => {
    if (info.status === 'progress') {
      self.postMessage({
        type: 'progress',
        progress: {
          progress: Number(info.progress ?? 0),
          loaded: Number(info.loaded ?? 0),
          total: Number(info.total ?? 0),
        }
      });
    }
  });

  self.postMessage({ type: 'status', status: "loading", message: "Optimizing model for 1-bit execution..." });

  // Warm up: single-token generation to compile shaders
  const inputs = generator.tokenizer("a");
  await generator.model.generate({ ...inputs, max_new_tokens: 1 });

  self.postMessage({ type: 'status', status: "ready", model: `Bonsai-${modelSize}` });
}

async function generate(messages) {
  const generator = await BonsaiPipeline.getInstance(currentModelSize);

  // Format messages for chat
  const formattedMessages = messages.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  let startTime;
  let numTokens = 0;
  let tps = 0;

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (output) => {
      self.postMessage({ type: 'token', token: output, tps, numTokens });
    },
    token_callback_function: () => {
      startTime ??= performance.now();
      if (numTokens++ > 0) {
        tps = (numTokens / (performance.now() - startTime)) * 1000;
      }
    },
  });

  self.postMessage({ type: 'status', status: "generating" });

  pastKeyValuesCache ??= new DynamicCache();

  try {
    const output = await generator(formattedMessages, {
      max_new_tokens: 512,
      do_sample: false,
      streamer,
      stopping_criteria: stoppingCriteria,
      past_key_values: pastKeyValuesCache,
    });

    const generatedText = output[0].generated_text.at(-1).content;

    self.postMessage({
      type: 'result',
      text: generatedText,
    });
  } catch (e) {
    if (e.message !== 'generation interrupted') {
      self.postMessage({ type: 'error', message: e.toString() });
    }
  }
}

self.addEventListener('message', async (e) => {
  const { type, data } = e.data;

  switch (type) {
    case 'check':
      const supported = await checkWebGPU();
      self.postMessage({ type: 'webgpu_support', supported });
      break;

    case 'load':
      try {
        await loadModel(data || '1.7b');
      } catch (err) {
        self.postMessage({ type: 'error', message: err.toString() });
      }
      break;

    case 'generate':
      try {
        stoppingCriteria.reset();
        await generate(data);
      } catch (err) {
        self.postMessage({ type: 'error', message: err.toString() });
      }
      break;

    case 'interrupt':
      stoppingCriteria.interrupt();
      break;

    case 'reset':
      disposePastKeyValues();
      stoppingCriteria.reset();
      self.postMessage({ type: 'status', status: 'reset' });
      break;

    default:
      self.postMessage({ type: 'error', message: `Unknown message type: ${type}` });
  }
});
