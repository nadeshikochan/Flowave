const fs = require("fs");
const path = require("path");
const { ReadableStream } = require("stream/web");
const { pathToFileURL } = require("url");

const APP_SCHEME = "kumiko-app";
const APP_HOST = "renderer";
const MEDIA_SCHEME = "kumiko-media";
const MEDIA_HOST = "local";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".ape",
  ".avif",
  ".bmp",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".ogg",
  ".png",
  ".wav",
  ".webp",
  ".wma",
]);
const MEDIA_CONTENT_TYPES = Object.freeze({
  ".aac": "audio/aac",
  ".ape": "audio/x-ape",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webp": "image/webp",
  ".wma": "audio/x-ms-wma",
});

function registerPrivilegedSchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function toLocalMediaUrl(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  if (raw.startsWith(`${MEDIA_SCHEME}://`)) return raw;
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(raw)}`;
}

function localMediaUrlToPath(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith(`${MEDIA_SCHEME}://`)) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname !== MEDIA_HOST) return "";
    return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (_) {
    return "";
  }
}

function resolveRendererAsset(rendererDir, requestUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch (_) {
    return "";
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return "";
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || "/");
  } catch (_) {
    return "";
  }
  const relativeRequest = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const root = path.resolve(rendererDir);
  const target = path.resolve(root, relativeRequest);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return target;
}

function remapWorkspaceArtwork(filePath, cacheRoot) {
  if (!cacheRoot || !path.isAbsolute(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, "/");
  const match = /\/cache\/metadata\/((?:covers|thumbs)\/[^/]+\.(?:png|jpe?g|webp|avif|gif|bmp))$/i.exec(normalized);
  if (!match) return filePath;
  const candidate = path.resolve(cacheRoot, "metadata", ...match[1].split("/"));
  if (candidate === path.resolve(filePath)) return filePath;
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch (_) { /* Preserve the original source when this workspace has no copy. */ }
  return filePath;
}

function resolveLocalMediaPath(requestUrl, cacheRoot) {
  const decoded = localMediaUrlToPath(requestUrl);
  if (!decoded || !path.isAbsolute(decoded)) return "";
  const target = path.resolve(remapWorkspaceArtwork(decoded, cacheRoot));
  if (!ALLOWED_MEDIA_EXTENSIONS.has(path.extname(target).toLowerCase())) return "";
  try {
    if (!fs.statSync(target).isFile()) return "";
  } catch (_) {
    return "";
  }
  return target;
}

function plainResponse(status, text) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getRequestHeader(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? String(headers[match] || "") : "";
}

function parseSingleRange(value, fileSize) {
  const size = Number(fileSize);
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || "").trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || start >= size
    || requestedEnd < start
  ) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

// Own the terminal state: cancellation closes the Web stream before the file's
// asynchronous close event. Never close/enqueue again from that late event.
function createMediaBody(stream, signal) {
  let settled = false;
  let abort;
  const detachAbort = () => signal?.removeEventListener("abort", abort);
  return new ReadableStream({
    start(controller) {
      const finish = (error) => {
        if (settled) return;
        settled = true;
        detachAbort();
        if (error) controller.error(error);
        else controller.close();
      };
      stream.pause();
      stream.on("data", (chunk) => {
        stream.pause();
        if (!settled) controller.enqueue(chunk);
      });
      stream.once("end", () => finish());
      // Keep the error listener through destroy/close, including after cancel.
      stream.once("error", (error) => finish(error));
      stream.once("close", () => {
        finish(new Error("Media stream closed before end"));
      });
      abort = () => {
        const error = new Error("Media request aborted");
        error.name = "AbortError";
        finish(error);
        stream.destroy();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    pull() {
      if (!settled) stream.resume();
    },
    cancel() {
      settled = true;
      detachAbort();
      stream.destroy();
    },
  });
}

async function createLocalMediaResponse(request, target) {
  const method = String(request?.method || "GET").toUpperCase();
  const stat = await fs.promises.stat(target);
  const fileSize = stat.size;
  const rangeHeader = getRequestHeader(request?.headers, "range");
  const headers = {
    "access-control-allow-origin": APP_ORIGIN,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-type": MEDIA_CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
  };

  let status = 200;
  let start = 0;
  let end = Math.max(0, fileSize - 1);
  if (rangeHeader) {
    const range = parseSingleRange(rangeHeader, fileSize);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${fileSize}` },
      });
    }
    status = 206;
    start = range.start;
    end = range.end;
    headers["content-range"] = `bytes ${start}-${end}/${fileSize}`;
  }
  headers["content-length"] = String(status === 206 ? end - start + 1 : fileSize);

  if (method === "HEAD" || fileSize === 0) {
    return new Response(null, { status, headers });
  }
  const stream = fs.createReadStream(target, status === 206 ? { start, end } : undefined);
  return new Response(createMediaBody(stream, request?.signal), { status, headers });
}

function registerSecureProtocols({ protocol, electronNet, rendererDir, moduleAsset, mediaCacheRoot }) {
  protocol.handle(APP_SCHEME, (request) => {
    let requestedPath;try{requestedPath=new URL(request.url).pathname;}catch{return plainResponse(404,'Not found');}
    if(requestedPath.startsWith('/_modules/')){
      if(!['GET','HEAD'].includes(request.method||'GET'))return plainResponse(405,'Method not allowed');
      try{const asset=moduleAsset?.(request.url);if(!asset)return plainResponse(404,'Not found');
        return new Response(request.method==='HEAD'?null:asset.data,{headers:{'content-type':asset.contentType,'cache-control':'no-store'}});
      }catch{return plainResponse(409,'Official module needs repair');}
    }
    const target = resolveRendererAsset(rendererDir, request.url);
    if (!target) return plainResponse(404, "Not found");
    try {
      if (!fs.statSync(target).isFile()) return plainResponse(404, "Not found");
    } catch (_) {
      return plainResponse(404, "Not found");
    }
    return electronNet.fetch(pathToFileURL(target).toString(), {
      method: request.method,
      headers: request.headers,
    });
  });

  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (!["GET", "HEAD"].includes(String(request.method || "GET").toUpperCase())) {
      return plainResponse(405, "Method not allowed");
    }
    const target = resolveLocalMediaPath(request.url, mediaCacheRoot);
    if (!target) return plainResponse(404, "Not found");
    try {
      return await createLocalMediaResponse(request, target);
    } catch (_) {
      return plainResponse(404, "Not found");
    }
  });
}

function isTrustedRendererUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === `${APP_SCHEME}:` && parsed.hostname === APP_HOST;
  } catch (_) {
    return false;
  }
}

module.exports = {
  APP_ORIGIN,
  APP_SCHEME,
  MEDIA_SCHEME,
  createLocalMediaResponse,
  isTrustedRendererUrl,
  localMediaUrlToPath,
  parseSingleRange,
  registerPrivilegedSchemes,
  registerSecureProtocols,
  resolveLocalMediaPath,
  remapWorkspaceArtwork,
  resolveRendererAsset,
  toLocalMediaUrl,
};
