const fs = require("fs");
const path = require("path");
const vm = require("vm");
const axios = require("axios");
const crypto = require("crypto");
const zlib = require("zlib");
const { TextDecoder } = require("util");

const EVENT_NAMES = Object.freeze({
  request: "request",
  inited: "inited",
  updateAlert: "updateAlert",
});
const DEFAULT_SCRIPT_PATH = "";
const MAX_HTTP_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HTTP_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_RESOLVE_TIMEOUT_MS = 15000;
const parsedResolveTimeout = Number.parseInt(String(process.env.KUMIKO_SOURCE_RESOLVE_TIMEOUT_MS || ""), 10);
const RESOLVE_TIMEOUT_MS = Number.isInteger(parsedResolveTimeout) && parsedResolveTimeout >= 50 && parsedResolveTimeout <= 30000
  ? parsedResolveTimeout
  : DEFAULT_RESOLVE_TIMEOUT_MS;

let initialized = false;
let requestHandler = null;
let sourceInfo = {};
let runtimeScriptPath = "";
let runtimeGeneration = 0;

function normalizeCharset(charset) {
  const c = String(charset || "").trim().toLowerCase();
  if (!c) return "utf-8";
  if (c === "utf8") return "utf-8";
  if (c === "gbk" || c === "gb2312") return "gb18030";
  return c;
}

function decodeBuffer(buffer, encoding, fatal = false) {
  try {
    const decoder = new TextDecoder(normalizeCharset(encoding), { fatal });
    return decoder.decode(buffer);
  } catch {
    return "";
  }
}

function decodeBestEffortText(buffer, preferredCharset = "") {
  const pref = normalizeCharset(preferredCharset);
  if (pref) {
    const text = decodeBuffer(buffer, pref, false);
    if (text) return text;
  }
  const utf8Strict = decodeBuffer(buffer, "utf-8", true);
  if (utf8Strict) return utf8Strict;
  const gb = decodeBuffer(buffer, "gb18030", false);
  if (gb) return gb;
  return Buffer.from(buffer || "").toString("utf-8");
}

function decodeHttpBody(buffer, contentType = "") {
  const m = String(contentType || "").match(/charset=([^;,\s]+)/i);
  const charset = m ? m[1] : "";
  return decodeBestEffortText(buffer, charset);
}

function readScriptTextAuto(scriptPath) {
  const buf = fs.readFileSync(scriptPath);
  let text = decodeBestEffortText(buf, "utf-8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}

function buildRequest(url, options = {}, callback) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url || ""));
  } catch {
    callback(new Error("音源脚本请求 URL 无效"), null, null);
    return () => {};
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    callback(new Error(`音源脚本请求协议不允许: ${parsedUrl.protocol}`), null, null);
    return () => {};
  }
  const method = String(options.method || "GET").toUpperCase();
  if (!["GET", "POST", "HEAD"].includes(method)) {
    callback(new Error(`音源脚本请求方法不允许: ${method}`), null, null);
    return () => {};
  }
  const requestedTimeout = Number(options.timeout) || 20000;
  const timeout = Math.max(1000, Math.min(20000, requestedTimeout));
  const headers = options.headers || {};
  const data = options.body || options.form || options.formData || undefined;
  if (data !== undefined) {
    const bodyBytes = Buffer.isBuffer(data)
      ? data.length
      : Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data), "utf8");
    if (bodyBytes > MAX_HTTP_REQUEST_BYTES) {
      callback(new Error("音源脚本请求体超过 1 MiB 上限"), null, null);
      return () => {};
    }
  }
  const controller = new AbortController();
  axios({
    url: parsedUrl.toString(),
    method,
    headers,
    data,
    timeout,
    signal: controller.signal,
    responseType: "arraybuffer",
    validateStatus: () => true,
    maxRedirects: 5,
    maxContentLength: MAX_HTTP_RESPONSE_BYTES,
    maxBodyLength: MAX_HTTP_REQUEST_BYTES,
  })
    .then((resp) => {
      const contentType = String(resp.headers?.["content-type"] || "").toLowerCase();
      const textBody = decodeHttpBody(Buffer.from(resp.data), contentType);
      let body = textBody;
      // 部分音源接口返回 text/plain 但内容实际是 JSON，这里做兼容解析
      if (contentType.includes("application/json") || /^[\s\n\r]*[{\[]/.test(textBody)) {
        try {
          body = JSON.parse(textBody);
        } catch {
          body = textBody;
        }
      }
      const response = {
        statusCode: resp.status,
        statusMessage: "",
        headers: resp.headers || {},
        body,
      };
      callback(null, response, body);
    })
    .catch((err) => callback(err, null, null));
  return () => controller.abort();
}

function parseScriptInfo(scriptCode) {
  const info = {
    name: "",
    description: "",
    version: "",
    author: "",
    homepage: "",
    rawScript: scriptCode || "",
  };
  const blockMatch = String(scriptCode || "").match(/\/\*\*[\s\S]*?\*\//);
  if (!blockMatch) return info;
  const block = blockMatch[0];
  const pick = (tag) => {
    const m = block.match(new RegExp(`@${tag}\\s+([^\\n\\r*]+)`));
    return m ? String(m[1] || "").trim() : "";
  };
  info.name = pick("name");
  info.description = pick("description");
  info.version = pick("version");
  info.author = pick("author");
  info.homepage = pick("homepage");
  return info;
}

function createLxUtils() {
  return {
    buffer: {
      from: (...args) => Buffer.from(...args),
      bufToString: (buf, format = "utf8") => Buffer.from(buf || "").toString(format),
    },
    crypto: {
      md5: (str) => crypto.createHash("md5").update(String(str || "")).digest("hex"),
      randomBytes: (size) => crypto.randomBytes(Math.max(1, Number(size) || 16)).toString("hex"),
      aesEncrypt: (buffer, mode, key, iv) => {
        const algo = `aes-${Buffer.from(key || "").length * 8}-${String(mode || "cbc").toLowerCase()}`;
        const cipher = crypto.createCipheriv(algo, Buffer.from(key || ""), Buffer.from(iv || ""));
        return Buffer.concat([cipher.update(Buffer.from(buffer || "")), cipher.final()]);
      },
      rsaEncrypt: (buffer, key) => {
        return crypto.publicEncrypt(String(key || ""), Buffer.from(buffer || ""));
      },
    },
    zlib: {
      inflate: (buffer) => new Promise((resolve, reject) => {
        zlib.inflate(Buffer.from(buffer || ""), (err, out) => (err ? reject(err) : resolve(out)));
      }),
      deflate: (buffer) => new Promise((resolve, reject) => {
        zlib.deflate(Buffer.from(buffer || ""), (err, out) => (err ? reject(err) : resolve(out)));
      }),
    },
  };
}

function normalizeSourceInfo(initedPayload) {
  if (!initedPayload || initedPayload.status !== true) {
    throw new Error("音源脚本未发送有效的 inited 状态");
  }
  const rawSources = initedPayload.sources;
  if (!rawSources || typeof rawSources !== "object" || Array.isArray(rawSources)) {
    throw new Error("音源脚本 sources 结构无效");
  }
  const entries = Object.entries(rawSources);
  if (!entries.length || entries.length > 32) {
    throw new Error("音源脚本必须声明 1 到 32 个来源");
  }
  const normalized = {};
  for (const [rawId, raw] of entries) {
    const id = String(rawId || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`音源脚本来源声明无效: ${rawId}`);
    }
    const actions = Array.isArray(raw.actions)
      ? [...new Set(raw.actions.map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
    if (!actions.includes("musicUrl")) {
      throw new Error(`音源脚本来源 ${id} 未声明 musicUrl 能力`);
    }
    const rawQualities = Array.isArray(raw.qualities)
      ? raw.qualities
      : (Array.isArray(raw.qualitys) ? raw.qualitys : []);
    const qualities = [...new Set(
      rawQualities
        .map((item) => String(item || "").trim().toLowerCase())
        .filter((item) => item && item.length <= 32),
    )].slice(0, 16);
    if (!qualities.length) {
      throw new Error(`音源脚本来源 ${id} 未声明有效音质`);
    }
    normalized[id] = {
      name: String(raw.name || id).trim().slice(0, 64) || id,
      type: String(raw.type || "music").trim().slice(0, 32) || "music",
      actions,
      qualities,
      qualitys: qualities,
    };
  }
  return normalized;
}

async function prepareScriptPath(nextPath) {
  const target = String(nextPath || "").trim();
  const scriptPath = target ? path.resolve(target) : "";
  if (!scriptPath) {
    throw new Error("尚未导入在线音源脚本");
  }
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`音源脚本不存在: ${scriptPath}`);
  }
  const scriptCode = readScriptTextAuto(scriptPath);
  const currentScriptInfo = parseScriptInfo(scriptCode);
  let candidateRequestHandler = null;
  let candidateInitedPayload = null;
  const lx = {
    EVENT_NAMES,
    env: "desktop",
    version: "2.0.0",
    currentScriptInfo,
    utils: createLxUtils(),
    request(url, options, callback) {
      return buildRequest(url, options || {}, callback || (() => {}));
    },
    on(eventName, handler) {
      if (eventName === EVENT_NAMES.request) {
        candidateRequestHandler = handler;
      }
      return Promise.resolve();
    },
    send(eventName, data) {
      if (eventName === EVENT_NAMES.inited) {
        candidateInitedPayload = data;
      }
      return Promise.resolve();
    },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Buffer,
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.globalThis.lx = lx;
  vm.createContext(sandbox);
  vm.runInContext(scriptCode, sandbox, { filename: scriptPath, timeout: 15000 });
  if (typeof candidateRequestHandler !== "function") {
    throw new Error("音源脚本未注册 request handler");
  }
  const candidateSourceInfo = normalizeSourceInfo(candidateInitedPayload);
  return {
    scriptPath,
    requestHandler: candidateRequestHandler,
    sourceInfo: candidateSourceInfo,
  };
}

function commitPreparedRuntime(candidate) {
  if (!candidate || typeof candidate.requestHandler !== "function" || !candidate.scriptPath) {
    throw new Error("候选音源运行时无效");
  }
  runtimeScriptPath = candidate.scriptPath;
  requestHandler = candidate.requestHandler;
  sourceInfo = candidate.sourceInfo || {};
  initialized = true;
  runtimeGeneration += 1;
  return {
    ok: true,
    scriptPath: getScriptPath(),
    sourceInfo: getSourceInfo(),
    generation: runtimeGeneration,
  };
}

async function initRuntime() {
  if (initialized) return;
  const candidate = await prepareScriptPath(runtimeScriptPath);
  commitPreparedRuntime(candidate);
}

function normalizeResolvedUrl(resolved) {
  let raw = "";
  if (typeof resolved === "string") {
    raw = resolved;
  } else if (resolved && typeof resolved === "object") {
    raw = resolved.url || resolved.data?.url || resolved.data?.src || "";
  }
  raw = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw || raw.length > 8192) {
    throw new Error("音源脚本返回了空 URL 或超长 URL");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("音源脚本返回的 URL 无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`音源脚本返回的 URL 协议不允许: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("音源脚本返回的 URL 不允许包含明文凭证");
  }
  return parsed.toString();
}

function withDeadline(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise])
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function resolveMusicUrl(source, musicInfo, quality) {
  await initRuntime();
  if (typeof requestHandler !== "function") throw new Error("source request handler not ready");
  const sourceId = String(source || "").trim().toLowerCase();
  const sourceConfig = sourceInfo[sourceId];
  if (!sourceConfig) throw new Error(`当前音源脚本不支持来源: ${sourceId || "unknown"}`);
  const requestedQuality = String(quality || "").trim().toLowerCase();
  if (!sourceConfig.qualities.includes(requestedQuality)) {
    throw new Error(`来源 ${sourceId} 不支持音质: ${requestedQuality || "unknown"}`);
  }
  const requestGeneration = runtimeGeneration;
  const result = await withDeadline(requestHandler({
    action: "musicUrl",
    source: sourceId,
    info: {
      type: requestedQuality,
      musicInfo,
    },
  }), RESOLVE_TIMEOUT_MS, `音源脚本解析超过 ${RESOLVE_TIMEOUT_MS}ms`);
  if (requestGeneration !== runtimeGeneration) {
    throw new Error("音源脚本已重载，旧解析结果已丢弃");
  }
  return normalizeResolvedUrl(result);
}

function getSourceInfo() {
  return sourceInfo || {};
}

function getDefaultScriptPath() {
  return DEFAULT_SCRIPT_PATH;
}

function getScriptPath() {
  return runtimeScriptPath;
}

function setScriptPath(nextPath) {
  const target = String(nextPath || "").trim();
  runtimeScriptPath = target ? path.resolve(target) : "";
  initialized = false;
  requestHandler = null;
  sourceInfo = {};
  runtimeGeneration += 1;
  return runtimeScriptPath;
}

function getRuntimeGeneration() {
  return runtimeGeneration;
}

async function reloadRuntime() {
  const candidate = await prepareScriptPath(runtimeScriptPath);
  return commitPreparedRuntime(candidate);
}

module.exports = {
  resolveMusicUrl,
  getSourceInfo,
  getDefaultScriptPath,
  getScriptPath,
  getRuntimeGeneration,
  setScriptPath,
  prepareScriptPath,
  commitPreparedRuntime,
  reloadRuntime,
};
