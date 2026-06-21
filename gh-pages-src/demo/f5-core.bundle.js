var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to2, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/js-logger/src/logger.js
var require_logger = __commonJS({
  "node_modules/js-logger/src/logger.js"(exports, module) {
    (function(global) {
      "use strict";
      var Logger2 = {};
      Logger2.VERSION = "1.6.1";
      var logHandler;
      var contextualLoggersByNameMap = {};
      var bind = function(scope, func) {
        return function() {
          return func.apply(scope, arguments);
        };
      };
      var merge = function() {
        var args = arguments, target = args[0], key, i;
        for (i = 1; i < args.length; i++) {
          for (key in args[i]) {
            if (!(key in target) && args[i].hasOwnProperty(key)) {
              target[key] = args[i][key];
            }
          }
        }
        return target;
      };
      var defineLogLevel = function(value, name) {
        return { value, name };
      };
      Logger2.TRACE = defineLogLevel(1, "TRACE");
      Logger2.DEBUG = defineLogLevel(2, "DEBUG");
      Logger2.INFO = defineLogLevel(3, "INFO");
      Logger2.TIME = defineLogLevel(4, "TIME");
      Logger2.WARN = defineLogLevel(5, "WARN");
      Logger2.ERROR = defineLogLevel(8, "ERROR");
      Logger2.OFF = defineLogLevel(99, "OFF");
      var ContextualLogger = function(defaultContext) {
        this.context = defaultContext;
        this.setLevel(defaultContext.filterLevel);
        this.log = this.info;
      };
      ContextualLogger.prototype = {
        // Changes the current logging level for the logging instance.
        setLevel: function(newLevel) {
          if (newLevel && "value" in newLevel) {
            this.context.filterLevel = newLevel;
          }
        },
        // Gets the current logging level for the logging instance
        getLevel: function() {
          return this.context.filterLevel;
        },
        // Is the logger configured to output messages at the supplied level?
        enabledFor: function(lvl) {
          var filterLevel = this.context.filterLevel;
          return lvl.value >= filterLevel.value;
        },
        trace: function() {
          this.invoke(Logger2.TRACE, arguments);
        },
        debug: function() {
          this.invoke(Logger2.DEBUG, arguments);
        },
        info: function() {
          this.invoke(Logger2.INFO, arguments);
        },
        warn: function() {
          this.invoke(Logger2.WARN, arguments);
        },
        error: function() {
          this.invoke(Logger2.ERROR, arguments);
        },
        time: function(label) {
          if (typeof label === "string" && label.length > 0) {
            this.invoke(Logger2.TIME, [label, "start"]);
          }
        },
        timeEnd: function(label) {
          if (typeof label === "string" && label.length > 0) {
            this.invoke(Logger2.TIME, [label, "end"]);
          }
        },
        // Invokes the logger callback if it's not being filtered.
        invoke: function(level, msgArgs) {
          if (logHandler && this.enabledFor(level)) {
            logHandler(msgArgs, merge({ level }, this.context));
          }
        }
      };
      var globalLogger = new ContextualLogger({ filterLevel: Logger2.OFF });
      (function() {
        var L = Logger2;
        L.enabledFor = bind(globalLogger, globalLogger.enabledFor);
        L.trace = bind(globalLogger, globalLogger.trace);
        L.debug = bind(globalLogger, globalLogger.debug);
        L.time = bind(globalLogger, globalLogger.time);
        L.timeEnd = bind(globalLogger, globalLogger.timeEnd);
        L.info = bind(globalLogger, globalLogger.info);
        L.warn = bind(globalLogger, globalLogger.warn);
        L.error = bind(globalLogger, globalLogger.error);
        L.log = L.info;
      })();
      Logger2.setHandler = function(func) {
        logHandler = func;
      };
      Logger2.setLevel = function(level) {
        globalLogger.setLevel(level);
        for (var key in contextualLoggersByNameMap) {
          if (contextualLoggersByNameMap.hasOwnProperty(key)) {
            contextualLoggersByNameMap[key].setLevel(level);
          }
        }
      };
      Logger2.getLevel = function() {
        return globalLogger.getLevel();
      };
      Logger2.get = function(name) {
        return contextualLoggersByNameMap[name] || (contextualLoggersByNameMap[name] = new ContextualLogger(merge({ name }, globalLogger.context)));
      };
      Logger2.createDefaultHandler = function(options) {
        options = options || {};
        options.formatter = options.formatter || function defaultMessageFormatter(messages, context) {
          if (context.name) {
            messages.unshift("[" + context.name + "]");
          }
        };
        var timerStartTimeByLabelMap = {};
        var invokeConsoleMethod = function(hdlr, messages) {
          Function.prototype.apply.call(hdlr, console, messages);
        };
        if (typeof console === "undefined") {
          return function() {
          };
        }
        return function(messages, context) {
          messages = Array.prototype.slice.call(messages);
          var hdlr = console.log;
          var timerLabel;
          if (context.level === Logger2.TIME) {
            timerLabel = (context.name ? "[" + context.name + "] " : "") + messages[0];
            if (messages[1] === "start") {
              if (console.time) {
                console.time(timerLabel);
              } else {
                timerStartTimeByLabelMap[timerLabel] = (/* @__PURE__ */ new Date()).getTime();
              }
            } else {
              if (console.timeEnd) {
                console.timeEnd(timerLabel);
              } else {
                invokeConsoleMethod(hdlr, [timerLabel + ": " + ((/* @__PURE__ */ new Date()).getTime() - timerStartTimeByLabelMap[timerLabel]) + "ms"]);
              }
            }
          } else {
            if (context.level === Logger2.WARN && console.warn) {
              hdlr = console.warn;
            } else if (context.level === Logger2.ERROR && console.error) {
              hdlr = console.error;
            } else if (context.level === Logger2.INFO && console.info) {
              hdlr = console.info;
            } else if (context.level === Logger2.DEBUG && console.debug) {
              hdlr = console.debug;
            } else if (context.level === Logger2.TRACE && console.trace) {
              hdlr = console.trace;
            }
            options.formatter(messages, context);
            invokeConsoleMethod(hdlr, messages);
          }
        };
      };
      Logger2.useDefaults = function(options) {
        Logger2.setLevel(options && options.defaultLevel || Logger2.DEBUG);
        Logger2.setHandler(Logger2.createDefaultHandler(options));
      };
      Logger2.setDefaults = Logger2.useDefaults;
      if (typeof define === "function" && define.amd) {
        define(Logger2);
      } else if (typeof module !== "undefined" && module.exports) {
        module.exports = Logger2;
      } else {
        Logger2._prevLogger = global.Logger;
        Logger2.noConflict = function() {
          global.Logger = Logger2._prevLogger;
          return Logger2;
        };
        global.Logger = Logger2;
      }
    })(exports);
  }
});

// f5-core/f5-tts.js
import { Tensor as ORTTensor } from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs";

// f5-core/logging.js
var import_js_logger = __toESM(require_logger(), 1);
import_js_logger.default.useDefaults({ defaultLevel: import_js_logger.default.DEBUG });
var logging_default = import_js_logger.default;

// f5-core/tjs/utils/torch.js
var torch_exports = {};
__export(torch_exports, {
  DataTypeMap: () => DataTypeMap,
  Tensor: () => Tensor2,
  arange: () => arange,
  cat: () => cat,
  full: () => full,
  full_like: () => full_like,
  interpolate: () => interpolate,
  interpolate_4d: () => interpolate_4d,
  layer_norm: () => layer_norm,
  matmul: () => matmul,
  mean: () => mean,
  mean_pooling: () => mean_pooling,
  ones: () => ones,
  ones_like: () => ones_like,
  permute: () => permute,
  pow: () => pow,
  quantize_embeddings: () => quantize_embeddings,
  rand: () => rand,
  rfft: () => rfft,
  slice: () => slice,
  stack: () => stack,
  std_mean: () => std_mean,
  to: () => to,
  topk: () => topk,
  zeros: () => zeros,
  zeros_like: () => zeros_like
});

// f5-core/tjs/backends/onnx.js
import * as ONNX_WEB from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs";

// stubns:stub
var stub_default = {};

// f5-core/tjs/env.js
var VERSION = "3.7.2";
var IS_BROWSER_ENV = typeof window !== "undefined" && typeof window.document !== "undefined";
var IS_WEBWORKER_ENV = typeof self !== "undefined" && ["DedicatedWorkerGlobalScope", "ServiceWorkerGlobalScope", "SharedWorkerGlobalScope"].includes(
  self.constructor?.name
);
var IS_WEB_CACHE_AVAILABLE = typeof self !== "undefined" && "caches" in self;
var IS_WEBGPU_AVAILABLE = typeof navigator !== "undefined" && "gpu" in navigator;
var IS_WEBNN_AVAILABLE = typeof navigator !== "undefined" && "ml" in navigator;
var IS_PROCESS_AVAILABLE = false;
var IS_NODE_ENV = false;
var IS_FS_AVAILABLE = false;
var IS_PATH_AVAILABLE = false;
var IS_DENO_RUNTIME = typeof globalThis.Deno !== "undefined";
var IS_BUN_RUNTIME = typeof globalThis.Bun !== "undefined";
var apis = Object.freeze({
  /** Whether we are running in a browser environment (and not a web worker) */
  IS_BROWSER_ENV,
  /** Whether we are running in a web worker environment */
  IS_WEBWORKER_ENV,
  /** Whether the Cache API is available */
  IS_WEB_CACHE_AVAILABLE,
  /** Whether the WebGPU API is available */
  IS_WEBGPU_AVAILABLE,
  /** Whether the WebNN API is available */
  IS_WEBNN_AVAILABLE,
  /** Whether the Node.js process API is available */
  IS_PROCESS_AVAILABLE,
  /** Whether we are running in a Node.js-like environment (node, deno, bun) */
  IS_NODE_ENV,
  /** Whether the filesystem API is available */
  IS_FS_AVAILABLE,
  /** Whether the path API is available */
  IS_PATH_AVAILABLE
});
var RUNNING_LOCALLY = IS_FS_AVAILABLE && IS_PATH_AVAILABLE;
var dirname__ = "./";
if (RUNNING_LOCALLY) {
  const _import_meta_url = Object(import.meta).url;
  if (_import_meta_url) {
    dirname__ = stub_default.dirname(stub_default.dirname(stub_default.fileURLToPath(_import_meta_url)));
  } else if (typeof __dirname !== "undefined") {
    dirname__ = stub_default.dirname(__dirname);
  }
}
var DEFAULT_CACHE_DIR = RUNNING_LOCALLY ? stub_default.join(dirname__, "/.cache/") : null;
var DEFAULT_LOCAL_MODEL_PATH = "/models/";
var localModelPath = RUNNING_LOCALLY ? stub_default.join(dirname__, DEFAULT_LOCAL_MODEL_PATH) : DEFAULT_LOCAL_MODEL_PATH;
var env = {
  version: VERSION,
  /////////////////// Backends settings ///////////////////
  // NOTE: These will be populated later by the backends themselves.
  backends: {
    // onnxruntime-web/onnxruntime-node
    onnx: {}
  },
  /////////////////// Model settings ///////////////////
  allowRemoteModels: true,
  remoteHost: "https://huggingface.co/",
  remotePathTemplate: "{model}/resolve/{revision}/",
  allowLocalModels: !(IS_BROWSER_ENV || IS_WEBWORKER_ENV),
  localModelPath,
  useFS: IS_FS_AVAILABLE,
  /////////////////// Cache settings ///////////////////
  useBrowserCache: IS_WEB_CACHE_AVAILABLE && !IS_DENO_RUNTIME,
  useFSCache: IS_FS_AVAILABLE,
  cacheDir: DEFAULT_CACHE_DIR,
  useCustomCache: false,
  customCache: null
  //////////////////////////////////////////////////////
};

// f5-core/tjs/backends/onnx.js
import { Tensor } from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.bundle.min.mjs";
var DEVICE_TO_EXECUTION_PROVIDER_MAPPING = Object.freeze({
  auto: null,
  // Auto-detect based on device and environment
  gpu: null,
  // Auto-detect GPU
  cpu: "cpu",
  // CPU
  wasm: "wasm",
  // WebAssembly
  webgpu: "webgpu",
  // WebGPU
  cuda: "cuda",
  // CUDA
  dml: "dml",
  // DirectML
  webnn: { name: "webnn", deviceType: "cpu" },
  // WebNN (default)
  "webnn-npu": { name: "webnn", deviceType: "npu" },
  // WebNN NPU
  "webnn-gpu": { name: "webnn", deviceType: "gpu" },
  // WebNN GPU
  "webnn-cpu": { name: "webnn", deviceType: "cpu" }
  // WebNN CPU
});
var supportedDevices = [];
var defaultDevices;
var ONNX;
var ORT_SYMBOL = /* @__PURE__ */ Symbol.for("onnxruntime");
if (ORT_SYMBOL in globalThis) {
  ONNX = globalThis[ORT_SYMBOL];
} else {
  ONNX = ONNX_WEB;
  if (apis.IS_WEBNN_AVAILABLE) {
    supportedDevices.push("webnn-npu", "webnn-gpu", "webnn-cpu", "webnn");
  }
  if (apis.IS_WEBGPU_AVAILABLE) {
    supportedDevices.push("webgpu");
  }
  supportedDevices.push("wasm");
  defaultDevices = ["wasm"];
}
var InferenceSession = ONNX.InferenceSession;
function deviceToExecutionProviders(device = null) {
  if (!device) return defaultDevices;
  switch (device) {
    case "auto":
      return supportedDevices;
    case "gpu":
      return supportedDevices.filter((x) => ["webgpu", "cuda", "dml", "webnn-gpu"].includes(x));
  }
  if (supportedDevices.includes(device)) {
    return [DEVICE_TO_EXECUTION_PROVIDER_MAPPING[device] ?? device];
  }
  throw new Error(
    `Unsupported device: "${device}". Should be one of: ${supportedDevices.join(", ")}.`
  );
}
var wasmInitPromise = null;
async function createInferenceSession(buffer_or_path, session_options, session_config) {
  if (wasmInitPromise) {
    await wasmInitPromise;
  }
  const sessionPromise = InferenceSession.create(buffer_or_path, session_options);
  wasmInitPromise ??= sessionPromise;
  const session = await sessionPromise;
  session.config = session_config;
  return session;
}
function isONNXTensor(x) {
  return x instanceof ONNX.Tensor;
}
var ONNX_ENV = ONNX?.env;
if (ONNX_ENV?.wasm) {
  if (!// eslint-disable-next-line no-undef
  (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) && !ONNX_ENV.wasm.wasmPaths) {
    ONNX_ENV.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${env.version}/dist/`;
  }
  ONNX_ENV.wasm.proxy = false;
}
if (ONNX_ENV?.webgpu) {
  ONNX_ENV.webgpu.powerPreference = "high-performance";
}
function isONNXProxy() {
  return ONNX_ENV?.wasm?.proxy;
}
env.backends.onnx = ONNX_ENV;

// f5-core/tjs/ops/registry.js
var IS_WEB_ENV = apis.IS_BROWSER_ENV || apis.IS_WEBWORKER_ENV;
var wrap = async (session_bytes, session_options, names) => {
  const session = await createInferenceSession(new Uint8Array(session_bytes), session_options);
  let chain = Promise.resolve();
  return (
    /** @type {any} */
    (async (inputs) => {
      const proxied = isONNXProxy();
      const ortFeed = Object.fromEntries(
        Object.entries(inputs).map(([k, v]) => [k, (proxied ? v.clone() : v).ort])
      );
      const outputs = await (chain = IS_WEB_ENV ? chain.then(() => session.run(ortFeed)) : session.run(ortFeed));
      if (Array.isArray(names)) {
        return names.map((n) => new Tensor2(outputs[n]));
      } else {
        return new Tensor2(outputs[
          /** @type {string} */
          names
        ]);
      }
    })
  );
};
var TensorOpRegistry = class {
  static session_options = {
    // TODO: Allow for multiple execution providers
    // executionProviders: ['webgpu'],
  };
  static get nearest_interpolate_4d() {
    if (!this._nearest_interpolate_4d) {
      this._nearest_interpolate_4d = wrap(
        [
          8,
          10,
          18,
          0,
          58,
          129,
          1,
          10,
          41,
          10,
          1,
          120,
          10,
          0,
          10,
          0,
          10,
          1,
          115,
          18,
          1,
          121,
          34,
          6,
          82,
          101,
          115,
          105,
          122,
          101,
          42,
          18,
          10,
          4,
          109,
          111,
          100,
          101,
          34,
          7,
          110,
          101,
          97,
          114,
          101,
          115,
          116,
          160,
          1,
          3,
          18,
          1,
          114,
          90,
          31,
          10,
          1,
          120,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          90,
          15,
          10,
          1,
          115,
          18,
          10,
          10,
          8,
          8,
          7,
          18,
          4,
          10,
          2,
          8,
          4,
          98,
          31,
          10,
          1,
          121,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          66,
          2,
          16,
          21
        ],
        this.session_options,
        "y"
      );
    }
    return this._nearest_interpolate_4d;
  }
  static get bilinear_interpolate_4d() {
    if (!this._bilinear_interpolate_4d) {
      this._bilinear_interpolate_4d = wrap(
        [
          8,
          9,
          18,
          0,
          58,
          128,
          1,
          10,
          40,
          10,
          1,
          120,
          10,
          0,
          10,
          0,
          10,
          1,
          115,
          18,
          1,
          121,
          34,
          6,
          82,
          101,
          115,
          105,
          122,
          101,
          42,
          17,
          10,
          4,
          109,
          111,
          100,
          101,
          34,
          6,
          108,
          105,
          110,
          101,
          97,
          114,
          160,
          1,
          3,
          18,
          1,
          114,
          90,
          31,
          10,
          1,
          120,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          90,
          15,
          10,
          1,
          115,
          18,
          10,
          10,
          8,
          8,
          7,
          18,
          4,
          10,
          2,
          8,
          4,
          98,
          31,
          10,
          1,
          121,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          66,
          2,
          16,
          20
        ],
        this.session_options,
        "y"
      );
    }
    return this._bilinear_interpolate_4d;
  }
  static get bicubic_interpolate_4d() {
    if (!this._bicubic_interpolate_4d) {
      this._bicubic_interpolate_4d = wrap(
        [
          8,
          9,
          18,
          0,
          58,
          127,
          10,
          39,
          10,
          1,
          120,
          10,
          0,
          10,
          0,
          10,
          1,
          115,
          18,
          1,
          121,
          34,
          6,
          82,
          101,
          115,
          105,
          122,
          101,
          42,
          16,
          10,
          4,
          109,
          111,
          100,
          101,
          34,
          5,
          99,
          117,
          98,
          105,
          99,
          160,
          1,
          3,
          18,
          1,
          114,
          90,
          31,
          10,
          1,
          120,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          90,
          15,
          10,
          1,
          115,
          18,
          10,
          10,
          8,
          8,
          7,
          18,
          4,
          10,
          2,
          8,
          4,
          98,
          31,
          10,
          1,
          121,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          99,
          10,
          3,
          18,
          1,
          104,
          10,
          3,
          18,
          1,
          119,
          66,
          2,
          16,
          20
        ],
        this.session_options,
        "y"
      );
    }
    return this._bicubic_interpolate_4d;
  }
  static get matmul() {
    if (!this._matmul) {
      this._matmul = wrap(
        [
          8,
          9,
          18,
          0,
          58,
          55,
          10,
          17,
          10,
          1,
          97,
          10,
          1,
          98,
          18,
          1,
          99,
          34,
          6,
          77,
          97,
          116,
          77,
          117,
          108,
          18,
          1,
          114,
          90,
          9,
          10,
          1,
          97,
          18,
          4,
          10,
          2,
          8,
          1,
          90,
          9,
          10,
          1,
          98,
          18,
          4,
          10,
          2,
          8,
          1,
          98,
          9,
          10,
          1,
          99,
          18,
          4,
          10,
          2,
          8,
          1,
          66,
          2,
          16,
          20
        ],
        this.session_options,
        "c"
      );
    }
    return this._matmul;
  }
  static get stft() {
    if (!this._stft) {
      this._stft = wrap(
        [
          8,
          7,
          18,
          0,
          58,
          148,
          1,
          10,
          38,
          10,
          1,
          115,
          10,
          1,
          106,
          10,
          1,
          119,
          10,
          1,
          108,
          18,
          1,
          111,
          34,
          4,
          83,
          84,
          70,
          84,
          42,
          15,
          10,
          8,
          111,
          110,
          101,
          115,
          105,
          100,
          101,
          100,
          24,
          1,
          160,
          1,
          2,
          18,
          1,
          115,
          90,
          26,
          10,
          1,
          115,
          18,
          21,
          10,
          19,
          8,
          1,
          18,
          15,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          115,
          10,
          3,
          18,
          1,
          99,
          90,
          11,
          10,
          1,
          106,
          18,
          6,
          10,
          4,
          8,
          7,
          18,
          0,
          90,
          16,
          10,
          1,
          119,
          18,
          11,
          10,
          9,
          8,
          1,
          18,
          5,
          10,
          3,
          18,
          1,
          119,
          90,
          11,
          10,
          1,
          108,
          18,
          6,
          10,
          4,
          8,
          7,
          18,
          0,
          98,
          31,
          10,
          1,
          111,
          18,
          26,
          10,
          24,
          8,
          1,
          18,
          20,
          10,
          3,
          18,
          1,
          98,
          10,
          3,
          18,
          1,
          102,
          10,
          3,
          18,
          1,
          100,
          10,
          3,
          18,
          1,
          99,
          66,
          2,
          16,
          17
        ],
        this.session_options,
        "o"
      );
    }
    return this._stft;
  }
  static get rfft() {
    if (!this._rfft) {
      this._rfft = wrap(
        [
          8,
          9,
          18,
          0,
          58,
          97,
          10,
          33,
          10,
          1,
          120,
          10,
          0,
          10,
          1,
          97,
          18,
          1,
          121,
          34,
          3,
          68,
          70,
          84,
          42,
          15,
          10,
          8,
          111,
          110,
          101,
          115,
          105,
          100,
          101,
          100,
          24,
          1,
          160,
          1,
          2,
          18,
          1,
          100,
          90,
          21,
          10,
          1,
          120,
          18,
          16,
          10,
          14,
          8,
          1,
          18,
          10,
          10,
          3,
          18,
          1,
          115,
          10,
          3,
          18,
          1,
          99,
          90,
          11,
          10,
          1,
          97,
          18,
          6,
          10,
          4,
          8,
          7,
          18,
          0,
          98,
          21,
          10,
          1,
          121,
          18,
          16,
          10,
          14,
          8,
          1,
          18,
          10,
          10,
          3,
          18,
          1,
          115,
          10,
          3,
          18,
          1,
          99,
          66,
          2,
          16,
          20
        ],
        this.session_options,
        "y"
      );
    }
    return this._rfft;
  }
  static get top_k() {
    if (!this._top_k) {
      this._top_k = wrap(
        [
          8,
          10,
          18,
          0,
          58,
          73,
          10,
          18,
          10,
          1,
          120,
          10,
          1,
          107,
          18,
          1,
          118,
          18,
          1,
          105,
          34,
          4,
          84,
          111,
          112,
          75,
          18,
          1,
          116,
          90,
          9,
          10,
          1,
          120,
          18,
          4,
          10,
          2,
          8,
          1,
          90,
          15,
          10,
          1,
          107,
          18,
          10,
          10,
          8,
          8,
          7,
          18,
          4,
          10,
          2,
          8,
          1,
          98,
          9,
          10,
          1,
          118,
          18,
          4,
          10,
          2,
          8,
          1,
          98,
          9,
          10,
          1,
          105,
          18,
          4,
          10,
          2,
          8,
          7,
          66,
          2,
          16,
          21
        ],
        this.session_options,
        [
          /* Values */
          "v",
          /* Indices */
          "i"
        ]
      );
    }
    return this._top_k;
  }
  static get slice() {
    if (!this._slice) {
      this._slice = wrap(
        [
          8,
          7,
          18,
          0,
          58,
          96,
          10,
          25,
          10,
          1,
          120,
          10,
          1,
          115,
          10,
          1,
          101,
          10,
          1,
          97,
          10,
          1,
          116,
          18,
          1,
          121,
          34,
          5,
          83,
          108,
          105,
          99,
          101,
          18,
          1,
          114,
          90,
          9,
          10,
          1,
          120,
          18,
          4,
          10,
          2,
          8,
          1,
          90,
          9,
          10,
          1,
          115,
          18,
          4,
          10,
          2,
          8,
          7,
          90,
          9,
          10,
          1,
          101,
          18,
          4,
          10,
          2,
          8,
          7,
          90,
          9,
          10,
          1,
          97,
          18,
          4,
          10,
          2,
          8,
          7,
          90,
          9,
          10,
          1,
          116,
          18,
          4,
          10,
          2,
          8,
          7,
          98,
          9,
          10,
          1,
          121,
          18,
          4,
          10,
          2,
          8,
          1,
          66,
          2,
          16,
          13
        ],
        this.session_options,
        "y"
      );
    }
    return this._slice;
  }
};

// f5-core/tjs/utils/maths.js
function interpolate_data(input, [in_channels, in_height, in_width], [out_height, out_width], mode = "bilinear", align_corners = false) {
  const x_scale = out_width / in_width;
  const y_scale = out_height / in_height;
  const out_img = new input.constructor(out_height * out_width * in_channels);
  const inStride = in_height * in_width;
  const outStride = out_height * out_width;
  for (let i = 0; i < out_height; ++i) {
    for (let j = 0; j < out_width; ++j) {
      const outOffset = i * out_width + j;
      const x = (j + 0.5) / x_scale - 0.5;
      const y = (i + 0.5) / y_scale - 0.5;
      let x1 = Math.floor(x);
      let y1 = Math.floor(y);
      const x2 = Math.min(x1 + 1, in_width - 1);
      const y2 = Math.min(y1 + 1, in_height - 1);
      x1 = Math.max(x1, 0);
      y1 = Math.max(y1, 0);
      const s = x - x1;
      const t = y - y1;
      const w1 = (1 - s) * (1 - t);
      const w2 = s * (1 - t);
      const w3 = (1 - s) * t;
      const w4 = s * t;
      const yStride = y1 * in_width;
      const xStride = y2 * in_width;
      const idx1 = yStride + x1;
      const idx2 = yStride + x2;
      const idx3 = xStride + x1;
      const idx4 = xStride + x2;
      for (let k = 0; k < in_channels; ++k) {
        const cOffset = k * inStride;
        out_img[k * outStride + outOffset] = w1 * input[cOffset + idx1] + w2 * input[cOffset + idx2] + w3 * input[cOffset + idx3] + w4 * input[cOffset + idx4];
      }
    }
  }
  return out_img;
}
function permute_data(array, dims, axes) {
  const shape = new Array(axes.length);
  const stride = new Array(axes.length);
  for (let i = axes.length - 1, s = 1; i >= 0; --i) {
    stride[i] = s;
    shape[i] = dims[axes[i]];
    s *= shape[i];
  }
  const invStride = axes.map((_, i) => stride[axes.indexOf(i)]);
  const permutedData = new array.constructor(array.length);
  for (let i = 0; i < array.length; ++i) {
    let newIndex = 0;
    for (let j = dims.length - 1, k = i; j >= 0; --j) {
      newIndex += k % dims[j] * invStride[j];
      k = Math.floor(k / dims[j]);
    }
    permutedData[newIndex] = array[i];
  }
  return [permutedData, shape];
}
function min(arr) {
  if (arr.length === 0) throw Error("Array must not be empty");
  let min2 = arr[0];
  let indexOfMin = 0;
  for (let i = 1; i < arr.length; ++i) {
    if (arr[i] < min2) {
      min2 = arr[i];
      indexOfMin = i;
    }
  }
  return (
    /** @type {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} */
    [
      min2,
      indexOfMin
    ]
  );
}
function max(arr) {
  if (arr.length === 0) throw Error("Array must not be empty");
  let max2 = arr[0];
  let indexOfMax = 0;
  for (let i = 1; i < arr.length; ++i) {
    if (arr[i] > max2) {
      max2 = arr[i];
      indexOfMax = i;
    }
  }
  return (
    /** @type {T extends bigint[]|BigTypedArray ? [bigint, number] : [number, number]} */
    [
      max2,
      indexOfMax
    ]
  );
}

// f5-core/tjs/utils/torch.js
var tensorRegistry = new FinalizationRegistry((ort) => {
  try {
    ort.dispose();
  } catch (e) {
  }
});
var DataTypeMap = Object.freeze({
  float32: Float32Array,
  // @ts-ignore ts(2552) Limited availability of Float16Array across browsers:
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float16Array
  float16: typeof Float16Array !== "undefined" ? Float16Array : Uint16Array,
  float64: Float64Array,
  string: Array,
  // string[]
  int8: Int8Array,
  uint8: Uint8Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int32: Int32Array,
  uint32: Uint32Array,
  int64: BigInt64Array,
  uint64: BigUint64Array,
  bool: Uint8Array,
  uint4: Uint8Array,
  int4: Int8Array
});
var Tensor2 = class _Tensor {
  /** @type {number[]} Dimensions of the tensor. */
  get dims() {
    return this.ort.dims;
  }
  set dims(value) {
    this.ort.dims = value;
  }
  /** @type {DataType} Type of the tensor. */
  get type() {
    return this.ort.type;
  }
  /** @type {DataArray} The data stored in the tensor. */
  get data() {
    return this.ort.data;
  }
  /** @type {number} The number of elements in the tensor. */
  get size() {
    return this.ort.size;
  }
  /** @type {string} The location of the tensor data. */
  get location() {
    return this.ort.location;
  }
  ort;
  register;
  /**
   * Create a new Tensor or copy an existing Tensor.
   * @param {[DataType, DataArray, number[]]|[ONNXTensor]} args
   */
  constructor(...args) {
    if (isONNXTensor(args[0])) {
      this.ort = args[0];
      this.register = args[1] ?? true;
    } else {
      let [dataType, dataArray, dims, register = true] = args;
      if (dataType === "float16" && typeof Float16Array !== "undefined" && dataArray instanceof Float16Array) {
        dataArray = new Uint16Array(dataArray.buffer, dataArray.byteOffset, dataArray.length);
      }
      this.ort = new Tensor(dataType, dataArray, dims);
      this.register = register;
    }
    if (this.register) {
      tensorRegistry.register(this, this.ort, this);
    }
  }
  dispose() {
    if (this.ort) {
      this.ort.dispose();
      tensorRegistry.unregister(this);
      this.ort = void 0;
    }
  }
  unregister() {
    if (this.register) {
      tensorRegistry.unregister(this);
      this.register = false;
    }
    return this;
  }
  __serialize__() {
    return {
      type: this.type,
      data: this.data,
      dims: this.dims
    };
  }
  static __deserialize__(data) {
    return new _Tensor(data.type, data.data, data.dims);
  }
  /**
   * Returns an iterator object for iterating over the tensor data in row-major order.
   * If the tensor has more than one dimension, the iterator will yield subarrays.
   * @returns {Iterator} An iterator object for iterating over the tensor data in row-major order.
   */
  *[Symbol.iterator]() {
    const [iterLength, ...iterDims] = this.dims;
    if (iterDims.length > 0) {
      const iterSize = iterDims.reduce((a, b) => a * b);
      for (let i = 0; i < iterLength; ++i) {
        yield this._subarray(i, iterSize, iterDims);
      }
    } else {
      yield* this.data;
    }
  }
  at(index) {
    return this._getitem(index);
  }
  /**
   * Index into a Tensor object.
   * @param {number} index The index to access.
   * @returns {Tensor} The data at the specified index.
   */
  _getitem(index) {
    const [iterLength, ...iterDims] = this.dims;
    index = safeIndex(index, iterLength);
    if (iterDims.length > 0) {
      const iterSize = iterDims.reduce((a, b) => a * b);
      return this._subarray(index, iterSize, iterDims);
    } else {
      return new _Tensor(this.type, [this.data[index]], iterDims);
    }
  }
  /**
   * @param {number|bigint} item The item to search for in the tensor
   * @returns {number} The index of the first occurrence of item in the tensor data.
   */
  indexOf(item) {
    const this_data = this.data;
    for (let index = 0; index < this_data.length; ++index) {
      if (this_data[index] == item) {
        return index;
      }
    }
    return -1;
  }
  /**
   * @param {number} index
   * @param {number} iterSize
   * @param {any} iterDims
   * @returns {Tensor}
   */
  _subarray(index, iterSize, iterDims) {
    const o1 = index * iterSize;
    const o2 = (index + 1) * iterSize;
    const data = "subarray" in this.data ? this.data.subarray(o1, o2) : this.data.slice(o1, o2);
    return new _Tensor(this.type, data, iterDims);
  }
  /**
   * Returns the value of this tensor as a standard JavaScript Number. This only works
   * for tensors with one element. For other cases, see `Tensor.tolist()`.
   * @returns {number|bigint} The value of this tensor as a standard JavaScript Number.
   * @throws {Error} If the tensor has more than one element.
   */
  item() {
    const this_data = this.data;
    if (this_data.length !== 1) {
      throw new Error(`a Tensor with ${this_data.length} elements cannot be converted to Scalar`);
    }
    return this_data[0];
  }
  /**
   * Convert tensor data to a n-dimensional JS list
   * @returns {Array}
   */
  tolist() {
    return reshape(this.data, this.dims);
  }
  /**
   * Return a new Tensor with the sigmoid function applied to each element.
   * @returns {Tensor} The tensor with the sigmoid function applied.
   */
  sigmoid() {
    return this.clone().sigmoid_();
  }
  /**
   * Applies the sigmoid function to the tensor in place.
   * @returns {Tensor} Returns `this`.
   */
  sigmoid_() {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] = 1 / (1 + Math.exp(-this_data[i]));
    }
    return this;
  }
  /**
   * Return a new Tensor with a callback function applied to each element.
   * @param {Function} callback - The function to apply to each element. It should take three arguments:
   *                              the current element, its index, and the tensor's data array.
   * @returns {Tensor} A new Tensor with the callback function applied to each element.
   */
  map(callback) {
    return this.clone().map_(callback);
  }
  /**
   * Apply a callback function to each element of the tensor in place.
   * @param {Function} callback - The function to apply to each element. It should take three arguments:
   *                              the current element, its index, and the tensor's data array.
   * @returns {Tensor} Returns `this`.
   */
  map_(callback) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] = callback(this_data[i], i, this_data);
    }
    return this;
  }
  /**
   * Return a new Tensor with the absolute value of each element.
   * @returns {Tensor} The new tensor.
   */
  abs() {
    return this.map(Math.abs);
  }
  /**
   * Return a new Tensor with every element multiplied by a constant.
   * @param {number} val The value to multiply by.
   * @returns {Tensor} The new tensor.
   */
  mul(val) {
    return this.clone().mul_(val);
  }
  /**
   * Multiply the tensor by a constant in place.
   * @param {number} val The value to multiply by.
   * @returns {Tensor} Returns `this`.
   */
  mul_(val) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] *= val;
    }
    return this;
  }
  /**
   * Return a new Tensor with every element divided by a constant.
   * @param {number} val The value to divide by.
   * @returns {Tensor} The new tensor.
   */
  div(val) {
    return this.clone().div_(val);
  }
  /**
   * Divide the tensor by a constant in place.
   * @param {number} val The value to divide by.
   * @returns {Tensor} Returns `this`.
   */
  div_(val) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] /= val;
    }
    return this;
  }
  /**
   * Return a new Tensor with every element added by a constant.
   * @param {number} val The value to add by.
   * @returns {Tensor} The new tensor.
   */
  add(val) {
    return this.clone().add_(val);
  }
  /**
   * Add the tensor by a constant in place.
   * @param {number} val The value to add by.
   * @returns {Tensor} Returns `this`.
   */
  add_(val) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] += val;
    }
    return this;
  }
  /**
   * Return a new Tensor with every element subtracted by a constant.
   * @param {number} val The value to subtract by.
   * @returns {Tensor} The new tensor.
   */
  sub(val) {
    return this.clone().sub_(val);
  }
  /**
   * Subtract the tensor by a constant in place.
   * @param {number} val The value to subtract by.
   * @returns {Tensor} Returns `this`.
   */
  sub_(val) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] -= val;
    }
    return this;
  }
  /**
   * Creates a deep copy of the current Tensor.
   * @returns {Tensor} A new Tensor with the same type, data, and dimensions as the original.
   */
  clone() {
    return new _Tensor(this.type, this.data.slice(), this.dims.slice());
  }
  /**
   * Performs a slice operation on the Tensor along specified dimensions.
   *
   * Consider a Tensor that has a dimension of [4, 7]:
   * ```
   * [ 1,  2,  3,  4,  5,  6,  7]
   * [ 8,  9, 10, 11, 12, 13, 14]
   * [15, 16, 17, 18, 19, 20, 21]
   * [22, 23, 24, 25, 26, 27, 28]
   * ```
   * We can slice against the two dims of row and column, for instance in this
   * case we can start at the second element, and return to the second last,
   * like this:
   * ```
   * tensor.slice([1, -1], [1, -1]);
   * ```
   * which would return:
   * ```
   * [  9, 10, 11, 12, 13 ]
   * [ 16, 17, 18, 19, 20 ]
   * ```
   *
   * @param {...(number|number[]|null)} slices The slice specifications for each dimension.
   * - If a number is given, then a single element is selected.
   * - If an array of two numbers is given, then a range of elements [start, end (exclusive)] is selected.
   * - If null is given, then the entire dimension is selected.
   * @returns {Tensor} A new Tensor containing the selected elements.
   * @throws {Error} If the slice input is invalid.
   */
  slice(...slices) {
    const newTensorDims = [];
    const newOffsets = [];
    for (let sliceIndex = 0; sliceIndex < this.dims.length; ++sliceIndex) {
      let slice2 = slices[sliceIndex];
      if (slice2 === null || slice2 === void 0) {
        newOffsets.push([0, this.dims[sliceIndex]]);
        newTensorDims.push(this.dims[sliceIndex]);
      } else if (typeof slice2 === "number") {
        slice2 = safeIndex(slice2, this.dims[sliceIndex], sliceIndex);
        newOffsets.push([slice2, slice2 + 1]);
      } else if (Array.isArray(slice2) && slice2.length === 2) {
        let [start, end] = slice2;
        start = start === null ? 0 : safeIndex(start, this.dims[sliceIndex], sliceIndex, false);
        end = end === null ? this.dims[sliceIndex] : safeIndex(end, this.dims[sliceIndex], sliceIndex, false);
        if (start > end) {
          throw new Error(`Invalid slice: ${slice2}`);
        }
        const offsets = [Math.max(start, 0), Math.min(end, this.dims[sliceIndex])];
        newOffsets.push(offsets);
        newTensorDims.push(offsets[1] - offsets[0]);
      } else {
        throw new Error(`Invalid slice: ${slice2}`);
      }
    }
    const newDims = newOffsets.map(([start, end]) => end - start);
    const newBufferSize = newDims.reduce((a, b) => a * b);
    const this_data = this.data;
    const data = new this_data.constructor(newBufferSize);
    const stride = this.stride();
    let isContiguous = true;
    for (let i = 1; i < newDims.length; ++i) {
      if (newOffsets[i][0] !== 0 || newOffsets[i][1] !== this.dims[i]) {
        isContiguous = false;
        break;
      }
    }
    if (isContiguous) {
      const start = newOffsets[0][0] * stride[0];
      const end = newOffsets[0][1] * stride[0];
      if (ArrayBuffer.isView(this_data)) {
        data.set(this_data.subarray(start, end));
      } else if (Array.isArray(this_data)) {
        const slicedData = this_data.slice(start, end);
        for (let i = 0; i < slicedData.length; ++i) {
          data[i] = slicedData[i];
        }
      } else {
        throw new Error("Unsupported data type for slicing");
      }
    } else {
      for (let i = 0; i < newBufferSize; ++i) {
        let originalIndex = 0;
        for (let j = newDims.length - 1, num = i; j >= 0; --j) {
          const size = newDims[j];
          originalIndex += (num % size + newOffsets[j][0]) * stride[j];
          num = Math.floor(num / size);
        }
        data[i] = this_data[originalIndex];
      }
    }
    return new _Tensor(this.type, data, newTensorDims);
  }
  /**
   * Return a permuted version of this Tensor, according to the provided dimensions.
   * @param  {...number} dims Dimensions to permute.
   * @returns {Tensor} The permuted tensor.
   */
  permute(...dims) {
    return permute(this, dims);
  }
  // TODO: implement transpose. For now (backwards compatibility), it's just an alias for permute()
  transpose(...dims) {
    return this.permute(...dims);
  }
  /**
   * Returns the sum of each row of the input tensor in the given dimension dim.
   *
   * @param {number} [dim=null] The dimension or dimensions to reduce. If `null`, all dimensions are reduced.
   * @param {boolean} keepdim Whether the output tensor has `dim` retained or not.
   * @returns The summed tensor
   */
  sum(dim = null, keepdim = false) {
    return this.norm(1, dim, keepdim);
  }
  /**
   * Returns the matrix norm or vector norm of a given tensor.
   * @param {number|string} [p='fro'] The order of norm
   * @param {number} [dim=null] Specifies which dimension of the tensor to calculate the norm across.
   * If dim is None, the norm will be calculated across all dimensions of input.
   * @param {boolean} [keepdim=false] Whether the output tensors have dim retained or not.
   * @returns {Tensor} The norm of the tensor.
   */
  norm(p = "fro", dim = null, keepdim = false) {
    if (p === "fro") {
      p = 2;
    } else if (typeof p === "string") {
      throw Error(`Unsupported norm: ${p}`);
    }
    const this_data = this.data;
    const fn = (a, b) => a + b ** p;
    if (dim === null) {
      const val = this_data.reduce(fn, 0) ** (1 / p);
      return new _Tensor(this.type, [val], []);
    }
    const [type, result, resultDims] = reduce_helper(fn, this, dim, keepdim);
    if (p !== 1) {
      for (let i = 0; i < result.length; ++i) {
        result[i] = result[i] ** (1 / p);
      }
    }
    return new _Tensor(type, result, resultDims);
  }
  /**
   * Performs `L_p` normalization of inputs over specified dimension. Operates in place.
   * @param {number} [p=2] The exponent value in the norm formulation
   * @param {number} [dim=1] The dimension to reduce
   * @returns {Tensor} `this` for operation chaining.
   */
  normalize_(p = 2, dim = 1) {
    dim = safeIndex(dim, this.dims.length);
    const norm = this.norm(p, dim, true);
    const this_data = this.data;
    const norm_data = norm.data;
    for (let i = 0; i < this_data.length; ++i) {
      let resultIndex = 0;
      for (let j = this.dims.length - 1, num = i, resultMultiplier = 1; j >= 0; --j) {
        const size = this.dims[j];
        if (j !== dim) {
          const index = num % size;
          resultIndex += index * resultMultiplier;
          resultMultiplier *= this.dims[j];
        }
        num = Math.floor(num / size);
      }
      this_data[i] /= norm_data[resultIndex];
    }
    return this;
  }
  /**
   * Performs `L_p` normalization of inputs over specified dimension.
   * @param {number} [p=2] The exponent value in the norm formulation
   * @param {number} [dim=1] The dimension to reduce
   * @returns {Tensor} The normalized tensor.
   */
  normalize(p = 2, dim = 1) {
    return this.clone().normalize_(p, dim);
  }
  /**
   * Compute and return the stride of this tensor.
   * Stride is the jump necessary to go from one element to the next one in the specified dimension dim.
   * @returns {number[]} The stride of this tensor.
   */
  stride() {
    return dimsToStride(this.dims);
  }
  /**
   * Returns a tensor with all specified dimensions of input of size 1 removed.
   *
   * NOTE: The returned tensor shares the storage with the input tensor, so changing the contents of one will change the contents of the other.
   * If you would like a copy, use `tensor.clone()` before squeezing.
   *
   * @param {number|number[]} [dim=null] If given, the input will be squeezed only in the specified dimensions.
   * @returns {Tensor} The squeezed tensor
   */
  squeeze(dim = null) {
    return new _Tensor(this.type, this.data, calc_squeeze_dims(this.dims, dim));
  }
  /**
   * In-place version of @see {@link Tensor.squeeze}
   */
  squeeze_(dim = null) {
    this.dims = calc_squeeze_dims(this.dims, dim);
    return this;
  }
  /**
   * Returns a new tensor with a dimension of size one inserted at the specified position.
   *
   * NOTE: The returned tensor shares the same underlying data with this tensor.
   *
   * @param {number} dim The index at which to insert the singleton dimension
   * @returns {Tensor} The unsqueezed tensor
   */
  unsqueeze(dim = null) {
    return new _Tensor(this.type, this.data, calc_unsqueeze_dims(this.dims, dim));
  }
  /**
   * In-place version of @see {@link Tensor.unsqueeze}
   */
  unsqueeze_(dim = null) {
    this.dims = calc_unsqueeze_dims(this.dims, dim);
    return this;
  }
  /**
   * In-place version of @see {@link Tensor.flatten}
   */
  flatten_(start_dim = 0, end_dim = -1) {
    end_dim = (end_dim + this.dims.length) % this.dims.length;
    const dimsToKeepBefore = this.dims.slice(0, start_dim);
    const dimsToFlatten = this.dims.slice(start_dim, end_dim + 1);
    const dimsToKeepAfter = this.dims.slice(end_dim + 1);
    this.dims = [...dimsToKeepBefore, dimsToFlatten.reduce((a, b) => a * b, 1), ...dimsToKeepAfter];
    return this;
  }
  /**
   * Flattens input by reshaping it into a one-dimensional tensor.
   * If `start_dim` or `end_dim` are passed, only dimensions starting with `start_dim`
   * and ending with `end_dim` are flattened. The order of elements in input is unchanged.
   * @param {number} start_dim the first dim to flatten
   * @param {number} end_dim the last dim to flatten
   * @returns {Tensor} The flattened tensor.
   */
  flatten(start_dim = 0, end_dim = -1) {
    return this.clone().flatten_(start_dim, end_dim);
  }
  /**
   * Returns a new tensor with the same data as the `self` tensor but of a different `shape`.
   * @param  {...number} dims the desired size
   * @returns {Tensor} The tensor with the same data but different shape
   */
  view(...dims) {
    let inferredIndex = -1;
    for (let i = 0; i < dims.length; ++i) {
      if (dims[i] === -1) {
        if (inferredIndex !== -1) {
          throw new Error("Only one dimension can be inferred");
        }
        inferredIndex = i;
      }
    }
    const this_data = this.data;
    if (inferredIndex !== -1) {
      const productOther = dims.reduce((product, curr, index) => {
        return index !== inferredIndex ? product * curr : product;
      }, 1);
      dims[inferredIndex] = this_data.length / productOther;
    }
    return new _Tensor(this.type, this_data, dims);
  }
  reshape(...dims) {
    return this.view(...dims).clone();
  }
  neg_() {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] = -this_data[i];
    }
    return this;
  }
  neg() {
    return this.clone().neg_();
  }
  /**
   * Computes input > val element-wise.
   * @param {number} val The value to compare with.
   * @returns {Tensor} A boolean tensor that is `true` where input is greater than other and `false` elsewhere.
   */
  gt(val) {
    const mask = new Uint8Array(this.data.length);
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      mask[i] = this_data[i] > val ? 1 : 0;
    }
    return new _Tensor("bool", mask, this.dims);
  }
  /**
   * Computes input < val element-wise.
   * @param {number} val The value to compare with.
   * @returns {Tensor} A boolean tensor that is `true` where input is less than other and `false` elsewhere.
   */
  lt(val) {
    const mask = new Uint8Array(this.data.length);
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      mask[i] = this_data[i] < val ? 1 : 0;
    }
    return new _Tensor("bool", mask, this.dims);
  }
  /**
   * In-place version of @see {@link Tensor.clamp}
   */
  clamp_(min2, max2) {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] = Math.min(Math.max(this_data[i], min2), max2);
    }
    return this;
  }
  /**
   * Clamps all elements in input into the range [ min, max ]
   * @param {number} min lower-bound of the range to be clamped to
   * @param {number} max upper-bound of the range to be clamped to
   * @returns {Tensor} the output tensor.
   */
  clamp(min2, max2) {
    return this.clone().clamp_(min2, max2);
  }
  /**
   * In-place version of @see {@link Tensor.round}
   */
  round_() {
    const this_data = this.data;
    for (let i = 0; i < this_data.length; ++i) {
      this_data[i] = Math.round(this_data[i]);
    }
    return this;
  }
  /**
   * Rounds elements of input to the nearest integer.
   * @returns {Tensor} the output tensor.
   */
  round() {
    return this.clone().round_();
  }
  mean(dim = null, keepdim = false) {
    return mean(this, dim, keepdim);
  }
  pow(exponent) {
    return pow(this, exponent);
  }
  min(dim = null, keepdim = false) {
    if (dim === null) {
      const val = min(this.data)[0];
      return new _Tensor(
        this.type,
        [val],
        [
          /* scalar */
        ]
      );
    }
    const [type, result, resultDims] = reduce_helper(
      (a, b) => Math.min(a, b),
      this,
      dim,
      keepdim,
      Infinity
    );
    return new _Tensor(type, result, resultDims);
  }
  max(dim = null, keepdim = false) {
    if (dim === null) {
      const val = max(this.data)[0];
      return new _Tensor(
        this.type,
        [val],
        [
          /* scalar */
        ]
      );
    }
    const [type, result, resultDims] = reduce_helper(
      (a, b) => Math.max(a, b),
      this,
      dim,
      keepdim,
      -Infinity
    );
    return new _Tensor(type, result, resultDims);
  }
  argmin(dim = null, keepdim = false) {
    if (dim !== null) {
      throw new Error("`dim !== null` not yet implemented.");
    }
    const index = min(this.data)[1];
    return new _Tensor("int64", [BigInt(index)], []);
  }
  argmax(dim = null, keepdim = false) {
    if (dim !== null) {
      throw new Error("`dim !== null` not yet implemented.");
    }
    const index = max(this.data)[1];
    return new _Tensor("int64", [BigInt(index)], []);
  }
  quantile(q, dim = null, keepdim = false) {
    if (dim !== null) {
      throw new Error("`dim !== null` not yet implemented.");
    }
    if (q < 0 || q > 1) {
      throw new Error("Quantile must be between 0 and 1.");
    }
    const data = Array.from(this.data);
    data.sort((a, b) => a - b);
    const index = (data.length - 1) * q;
    if (Number.isInteger(index)) {
      return new _Tensor(this.type, [data[index]], []);
    }
    const left = Math.floor(index);
    const right = Math.ceil(index);
    const weight = index - left;
    const value = data[left] * (1 - weight) + data[right] * weight;
    return new _Tensor(this.type, [value], []);
  }
  /**
   * Performs Tensor dtype conversion.
   * @param {DataType} type The desired data type.
   * @returns {Tensor} The converted tensor.
   */
  to(type) {
    return to(this, type);
  }
};
function to(tensor, dtype) {
  if (tensor instanceof Tensor2) {
    if (tensor.type === dtype) return tensor;
    if (!Object.prototype.hasOwnProperty.call(DataTypeMap, dtype)) {
      throw new Error(`Unsupported type: ${dtype}`);
    }
    let map_fn;
    const is_source_bigint = ["int64", "uint64"].includes(tensor.type);
    const is_dest_bigint = ["int64", "uint64"].includes(dtype);
    if (is_source_bigint && !is_dest_bigint) {
      map_fn = Number;
    } else if (!is_source_bigint && is_dest_bigint) {
      map_fn = BigInt;
    }
    return new Tensor2(dtype, DataTypeMap[dtype].from(tensor.data, map_fn), tensor.dims.slice());
  } else if (isONNXTensor(tensor)) {
    return new Tensor2(tensor, false).to(dtype).unregister().ort;
  }
  throw new Error(`Unsupported tensor type: ${typeof tensor}`);
}
function reshape(data, dimensions) {
  const totalElements = data.length;
  const dimensionSize = dimensions.reduce((a, b) => a * b);
  if (totalElements !== dimensionSize) {
    throw Error(`cannot reshape array of size ${totalElements} into shape (${dimensions})`);
  }
  let reshapedArray = data;
  for (let i = dimensions.length - 1; i >= 0; i--) {
    reshapedArray = reshapedArray.reduce(
      (acc, val) => {
        const lastArray = acc[acc.length - 1];
        if (lastArray.length < dimensions[i]) {
          lastArray.push(val);
        } else {
          acc.push([val]);
        }
        return acc;
      },
      [[]]
    );
  }
  return reshapedArray[0];
}
function permute(tensor, axes) {
  const [permutedData, shape] = permute_data(tensor.data, tensor.dims, axes);
  return new Tensor2(tensor.type, permutedData, shape);
}
function interpolate(input, [out_height, out_width], mode = "bilinear", align_corners = false) {
  const in_channels = input.dims.at(-3) ?? 1;
  const in_height = input.dims.at(-2);
  const in_width = input.dims.at(-1);
  const output = interpolate_data(
    /** @type {import('./maths.js').TypedArray}*/
    input.data,
    [in_channels, in_height, in_width],
    [out_height, out_width],
    mode,
    align_corners
  );
  return new Tensor2(input.type, output, [in_channels, out_height, out_width]);
}
async function interpolate_4d(input, { size = null, mode = "bilinear" } = {}) {
  if (input.dims.length !== 4) {
    throw new Error("`interpolate_4d` currently only supports 4D input.");
  }
  if (!size) {
    throw new Error("`interpolate_4d` requires a `size` argument.");
  }
  let targetDims;
  if (size.length === 2) {
    targetDims = [...input.dims.slice(0, 2), ...size];
  } else if (size.length === 3) {
    targetDims = [input.dims[0], ...size];
  } else if (size.length === 4) {
    targetDims = size;
  } else {
    throw new Error("`size` must be of length 2, 3, or 4.");
  }
  let op;
  if (mode === "nearest") {
    op = await TensorOpRegistry.nearest_interpolate_4d;
  } else if (mode === "bilinear") {
    op = await TensorOpRegistry.bilinear_interpolate_4d;
  } else if (mode === "bicubic") {
    op = await TensorOpRegistry.bicubic_interpolate_4d;
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }
  const sizeTensor = new Tensor2("int64", new BigInt64Array(targetDims.map(BigInt)), [
    targetDims.length
  ]);
  return await op({ x: input, s: sizeTensor });
}
async function matmul(a, b) {
  const op = await TensorOpRegistry.matmul;
  return await op({ a, b });
}
async function rfft(x, a) {
  const op = await TensorOpRegistry.rfft;
  return await op({ x, a });
}
async function topk(x, k) {
  const op = await TensorOpRegistry.top_k;
  if (k == null) {
    k = x.dims.at(-1);
  } else {
    k = Math.min(k, x.dims.at(-1));
  }
  return await op({
    x,
    k: new Tensor2("int64", [BigInt(k)], [1])
  });
}
var arrayToIndexTensor = (array) => new Tensor2("int64", array, [array.length]);
async function slice(data, starts, ends, axes, steps) {
  const op = await TensorOpRegistry.slice;
  return await op({
    x: data,
    s: arrayToIndexTensor(starts),
    e: arrayToIndexTensor(ends),
    a: arrayToIndexTensor(axes),
    t: arrayToIndexTensor(steps ?? new Array(axes.length).fill(1))
  });
}
function mean_pooling(last_hidden_state, attention_mask) {
  const lastHiddenStateData = last_hidden_state.data;
  const attentionMaskData = attention_mask.data;
  const shape = [last_hidden_state.dims[0], last_hidden_state.dims[2]];
  const returnedData = new lastHiddenStateData.constructor(shape[0] * shape[1]);
  const [batchSize, seqLength, embedDim] = last_hidden_state.dims;
  let outIndex = 0;
  for (let i = 0; i < batchSize; ++i) {
    const offset = i * embedDim * seqLength;
    for (let k = 0; k < embedDim; ++k) {
      let sum = 0;
      let count = 0;
      const attnMaskOffset = i * seqLength;
      const offset2 = offset + k;
      for (let j = 0; j < seqLength; ++j) {
        const attn = Number(attentionMaskData[attnMaskOffset + j]);
        count += attn;
        sum += lastHiddenStateData[offset2 + j * embedDim] * attn;
      }
      const avg = sum / count;
      returnedData[outIndex++] = avg;
    }
  }
  return new Tensor2(last_hidden_state.type, returnedData, shape);
}
function layer_norm(input, normalized_shape, { eps = 1e-5 } = {}) {
  if (input.dims.length !== 2) {
    throw new Error("`layer_norm` currently only supports 2D input.");
  }
  const [batchSize, featureDim] = input.dims;
  if (normalized_shape.length !== 1 && normalized_shape[0] !== featureDim) {
    throw new Error("`normalized_shape` must be a 1D array with shape `[input.dims[1]]`.");
  }
  const [std, mean2] = std_mean(input, 1, 0, true);
  const stdData = (
    /** @type {Float32Array} */
    std.data
  );
  const meanData = (
    /** @type {Float32Array} */
    mean2.data
  );
  const inputData = (
    /** @type {Float32Array} */
    input.data
  );
  const returnedData = new inputData.constructor(inputData.length);
  for (let i = 0; i < batchSize; ++i) {
    const offset = i * featureDim;
    for (let j = 0; j < featureDim; ++j) {
      const offset2 = offset + j;
      returnedData[offset2] = (inputData[offset2] - meanData[i]) / (stdData[i] + eps);
    }
  }
  return new Tensor2(input.type, returnedData, input.dims);
}
function calc_squeeze_dims(dims, dim) {
  dims = dims.slice();
  if (dim === null) {
    dims = dims.filter((d) => d !== 1);
  } else if (typeof dim === "number") {
    if (dims[dim] === 1) {
      dims.splice(dim, 1);
    }
  } else if (Array.isArray(dim)) {
    dims = dims.filter((x, i) => {
      return x !== 1 || !dim.includes(i);
    });
  }
  return dims;
}
function calc_unsqueeze_dims(dims, dim) {
  dim = safeIndex(dim, dims.length + 1);
  dims = dims.slice();
  dims.splice(dim, 0, 1);
  return dims;
}
function safeIndex(index, size, dimension = null, boundsCheck = true) {
  if (index < -size || index >= size) {
    if (boundsCheck) {
      throw new Error(
        `IndexError: index ${index} is out of bounds for dimension${dimension === null ? "" : " " + dimension} with size ${size}`
      );
    } else {
      return index < -size ? 0 : size;
    }
  }
  if (index < 0) {
    index = (index % size + size) % size;
  }
  return index;
}
function cat(tensors, dim = 0) {
  dim = safeIndex(dim, tensors[0].dims.length);
  const resultDims = tensors[0].dims.slice();
  resultDims[dim] = tensors.reduce((a, b) => a + b.dims[dim], 0);
  const resultSize = resultDims.reduce((a, b) => a * b, 1);
  const result = new tensors[0].data.constructor(resultSize);
  const resultType = tensors[0].type;
  if (dim === 0) {
    let offset = 0;
    for (const tensor of tensors) {
      const tensorData = tensor.data;
      result.set(tensorData, offset);
      offset += tensorData.length;
    }
  } else {
    let currentDim = 0;
    for (let t = 0; t < tensors.length; ++t) {
      const { data, dims } = tensors[t];
      for (let i = 0; i < data.length; ++i) {
        let resultIndex = 0;
        for (let j = dims.length - 1, num = i, resultMultiplier = 1; j >= 0; --j) {
          const size = dims[j];
          let index = num % size;
          if (j === dim) {
            index += currentDim;
          }
          resultIndex += index * resultMultiplier;
          resultMultiplier *= resultDims[j];
          num = Math.floor(num / size);
        }
        result[resultIndex] = data[i];
      }
      currentDim += dims[dim];
    }
  }
  return new Tensor2(resultType, result, resultDims);
}
function stack(tensors, dim = 0) {
  return cat(
    tensors.map((t) => t.unsqueeze(dim)),
    dim
  );
}
function reduce_helper(callbackfn, input, dim = null, keepdim = false, initialValue = null) {
  const inputData = input.data;
  const inputDims = input.dims;
  dim = safeIndex(dim, inputDims.length);
  const resultDims = inputDims.slice();
  resultDims[dim] = 1;
  const result = new inputData.constructor(inputData.length / inputDims[dim]);
  if (initialValue !== null) {
    result.fill(initialValue);
  }
  for (let i = 0; i < inputData.length; ++i) {
    let resultIndex = 0;
    for (let j = inputDims.length - 1, num = i, resultMultiplier = 1; j >= 0; --j) {
      const size = inputDims[j];
      if (j !== dim) {
        const index = num % size;
        resultIndex += index * resultMultiplier;
        resultMultiplier *= resultDims[j];
      }
      num = Math.floor(num / size);
    }
    result[resultIndex] = callbackfn(result[resultIndex], inputData[i], i, resultIndex);
  }
  if (!keepdim) resultDims.splice(dim, 1);
  return [input.type, result, resultDims];
}
function std_mean(input, dim = null, correction = 1, keepdim = false) {
  const inputData = (
    /** @type {Float32Array} */
    input.data
  );
  const inputDims = input.dims;
  if (dim === null) {
    const sum = inputData.reduce((a, b) => a + b, 0);
    const mean2 = sum / inputData.length;
    const std = Math.sqrt(
      inputData.reduce((a, b) => a + (b - mean2) ** 2, 0) / (inputData.length - correction)
    );
    const meanTensor2 = new Tensor2(
      input.type,
      [mean2],
      [
        /* scalar */
      ]
    );
    const stdTensor2 = new Tensor2(
      input.type,
      [std],
      [
        /* scalar */
      ]
    );
    return [stdTensor2, meanTensor2];
  }
  dim = safeIndex(dim, inputDims.length);
  const meanTensor = mean(input, dim, keepdim);
  const meanTensorData = meanTensor.data;
  const [type, result, resultDims] = reduce_helper(
    (a, b, i, j) => a + (b - meanTensorData[j]) ** 2,
    input,
    dim,
    keepdim
  );
  for (let i = 0; i < result.length; ++i) {
    result[i] = Math.sqrt(result[i] / (inputDims[dim] - correction));
  }
  const stdTensor = new Tensor2(type, result, resultDims);
  return [stdTensor, meanTensor];
}
function mean(input, dim = null, keepdim = false) {
  const inputDims = input.dims;
  const inputData = (
    /** @type {Float32Array} */
    input.data
  );
  if (dim === null) {
    const val = inputData.reduce((a, b) => a + b, 0);
    return new Tensor2(
      input.type,
      [val / inputData.length],
      [
        /* scalar */
      ]
    );
  }
  dim = safeIndex(dim, inputDims.length);
  const [type, result, resultDims] = reduce_helper((a, b) => a + b, input, dim, keepdim);
  if (inputDims[dim] !== 1) {
    for (let i = 0; i < result.length; ++i) {
      result[i] /= inputDims[dim];
    }
  }
  return new Tensor2(type, result, resultDims);
}
function pow(tensor, exponent) {
  return tensor.map((value) => Math.pow(value, exponent));
}
function dimsToStride(dims) {
  const stride = new Array(dims.length);
  for (let i = dims.length - 1, s2 = 1; i >= 0; --i) {
    stride[i] = s2;
    s2 *= dims[i];
  }
  return stride;
}
function fullHelper(size, fill_value, dtype, cls) {
  const numElements = size.reduce((a, b) => a * b, 1);
  return new Tensor2(dtype, new cls(numElements).fill(fill_value), size);
}
function full(size, fill_value) {
  let dtype;
  let typedArrayCls;
  if (typeof fill_value === "number") {
    dtype = "float32";
    typedArrayCls = Float32Array;
  } else if (typeof fill_value === "bigint") {
    dtype = "int64";
    typedArrayCls = BigInt64Array;
  } else if (typeof fill_value === "boolean") {
    dtype = "bool";
    typedArrayCls = Uint8Array;
  } else {
    throw new Error(`Unsupported data type: ${typeof fill_value}`);
  }
  return fullHelper(size, fill_value, dtype, typedArrayCls);
}
function full_like(tensor, fill_value) {
  return full(tensor.dims, fill_value);
}
function ones(size) {
  return fullHelper(size, 1n, "int64", BigInt64Array);
}
function ones_like(tensor) {
  return ones(tensor.dims);
}
function zeros(size) {
  return fullHelper(size, 0n, "int64", BigInt64Array);
}
function zeros_like(tensor) {
  return zeros(tensor.dims);
}
function arange(start, end, step = 1) {
  const length = Math.ceil((end - start) / step);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = start + i * step;
  }
  return new Tensor2("float32", data, [length]);
}
function rand(size) {
  const length = size.reduce((a, b) => a * b, 1);
  return new Tensor2(
    "float32",
    Float32Array.from({ length }, () => Math.random()),
    size
  );
}
function quantize_embeddings(tensor, precision) {
  if (tensor.dims.length !== 2) {
    throw new Error("The tensor must have 2 dimensions");
  }
  if (tensor.dims.at(-1) % 8 !== 0) {
    throw new Error("The last dimension of the tensor must be a multiple of 8");
  }
  if (!["binary", "ubinary"].includes(precision)) {
    throw new Error("The precision must be either 'binary' or 'ubinary'");
  }
  const signed = precision === "binary";
  const dtype = signed ? "int8" : "uint8";
  const cls = signed ? Int8Array : Uint8Array;
  const inputData = tensor.data;
  const outputData = new cls(inputData.length / 8);
  for (let i = 0; i < inputData.length; ++i) {
    const bit = inputData[i] > 0 ? 1 : 0;
    const arrayIndex = Math.floor(i / 8);
    const bitPosition = i % 8;
    outputData[arrayIndex] |= bit << 7 - bitPosition;
    if (signed && bitPosition === 0) {
      outputData[arrayIndex] -= 128;
    }
  }
  return new Tensor2(dtype, outputData, [tensor.dims[0], tensor.dims[1] / 8]);
}

// f5-core/audio.js
function calculateRMS(tensor) {
  return tensor.pow(2).mean().pow(0.5).item();
}
function normalizeToInt16(tensor, quantile = 0.999) {
  const maxVal = tensor.abs().quantile(quantile).item();
  const scale = maxVal > 0 ? 32767 / maxVal : 1;
  const scaled = tensor.mul(scale).round().clamp(-32768, 32767).to("int16");
  return scaled;
}

// f5-core/tjs/utils/devices.js
var DEVICE_TYPES = Object.freeze({
  auto: "auto",
  // Auto-detect based on device and environment
  gpu: "gpu",
  // Auto-detect GPU
  cpu: "cpu",
  // CPU
  wasm: "wasm",
  // WebAssembly
  webgpu: "webgpu",
  // WebGPU
  cuda: "cuda",
  // CUDA
  dml: "dml",
  // DirectML
  webnn: "webnn",
  // WebNN (default)
  "webnn-npu": "webnn-npu",
  // WebNN NPU
  "webnn-gpu": "webnn-gpu",
  // WebNN GPU
  "webnn-cpu": "webnn-cpu"
  // WebNN CPU
});
var isWebGpuFp16Supported = /* @__PURE__ */ (function() {
  let cachedResult;
  return async function() {
    if (cachedResult === void 0) {
      if (!apis.IS_WEBGPU_AVAILABLE) {
        cachedResult = false;
      } else {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          cachedResult = adapter.features.has("shader-f16");
        } catch (e) {
          cachedResult = false;
        }
      }
    }
    return cachedResult;
  };
})();

// f5-core/tjs/utils/core.js
function dispatchCallback(progress_callback, data) {
  if (progress_callback) progress_callback(data);
}

// f5-core/tjs/utils/hub.js
var CONTENT_TYPE_MAP = {
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif"
};
var FileResponse = class _FileResponse {
  /**
   * Creates a new `FileResponse` object.
   * @param {string} filePath
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.headers = new Headers();
    this.exists = stub_default.existsSync(filePath);
    if (this.exists) {
      this.status = 200;
      this.statusText = "OK";
      const stats = stub_default.statSync(filePath);
      this.headers.set("content-length", stats.size.toString());
      this.updateContentType();
      const stream = stub_default.createReadStream(filePath);
      this.body = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk) => controller.enqueue(chunk));
          stream.on("end", () => controller.close());
          stream.on("error", (err) => controller.error(err));
        },
        cancel() {
          stream.destroy();
        }
      });
    } else {
      this.status = 404;
      this.statusText = "Not Found";
      this.body = null;
    }
  }
  /**
   * Updates the 'content-type' header property of the response based on the extension of
   * the file specified by the filePath property of the current object.
   * @returns {void}
   */
  updateContentType() {
    const extension = this.filePath.toString().split(".").pop().toLowerCase();
    this.headers.set("content-type", CONTENT_TYPE_MAP[extension] ?? "application/octet-stream");
  }
  /**
   * Clone the current FileResponse object.
   * @returns {FileResponse} A new FileResponse object with the same properties as the current object.
   */
  clone() {
    const response = new _FileResponse(this.filePath);
    response.exists = this.exists;
    response.status = this.status;
    response.statusText = this.statusText;
    response.headers = new Headers(this.headers);
    return response;
  }
  /**
   * Reads the contents of the file specified by the filePath property and returns a Promise that
   * resolves with an ArrayBuffer containing the file's contents.
   * @returns {Promise<ArrayBuffer>} A Promise that resolves with an ArrayBuffer containing the file's contents.
   * @throws {Error} If the file cannot be read.
   */
  async arrayBuffer() {
    const data = await stub_default.promises.readFile(this.filePath);
    return (
      /** @type {ArrayBuffer} */
      data.buffer
    );
  }
  /**
   * Reads the contents of the file specified by the filePath property and returns a Promise that
   * resolves with a Blob containing the file's contents.
   * @returns {Promise<Blob>} A Promise that resolves with a Blob containing the file's contents.
   * @throws {Error} If the file cannot be read.
   */
  async blob() {
    const data = await stub_default.promises.readFile(this.filePath);
    return new Blob([data], { type: this.headers.get("content-type") });
  }
  /**
   * Reads the contents of the file specified by the filePath property and returns a Promise that
   * resolves with a string containing the file's contents.
   * @returns {Promise<string>} A Promise that resolves with a string containing the file's contents.
   * @throws {Error} If the file cannot be read.
   */
  async text() {
    const data = await stub_default.promises.readFile(this.filePath, "utf8");
    return data;
  }
  /**
   * Reads the contents of the file specified by the filePath property and returns a Promise that
   * resolves with a parsed JavaScript object containing the file's contents.
   *
   * @returns {Promise<Object>} A Promise that resolves with a parsed JavaScript object containing the file's contents.
   * @throws {Error} If the file cannot be read.
   */
  async json() {
    return JSON.parse(await this.text());
  }
};
function isValidUrl(string, protocols = null, validHosts = null) {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }
  if (protocols && !protocols.includes(url.protocol)) {
    return false;
  }
  if (validHosts && !validHosts.includes(url.hostname)) {
    return false;
  }
  return true;
}
var REPO_ID_REGEX = /^(\b[\w\-.]+\b\/)?\b[\w\-.]{1,96}\b$/;
function isValidHfModelId(string) {
  if (!REPO_ID_REGEX.test(string)) return false;
  if (string.includes("..") || string.includes("--")) return false;
  if (string.endsWith(".git") || string.endsWith(".ipynb")) return false;
  return true;
}
async function getFile(urlOrPath) {
  if (env.useFS && !isValidUrl(urlOrPath, ["http:", "https:", "blob:"])) {
    return new FileResponse(
      urlOrPath instanceof URL ? urlOrPath.protocol === "file:" ? urlOrPath.pathname : urlOrPath.toString() : urlOrPath
    );
  } else if (typeof process !== "undefined" && process?.release?.name === "node") {
    const IS_CI = !!process.env?.TESTING_REMOTELY;
    const version = env.version;
    const headers = new Headers();
    headers.set("User-Agent", `transformers.js/${version}; is_ci/${IS_CI};`);
    const isHFURL = isValidUrl(urlOrPath, ["http:", "https:"], ["huggingface.co", "hf.co"]);
    if (isHFURL) {
      const token = process.env?.HF_TOKEN ?? process.env?.HF_ACCESS_TOKEN;
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    }
    return fetch(urlOrPath, { headers });
  } else {
    return fetch(urlOrPath);
  }
}
var ERROR_MAPPING = {
  // 4xx errors (https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#client_error_responses)
  400: "Bad request error occurred while trying to load file",
  401: "Unauthorized access to file",
  403: "Forbidden access to file",
  404: "Could not locate file",
  408: "Request timeout error occurred while trying to load file",
  // 5xx errors (https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#server_error_responses)
  500: "Internal server error error occurred while trying to load file",
  502: "Bad gateway error occurred while trying to load file",
  503: "Service unavailable error occurred while trying to load file",
  504: "Gateway timeout error occurred while trying to load file"
};
function handleError(status, remoteURL, fatal) {
  if (!fatal) {
    return null;
  }
  const message = ERROR_MAPPING[status] ?? `Error (${status}) occurred while trying to load file`;
  throw Error(`${message}: "${remoteURL}".`);
}
var FileCache = class {
  /**
   * Instantiate a `FileCache` object.
   * @param {string} path
   */
  constructor(path) {
    this.path = path;
  }
  /**
   * Checks whether the given request is in the cache.
   * @param {string} request
   * @returns {Promise<FileResponse | undefined>}
   */
  async match(request) {
    const filePath = stub_default.join(this.path, request);
    const file = new FileResponse(filePath);
    if (file.exists) {
      return file;
    } else {
      return void 0;
    }
  }
  /**
   * Adds the given response to the cache.
   * @param {string} request
   * @param {Response} response
   * @param {(data: {progress: number, loaded: number, total: number}) => void} [progress_callback] Optional.
   * The function to call with progress updates
   * @returns {Promise<void>}
   */
  async put(request, response, progress_callback = void 0) {
    const filePath = stub_default.join(this.path, request);
    try {
      const contentLength = response.headers.get("Content-Length");
      const total = parseInt(contentLength ?? "0");
      let loaded = 0;
      await stub_default.promises.mkdir(stub_default.dirname(filePath), { recursive: true });
      const fileStream = stub_default.createWriteStream(filePath);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await new Promise((resolve, reject) => {
          fileStream.write(value, (err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
        loaded += value.length;
        const progress = total ? loaded / total * 100 : 0;
        progress_callback?.({ progress, loaded, total });
      }
      fileStream.close();
    } catch (error) {
      try {
        await stub_default.promises.unlink(filePath);
      } catch {
      }
      throw error;
    }
  }
  // TODO add the rest?
  // addAll(requests: RequestInfo[]): Promise<void>;
  // delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean>;
  // keys(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<ReadonlyArray<Request>>;
  // match(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined>;
  // matchAll(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<ReadonlyArray<Response>>;
};
async function tryCache(cache, ...names) {
  for (const name of names) {
    try {
      const result = await cache.match(name);
      if (result) return result;
    } catch (e) {
      continue;
    }
  }
  return void 0;
}
async function getModelFile(path_or_repo_id, filename, fatal = true, options = {}, return_path = false) {
  if (!env.allowLocalModels) {
    if (options.local_files_only) {
      throw Error(
        "Invalid configuration detected: local models are disabled (`env.allowLocalModels=false`) but you have requested to only use local models (`local_files_only=true`)."
      );
    } else if (!env.allowRemoteModels) {
      throw Error(
        "Invalid configuration detected: both local and remote models are disabled. Fix by setting `env.allowLocalModels` or `env.allowRemoteModels` to `true`."
      );
    }
  }
  dispatchCallback(options.progress_callback, {
    status: "initiate",
    name: path_or_repo_id,
    file: filename
  });
  let cache;
  if (!cache && env.useCustomCache) {
    if (!env.customCache) {
      throw Error("`env.useCustomCache=true`, but `env.customCache` is not defined.");
    }
    if (!env.customCache.match || !env.customCache.put) {
      throw new Error(
        "`env.customCache` must be an object which implements the `match` and `put` functions of the Web Cache API. For more information, see https://developer.mozilla.org/en-US/docs/Web/API/Cache"
      );
    }
    cache = env.customCache;
  }
  if (!cache && env.useBrowserCache) {
    if (typeof caches === "undefined") {
      throw Error("Browser cache is not available in this environment.");
    }
    try {
      cache = await caches.open("transformers-cache");
    } catch (e) {
      console.warn("An error occurred while opening the browser cache:", e);
    }
  }
  if (!cache && env.useFSCache) {
    if (!apis.IS_FS_AVAILABLE) {
      throw Error("File System Cache is not available in this environment.");
    }
    cache = new FileCache(options.cache_dir ?? env.cacheDir);
  }
  const revision = options.revision ?? "main";
  const requestURL = pathJoin(path_or_repo_id, filename);
  const validModelId = isValidHfModelId(path_or_repo_id);
  const localPath = validModelId ? pathJoin(env.localModelPath, requestURL) : requestURL;
  const remoteURL = pathJoin(
    env.remoteHost,
    env.remotePathTemplate.replaceAll("{model}", path_or_repo_id).replaceAll("{revision}", encodeURIComponent(revision)),
    filename
  );
  let cacheKey;
  const proposedCacheKey = cache instanceof FileCache ? (
    // Choose cache key for filesystem cache
    // When using the main revision (default), we use the request URL as the cache key.
    // If a specific revision is requested, we account for this in the cache key.
    revision === "main" ? requestURL : pathJoin(path_or_repo_id, revision, filename)
  ) : remoteURL;
  let toCacheResponse = false;
  let response;
  if (cache) {
    response = await tryCache(cache, localPath, proposedCacheKey);
  }
  const cacheHit = response !== void 0;
  if (response === void 0) {
    if (env.allowLocalModels) {
      const isURL = isValidUrl(requestURL, ["http:", "https:"]);
      if (!isURL) {
        try {
          response = await getFile(localPath);
          cacheKey = localPath;
        } catch (e) {
          console.warn(`Unable to load from local path "${localPath}": "${e}"`);
        }
      } else if (options.local_files_only) {
        throw new Error(
          `\`local_files_only=true\`, but attempted to load a remote file from: ${requestURL}.`
        );
      } else if (!env.allowRemoteModels) {
        throw new Error(
          `\`env.allowRemoteModels=false\`, but attempted to load a remote file from: ${requestURL}.`
        );
      }
    }
    if (response === void 0 || response.status === 404) {
      if (options.local_files_only || !env.allowRemoteModels) {
        if (fatal) {
          throw Error(
            `\`local_files_only=true\` or \`env.allowRemoteModels=false\` and file was not found locally at "${localPath}".`
          );
        } else {
          return null;
        }
      }
      if (!validModelId) {
        response = await getFile(localPath);
      } else {
        response = await getFile(remoteURL);
      }
      if (response.status !== 200) {
        return handleError(response.status, remoteURL, fatal);
      }
      cacheKey = proposedCacheKey;
    }
    toCacheResponse = cache && // 1. A caching system is available
    typeof Response !== "undefined" && // 2. `Response` is defined (i.e., we are in a browser-like environment)
    response instanceof Response && // 3. result is a `Response` object (i.e., not a `FileResponse`)
    response.status === 200;
  }
  dispatchCallback(options.progress_callback, {
    status: "download",
    name: path_or_repo_id,
    file: filename
  });
  let result;
  if (!(apis.IS_NODE_ENV && return_path)) {
    let buffer;
    if (!options.progress_callback) {
      buffer = new Uint8Array(await response.arrayBuffer());
    } else if (cacheHit && // The item is being read from the cache
    typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent)) {
      buffer = new Uint8Array(await response.arrayBuffer());
      dispatchCallback(options.progress_callback, {
        status: "progress",
        name: path_or_repo_id,
        file: filename,
        progress: 100,
        loaded: buffer.length,
        total: buffer.length
      });
    } else {
      buffer = await readResponse(response, (data) => {
        dispatchCallback(options.progress_callback, {
          status: "progress",
          name: path_or_repo_id,
          file: filename,
          ...data
        });
      });
    }
    result = buffer;
  }
  if (
    // Only cache web responses
    // i.e., do not cache FileResponses (prevents duplication)
    toCacheResponse && cacheKey && // Check again whether request is in cache. If not, we add the response to the cache
    await cache.match(cacheKey) === void 0
  ) {
    if (!result) {
      await cache.put(
        cacheKey,
        /** @type {Response} */
        response,
        options.progress_callback
      );
    } else {
      await cache.put(
        cacheKey,
        new Response(result, {
          headers: response.headers
        })
      ).catch((err) => {
        console.warn(`Unable to add response to browser cache: ${err}.`);
      });
    }
  }
  dispatchCallback(options.progress_callback, {
    status: "done",
    name: path_or_repo_id,
    file: filename
  });
  if (result) {
    if (!apis.IS_NODE_ENV && return_path) {
      throw new Error("Cannot return path in a browser environment.");
    }
    return result;
  }
  if (response instanceof FileResponse) {
    return response.filePath;
  }
  const cachedResponse = await cache?.match(cacheKey);
  if (cachedResponse instanceof FileResponse) {
    return cachedResponse.filePath;
  } else if (cachedResponse instanceof Response) {
    return new Uint8Array(await cachedResponse.arrayBuffer());
  } else if (typeof cachedResponse === "string") {
    return cachedResponse;
  }
  throw new Error("Unable to get model file path or buffer.");
}
async function getModelText(modelPath, fileName, fatal = true, options = {}) {
  const buffer = await getModelFile(modelPath, fileName, fatal, options, false);
  if (buffer === null) {
    return null;
  }
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(
    /** @type {Uint8Array} */
    buffer
  );
}
async function readResponse(response, progress_callback) {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength === null) {
    console.warn(
      "Unable to determine content-length from response headers. Will expand buffer when needed."
    );
  }
  let total = parseInt(contentLength ?? "0");
  let buffer = new Uint8Array(total);
  let loaded = 0;
  const reader = response.body.getReader();
  async function read() {
    const { done, value } = await reader.read();
    if (done) return;
    const newLoaded = loaded + value.length;
    if (newLoaded > total) {
      total = newLoaded;
      const newBuffer = new Uint8Array(total);
      newBuffer.set(buffer);
      buffer = newBuffer;
    }
    buffer.set(value, loaded);
    loaded = newLoaded;
    const progress = loaded / total * 100;
    progress_callback({ progress, loaded, total });
    return read();
  }
  await read();
  return buffer;
}
function pathJoin(...parts) {
  parts = parts.map((part, index) => {
    if (index) {
      part = part.replace(new RegExp("^/"), "");
    }
    if (index !== parts.length - 1) {
      part = part.replace(new RegExp("/$"), "");
    }
    return part;
  });
  return parts.join("/");
}

// f5-core/utils.js
var LOG = logging_default.get("Utils");
function downloadProgressTracker(onProgress) {
  const downloads = {};
  return (info) => {
    const { status, file, loaded, total } = info;
    if (!(status === "progress" || status === "done")) {
      return;
    }
    if (!downloads[file]) {
      downloads[file] = { loaded: 0, total: 0 };
    }
    if (status === "progress") {
      downloads[file].loaded = loaded;
      downloads[file].total = total;
    } else if (status === "done") {
      downloads[file].loaded = downloads[file].total;
    }
    const totalLoaded = Object.values(downloads).reduce((sum, d) => sum + d.loaded, 0);
    const totalSize = Object.values(downloads).reduce((sum, d) => sum + d.total, 0);
    onProgress({
      numberOfFiles: Object.keys(downloads).length,
      currentMB: totalLoaded / (1024 * 1024),
      totalMB: totalSize / (1024 * 1024)
    });
  };
}
function defaultDownloadProgressCallback({
  emit,
  messagePrefix = "Downloading model files"
}) {
  return downloadProgressTracker(({ numberOfFiles, currentMB, totalMB }) => {
    emit("download", {
      value: totalMB ? currentMB / totalMB * 100 : 0,
      message: `${messagePrefix}... (${currentMB.toFixed(1)} MB of ${totalMB.toFixed(1)} MB)`
    });
  });
}

// f5-core/f5-tts.js
var LOG2 = logging_default.get("F5TTS");
var F5TTS = class {
  constructor({ repoName = "", rootPath = "", useFP16 = true, emit = LOG2.trace }) {
    this.repoName = repoName;
    this.rootPath = rootPath;
    this.useFP16 = useFP16;
    this.emit = emit;
    this.sessions = {
      encoder: null,
      transformer: null,
      decoder: null
    };
    this.hopLength = 256;
    this.targetSampleRate = 24e3;
    this.targetRMS = 0.1;
    this.modelPaths = {
      preprocess: `${this.rootPath}onnx/encoder_fp32.onnx`,
      transformer: `${this.rootPath}onnx/transformer_fp32.onnx`,
      transformer_fp16: `${this.rootPath}onnx/transformer_fp16.onnx`,
      decode: `${this.rootPath}onnx/decoder_fp32.onnx`,
      vocab: `${this.rootPath}vocab.txt`
    };
  }
  async initialize() {
    this.emit("initialize", { value: 0, message: "Loading TTS model..." });
    const providers = deviceToExecutionProviders("auto");
    let transformerPath = this.useFP16 ? this.modelPaths.transformer_fp16 : this.modelPaths.transformer;
    const webgpuProviderIndex = providers.findIndex(
      (p) => typeof p === "string" && p === "webgpu" || typeof p === "object" && p.name === "webgpu"
    );
    if (webgpuProviderIndex !== -1) {
      try {
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: "high-performance",
          forceFallbackAdapter: false
        });
        if (adapter) {
          const device = await adapter.requestDevice();
          providers[webgpuProviderIndex] = {
            name: "webgpu",
            device,
            powerPreference: "high-performance"
          };
          if (this.useFP16 && !await isWebGpuFp16Supported()) {
            LOG2.warn("WebGPU fp16 is not supported on this device. Falling back to fp32 model");
            this.useFP16 = false;
            transformerPath = this.modelPaths.transformer;
          }
        }
      } catch (e) {
        LOG2.debug("High-performance GPU setup failed, using default WebGPU");
      }
    }
    LOG2.debug("Detected providers:", providers);
    const sessionOptions = {
      executionProviders: providers,
      graphOptimizationLevel: "all",
      enableMemPattern: true,
      enableCpuMemArena: true,
      // logSeverityLevel: 0,
      extra: {
        session: {
          intra_op_num_threads: 8,
          inter_op_num_threads: 8,
          allow_profiling: false
          // disable_cpu_ep_fallback: true
        }
      }
    };
    const sessionConfig = {};
    const progressCallback = defaultDownloadProgressCallback({
      emit: this.emit,
      messagePrefix: "TTS: Downloading model files"
    });
    const [encoderModel, transformerModel, decoderModel] = await Promise.all(
      [this.modelPaths.preprocess, transformerPath, this.modelPaths.decode].map(
        (path) => getModelFile(this.repoName, path, true, { progress_callback: progressCallback })
      )
    );
    this.sessions.encoder = await createInferenceSession(
      encoderModel,
      sessionOptions,
      sessionConfig
    );
    this.sessions.transformer = await createInferenceSession(
      transformerModel,
      sessionOptions,
      sessionConfig
    );
    this.sessions.decoder = await createInferenceSession(
      decoderModel,
      sessionOptions,
      sessionConfig
    );
    const vocabText = await getModelText(this.repoName, this.modelPaths.vocab);
    this.vocabMap = {};
    vocabText.split("\n").forEach((char, idx) => {
      if (char.trim()) {
        this.vocabMap[char.trim()] = idx;
      }
    });
    LOG2.debug("Models loaded successfully");
    this.emit("initialize", { value: 100, message: "TTS model loaded successfully" });
  }
  tokenizeText(text) {
    const chars = text.split("");
    const tokens = chars.map((char) => this.vocabMap[char] || 0);
    return tokens;
  }
  /**
   * Generate speech audio from text using the F5TTS model.
   * @param {Tensor} refAudio - The reference audio data.
   * @param {string} refText - The reference text for the audio.
   * @param {string} genText - The text to generate audio for.
   * @param {number} speed - The speed of the generated speech.
   * @param {number} nfeSteps - The number of NFE steps for generation.
   * @returns {Promise<Float32Array>} - The generated speech audio data.
   */
  async inference({ refAudio, refText, genText, speed, nfeSteps }) {
    if (Object.values(this.sessions).some((s) => !s)) {
      throw new Error("Models not loaded");
    }
    const { encoder, transformer, decoder } = this.sessions;
    const refRMS = calculateRMS(refAudio);
    if (refRMS < this.targetRMS) {
      refAudio = refAudio.div(refRMS * this.targetRMS);
    }
    const audioTensor = normalizeToInt16(refAudio).reshape(1, 1, -1);
    const combinedText = refText + " " + genText;
    const textTokens = this.tokenizeText(combinedText);
    const textTensor = new Tensor2("int32", Int32Array.from(textTokens), [1, textTokens.length]);
    const refAudioLen = Math.trunc(refAudio.size / this.hopLength);
    const duration = refAudioLen + Math.trunc(refAudioLen / (refText.length + 1) * genText.length / speed);
    const durationTensor = new Tensor2("int64", new BigInt64Array([BigInt(duration)]), [1]);
    LOG2.debug(
      "Ref audio length (frames):",
      refAudioLen,
      "Duration (frames):",
      duration,
      "Speed:",
      speed
    );
    const preprocessInputs = {
      [encoder.inputNames[0]]: audioTensor.ort,
      [encoder.inputNames[1]]: textTensor.ort,
      [encoder.inputNames[2]]: durationTensor.ort
    };
    const preprocessOutputs = await encoder.run(preprocessInputs);
    let noise = preprocessOutputs[encoder.outputNames[0]];
    let ropeCosQ = preprocessOutputs[encoder.outputNames[1]];
    let ropeSinQ = preprocessOutputs[encoder.outputNames[2]];
    let ropeCosK = preprocessOutputs[encoder.outputNames[3]];
    let ropeSinK = preprocessOutputs[encoder.outputNames[4]];
    let catMelText = preprocessOutputs[encoder.outputNames[5]];
    let catMelTextDrop = preprocessOutputs[encoder.outputNames[6]];
    const refSignalLen = preprocessOutputs[encoder.outputNames[7]];
    let timeStep = new ORTTensor("int32", new Int32Array([0]), [1]);
    if (this.useFP16) {
      noise = to(noise, "float16");
      ropeCosQ = to(ropeCosQ, "float16");
      ropeSinQ = to(ropeSinQ, "float16");
      ropeCosK = to(ropeCosK, "float16");
      ropeSinK = to(ropeSinK, "float16");
      catMelText = to(catMelText, "float16");
      catMelTextDrop = to(catMelTextDrop, "float16");
    }
    for (let step = 0; step < nfeSteps - 1; step++) {
      const transformerInputs = {
        [transformer.inputNames[0]]: noise,
        [transformer.inputNames[1]]: ropeCosQ,
        [transformer.inputNames[2]]: ropeSinQ,
        [transformer.inputNames[3]]: ropeCosK,
        [transformer.inputNames[4]]: ropeSinK,
        [transformer.inputNames[5]]: catMelText,
        [transformer.inputNames[6]]: catMelTextDrop,
        [transformer.inputNames[7]]: timeStep
      };
      const transformerOutputs = await transformer.run(transformerInputs);
      noise = transformerOutputs[transformer.outputNames[0]];
      timeStep = transformerOutputs[transformer.outputNames[1]];
      this.emit("inference", {
        value: (step + 1) / nfeSteps * 100,
        message: `Generating: NFE Step ${step + 1}/${nfeSteps}`
      });
    }
    if (this.useFP16) {
      noise = to(noise, "float32");
    }
    const decodeInputs = {
      [decoder.inputNames[0]]: noise,
      [decoder.inputNames[1]]: refSignalLen
    };
    const decodeOutputs = await decoder.run(decodeInputs);
    const generatedSignal = decodeOutputs[decoder.outputNames[0]];
    let normalizedTensor = new Tensor2(generatedSignal).to("float32").div(32767).reshape(-1);
    if (refRMS < this.targetRMS) {
      normalizedTensor = normalizedTensor.mul(refRMS / this.targetRMS);
    }
    return normalizedTensor;
  }
  async dispose() {
    for (const [key, session] of Object.entries(this.sessions)) {
      if (session?.dispose) {
        await session.dispose();
      }
      this.sessions[key] = null;
    }
  }
};
export {
  F5TTS,
  Tensor2 as Tensor,
  calculateRMS,
  createInferenceSession,
  deviceToExecutionProviders,
  isWebGpuFp16Supported,
  normalizeToInt16,
  torch_exports as torch
};
