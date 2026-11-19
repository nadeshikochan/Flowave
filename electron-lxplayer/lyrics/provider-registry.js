const crypto = require("node:crypto");

const { normalizeLyricCandidate, normalizeLyricEvidence } = require("./candidate-model");

function abortError() {
  const error = new Error("lyric query aborted");
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

function sanitizeLyricIdentity(raw) {
  const evidence = normalizeLyricEvidence(raw);
  return {
    title: evidence.title,
    artists: evidence.artists,
    album: evidence.album,
    durationSeconds: evidence.durationSeconds,
  };
}

function sanitizeLyricEvidence(raw = {}) {
  const evidence = sanitizeLyricIdentity(raw);
  if (raw?.alternatives?.length && Array.isArray(raw.alternatives)) {
    evidence.alternatives = raw.alternatives.slice(0, 1).map(sanitizeLyricIdentity);
  }
  return evidence;
}

function cacheKey(provider, evidence, locale) {
  return crypto.createHash("sha256").update(JSON.stringify({
    provider: provider.id,
    version: provider.version,
    locale: String(locale || ""),
    evidence,
  })).digest("hex");
}

function publicFailure(error) {
  if (error?.name === "AbortError" || error?.code === "ABORTED") {
    return { status: "cancelled", retryable: false };
  }
  if (error?.code === "PROVIDER_TIMEOUT") return { status: "timeout", retryable: true };
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 429) return { status: "rate-limited", retryable: true };
  if (status === 503) return { status: "unavailable", retryable: true };
  return { status: "failed", retryable: true };
}

class LyricProviderPolicyError extends Error {
  constructor(message, code = "PROVIDER_POLICY_UNREVIEWED") {
    super(message);
    this.name = "LyricProviderPolicyError";
    this.code = code;
  }
}

function normalizeProviderPolicy(value = {}) {
  const policy = value && typeof value === "object" ? value : {};
  return {
    serviceUse: String(policy.serviceUse || "unreviewed"),
    cache: String(policy.cache || "blocked"),
    save: String(policy.save || "blocked"),
    reviewedAt: String(policy.reviewedAt || ""),
    reviewReference: String(policy.reviewReference || ""),
  };
}

function assertProviderPolicy(provider) {
  const policy = normalizeProviderPolicy(provider?.policy);
  if (policy.serviceUse !== "approved" || !policy.reviewedAt || !policy.reviewReference) {
    throw new LyricProviderPolicyError("lyric provider service use has not been reviewed");
  }
  return policy;
}

class LyricProviderRegistry {
  constructor({ cache = null, timeoutMs = 8000, now = () => Date.now(), onDiagnostic = () => {} } = {}) {
    this.cache = cache;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.onDiagnostic = onDiagnostic;
    this.providers = new Map();
    this.providerTails = new Map();
    this.lastStartedAt = new Map();
  }

  register(provider, { allowLocalContext = false } = {}) {
    const id = String(provider?.id || "").trim();
    const version = String(provider?.version || "").trim();
    if (!id || !version || typeof provider.query !== "function") {
      throw new TypeError("lyric provider requires id, version and query");
    }
    if (this.providers.has(id)) throw new Error(`lyric provider already registered: ${id}`);
    const policy = assertProviderPolicy(provider);
    this.providers.set(id, {
      label: id,
      minIntervalMs: 0,
      timeoutMs: this.timeoutMs,
      maxAttempts: 1,
      retryBaseMs: 500,
      ...provider,
      id,
      version,
      policy,
      localOnly: allowLocalContext === true,
      allowStructuredLyrics: provider.allowStructuredLyrics === true,
    });
    return this;
  }

  getPolicy(providerId) {
    const provider = this.providers.get(String(providerId || ""));
    return provider ? { ...provider.policy } : null;
  }

  canSave(providerId) {
    return this.getPolicy(providerId)?.save === "approved";
  }

  capabilities() {
    const providers = [...this.providers.values()];
    return {
      queryProviders: providers.length,
      saveProviders: providers.filter((provider) => provider.policy.save === "approved").length,
    };
  }

  async queryAll({ evidence, locale = "zh-CN", signal = null, localContext = null, providerIds = null } = {}) {
    const safeEvidence = sanitizeLyricEvidence(evidence);
    const enabled = Array.isArray(providerIds) ? new Set(providerIds.map(String)) : null;
    const providers = [...this.providers.values()].filter((provider) => !enabled || enabled.has(provider.id));
    const results = await Promise.all(providers.map((provider) => (
      this.queryProvider(provider, safeEvidence, locale, signal, localContext)
    )));
    return {
      candidates: results.flatMap((result) => result.candidates),
      sources: results.map((result) => result.source),
    };
  }

  async queryProvider(provider, evidence, locale, signal, localContext = null) {
    const key = cacheKey(provider, evidence, locale);
    const cacheAllowed = provider.policy.cache === "approved";
    const cacheGeneration = cacheAllowed ? (this.cache?.snapshotGeneration?.() ?? null) : null;
    const cached = cacheAllowed ? this.cache?.get?.(key) : null;
    if (cached) {
      const value = Array.isArray(cached.value) ? cached.value : cached;
      return {
        candidates: value.map((candidate) => normalizeLyricCandidate(candidate, provider)),
        source: { id: provider.id, label: provider.label, status: value.length ? "ok" : "empty", cached: true, count: value.length },
      };
    }
    try {
      const request = { evidence, locale, signal };
      if (provider.localOnly === true) {
        request.localContext = {
          trackPath: String(localContext?.trackPath || ""),
          ...(localContext?.originalEvidence ? { originalEvidence: sanitizeLyricEvidence(localContext.originalEvidence) } : {}),
          sources: Array.isArray(localContext?.sources) ? localContext.sources.map(String) : null,
        };
      }
      const raw = await this.enqueue(provider, () => this.queryWithRetry(provider, request));
      const candidates = (Array.isArray(raw) ? raw : [])
        .slice(0, 20)
        .map((candidate) => normalizeLyricCandidate(candidate, provider))
        .filter((candidate) => candidate.candidateId && candidate.trackName);
      if (cacheAllowed) {
        this.cache?.set?.(key, candidates, {
          negative: candidates.length === 0,
          generation: cacheGeneration,
        });
      }
      return {
        candidates,
        source: { id: provider.id, label: provider.label, status: candidates.length ? "ok" : "empty", cached: false, count: candidates.length },
      };
    } catch (error) {
      const failure = publicFailure(error);
      this.onDiagnostic({ provider: provider.id, error });
      return {
        candidates: [],
        source: { id: provider.id, label: provider.label, status: failure.status, cached: false, count: 0, retryable: failure.retryable },
      };
    }
  }

  enqueue(provider, operation) {
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
        const retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0));
        const backoffMs = Math.min(5000, (Number(provider.retryBaseMs) || 500) * (2 ** (attempt - 1)));
        await wait(Math.max(retryAfterMs, backoffMs), request.signal);
      }
    }
    throw lastError;
  }

  async waitForRateLimit(provider, signal) {
    const minimum = Math.max(0, Number(provider.minIntervalMs) || 0);
    const delay = Math.max(0, Number(this.lastStartedAt.get(provider.id) || 0) + minimum - this.now());
    await wait(delay, signal);
    this.lastStartedAt.set(provider.id, this.now());
  }

  async runWithTimeout(provider, request) {
    if (request.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeoutMs = Math.max(1, Number(provider.timeoutMs) || this.timeoutMs);
    let timedOut = false;
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
              const error = new Error("lyric provider timeout");
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
  LyricProviderPolicyError,
  LyricProviderRegistry,
  abortError,
  assertProviderPolicy,
  cacheKey,
  normalizeProviderPolicy,
  publicFailure,
  sanitizeLyricEvidence,
};
