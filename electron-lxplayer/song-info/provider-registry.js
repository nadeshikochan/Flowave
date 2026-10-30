const { normalizeCandidate, normalizeEvidence } = require("./candidate-model");
const { SongInfoQueryCache, queryCacheKey } = require("./query-cache");

const ALLOWED_REQUEST_FIELDS = new Set([
  "title",
  "artists",
  "album",
  "albumArtists",
  "releaseDate",
  "trackNumber",
  "trackTotal",
  "discNumber",
  "discTotal",
  "genres",
  "cover",
  "lyrics",
  "composers",
  "lyricists",
]);

function sanitizeTrackEvidence(raw, { allowIdentifiers = false } = {}) {
  const evidence = normalizeEvidence(raw);
  const safe = {
    title: evidence.title || (evidence.titleFromFileName ? evidence.fileName : ""),
    artists: evidence.artists,
    album: evidence.album,
    durationSeconds: evidence.durationSeconds,
  };
  if (allowIdentifiers) {
    safe.isrcs = evidence.isrcs;
    safe.recordingId = evidence.recordingId;
  }
  return safe;
}

function sanitizeRequestedFields(fields) {
  return [...new Set((fields || []).map(String).filter((field) => ALLOWED_REQUEST_FIELDS.has(field)))].sort();
}

function abortError(message = "查询已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function wait(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      reject(abortError());
    }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

function retryAfterMilliseconds(error, now = Date.now()) {
  const headers = error?.response?.headers || error?.headers;
  const raw = typeof headers?.get === "function"
    ? headers.get("retry-after")
    : (headers?.["retry-after"] ?? headers?.["Retry-After"]);
  const value = String(raw ?? "").trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    return Math.max(0, Math.ceil(Number(value) * 1000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Number(now || 0)) : 0;
}

function publicFailure(error) {
  if (error?.name === "AbortError" || error?.code === "ABORTED") {
    return { code: "cancelled", message: "查询已取消", retryable: false };
  }
  if (error?.code === "PROVIDER_TIMEOUT") {
    return { code: "timeout", message: "来源响应超时", retryable: true };
  }
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 429) return { code: "rate-limited", message: "来源请求过多", retryable: true };
  if (status === 503) return { code: "unavailable", message: "来源暂时不可用", retryable: true };
  return { code: "failed", message: "来源查询失败", retryable: true };
}

class SongInfoProviderRegistry {
  constructor({
    cache = new SongInfoQueryCache(),
    timeoutMs = 8000,
    now = () => Date.now(),
    waitFor = wait,
    maxRetryAfterMs = 30000,
    onDiagnostic = () => {},
  } = {}) {
    this.cache = cache;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.waitFor = waitFor;
    this.maxRetryAfterMs = Math.max(0, Number(maxRetryAfterMs) || 0);
    this.onDiagnostic = onDiagnostic;
    this.providers = new Map();
    this.lastStartedAt = new Map();
    this.providerTails = new Map();
  }

  register(provider) {
    const id = String(provider?.id || "").trim();
    const version = String(provider?.version || "").trim();
    if (!id || !version || typeof provider.query !== "function") {
      throw new TypeError("provider requires id, version and query");
    }
    if (this.providers.has(id)) throw new Error(`provider already registered: ${id}`);
    this.providers.set(id, {
      label: id,
      minIntervalMs: 0,
      timeoutMs: this.timeoutMs,
      maxAttempts: 1,
      ...provider,
      id,
      version,
    });
    return this;
  }

  async queryAll({ evidence, requestedFields = [], locale = "zh-CN", signal = null, forceRefresh = false } = {}) {
    const fields = sanitizeRequestedFields(requestedFields);
    const tasks = [...this.providers.values()].map((provider) => (
      this.queryProvider(provider, { evidence, requestedFields: fields, locale, signal, forceRefresh })
    ));
    const settled = await Promise.all(tasks);
    return {
      candidates: settled.flatMap((item) => item.candidates),
      sources: settled.map((item) => item.source),
    };
  }

  async queryProvider(provider, { evidence, requestedFields, locale, signal, forceRefresh = false }) {
    const safeEvidence = sanitizeTrackEvidence(evidence, {
      allowIdentifiers: Boolean(provider.allowIdentifiers),
    });
    const cacheKey = queryCacheKey({
      provider: provider.id,
      version: provider.version,
      locale,
      requestedFields,
      evidence: safeEvidence,
    });
    const cacheGeneration = this.cache.snapshotGeneration?.() ?? null;
    const cached = forceRefresh ? null : this.cache.get(cacheKey);
    if (cached) {
      return {
        candidates: cached.value,
        source: {
          id: provider.id,
          label: provider.label,
          status: cached.negative ? "empty" : "ok",
          cached: true,
          count: cached.value.length,
        },
      };
    }

    try {
      const operation = () => this.queryWithRetry(provider, {
        evidence: safeEvidence,
        requestedFields,
        locale,
        signal,
      });
      const rawCandidates = provider.allowConcurrentQueries
        ? await operation()
        : await this.enqueueProvider(provider, operation);
      const normalized = (Array.isArray(rawCandidates) ? rawCandidates : [])
        .slice(0, 100)
        .map((raw) => (typeof provider.normalize === "function" ? provider.normalize(raw) : raw))
        .map((raw) => normalizeCandidate(raw, provider))
        .filter((candidate) => candidate.candidateId && candidate.title);
      this.cache.set(cacheKey, normalized, {
        negative: normalized.length === 0,
        generation: cacheGeneration,
      });
      return {
        candidates: normalized,
        source: {
          id: provider.id,
          label: provider.label,
          status: normalized.length ? "ok" : "empty",
          cached: false,
          count: normalized.length,
        },
      };
    } catch (error) {
      const failure = publicFailure(error);
      this.onDiagnostic({ provider: provider.id, error });
      return {
        candidates: [],
        source: {
          id: provider.id,
          label: provider.label,
          status: failure.code,
          cached: false,
          count: 0,
          message: failure.message,
          retryable: failure.retryable,
        },
      };
    }
  }

  enqueueProvider(provider, operation) {
    const previous = this.providerTails.get(provider.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.providerTails.set(provider.id, tail);
    tail.then(() => {
      if (this.providerTails.get(provider.id) === tail) this.providerTails.delete(provider.id);
    });
    return current;
  }

  async queryWithRetry(provider, request) {
    const attempts = Math.max(1, Math.min(3, Number(provider.maxAttempts) || 1));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.waitForRateLimit(provider, request.signal);
        return await this.runWithTimeout(provider, request);
      } catch (error) {
        lastError = error;
        const status = Number(error?.status || error?.response?.status || 0);
        const retryable = error?.code === "PROVIDER_TIMEOUT" || status === 429 || status === 503;
        if (!retryable || attempt >= attempts || request.signal?.aborted) throw error;
        const backoff = Math.min(4000, (Number(provider.retryBaseMs) || 500) * (2 ** (attempt - 1)));
        const retryAfter = status === 429 ? retryAfterMilliseconds(error, this.now()) : 0;
        if (retryAfter > this.maxRetryAfterMs) throw error;
        await this.waitFor(Math.max(backoff, retryAfter), request.signal);
      }
    }
    throw lastError;
  }

  async waitForRateLimit(provider, signal) {
    const minimum = Math.max(0, Number(provider.minIntervalMs) || 0);
    const last = Number(this.lastStartedAt.get(provider.id) || 0);
    const delay = Math.max(0, last + minimum - this.now());
    if (delay > 0) await this.waitFor(delay, signal);
    this.lastStartedAt.set(provider.id, this.now());
  }

  async runWithTimeout(provider, request) {
    if (request.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Number(provider.timeoutMs) || this.timeoutMs);
    let timedOut = false;
    const forwardAbort = () => controller.abort(request.signal?.reason || abortError());
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await Promise.race([
        Promise.resolve(provider.query({ ...request, signal: controller.signal })),
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            if (timedOut) {
              const error = new Error("provider timeout");
              error.code = "PROVIDER_TIMEOUT";
              reject(error);
            } else {
              reject(abortError());
            }
          }, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}

module.exports = {
  ALLOWED_REQUEST_FIELDS,
  SongInfoProviderRegistry,
  publicFailure,
  retryAfterMilliseconds,
  sanitizeRequestedFields,
  sanitizeTrackEvidence,
};
