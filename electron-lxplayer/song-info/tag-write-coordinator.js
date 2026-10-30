"use strict";

const path = require("node:path");

const DEFAULT_DRAIN_TIMEOUT_MS = 15000;
const DEFAULT_MAX_CONCURRENCY = 2;

class TagWriteCoordinatorError extends Error {
  constructor(message, code = "TAG_WRITE_COORDINATOR_FAILED") {
    super(message);
    this.name = "TagWriteCoordinatorError";
    this.code = code;
  }
}

function targetKey(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function controlledFailure(error) {
  const code = String(error?.code || error?.name || "").toUpperCase();
  if (code === "EXTERNALFILECHANGED" || code === "EXTERNAL_FILE_CHANGED" || code === "EXTERNAL_CHANGE") {
    return { code: "EXTERNAL_CHANGE", message: "歌曲已被其他程序修改" };
  }
  if (code === "TAGWRITEUNSUPPORTED" || code === "TAG_WRITE_UNSUPPORTED" || code === "UNSUPPORTED_FORMAT") {
    return { code: "UNSUPPORTED_FORMAT", message: "暂不支持写入此格式" };
  }
  if (code === "TAGVERIFICATIONFAILED" || code === "TAG_VERIFICATION_FAILED" || code === "VERIFY_FAILED") {
    return { code: "VERIFY_FAILED", message: "写入验证失败" };
  }
  return { code: "WRITE_FAILED", message: "写入失败" };
}

function publicSuccess(task, value) {
  const transactionId = String(value?.transactionId || value?.transaction_id || "");
  return {
    ok: true,
    requestId: task.id,
    status: "committed",
    ...(transactionId ? { transactionId } : {}),
  };
}

function publicStopped(task, status, reason) {
  return {
    ok: false,
    requestId: task.id,
    status,
    reason,
  };
}

class TagWriteCoordinator {
  constructor({
    execute,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    onState = () => {},
    onCommitted = () => {},
  } = {}) {
    if (typeof execute !== "function") {
      throw new TypeError("TagWriteCoordinator requires an execute function");
    }
    this.execute = execute;
    this.maxConcurrency = Math.max(1, Math.min(4, Math.trunc(Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY)));
    this.onState = typeof onState === "function" ? onState : () => {};
    this.onCommitted = typeof onCommitted === "function" ? onCommitted : () => {};
    this.accepting = true;
    this.playback = { key: "", generation: "" };
    this.pendingByPath = new Map();
    this.tasksById = new Map();
    this.activeByPath = new Map();
    this.active = new Set();
    this.drainWaiters = new Set();
  }

  _emit(task, state) {
    task.state = state;
    try {
      this.onState({ requestId: task.id, state });
    } catch (_) {}
  }

  _finish(task, result) {
    if (task.settled) return;
    task.settled = true;
    this.tasksById.delete(task.id);
    task.resolve(result);
  }

  _stopPending(task, status, reason) {
    if (this.pendingByPath.get(task.key) === task) this.pendingByPath.delete(task.key);
    this._emit(task, status);
    this._finish(task, publicStopped(task, status, reason));
  }

  submit({ requestId, targetPath, operation } = {}) {
    if (!this.accepting) {
      throw new TagWriteCoordinatorError("tag writes are closing", "COORDINATOR_CLOSED");
    }
    const id = String(requestId || "").trim();
    const rawTarget = String(targetPath || "").trim();
    if (!id) throw new TagWriteCoordinatorError("request id is required", "INVALID_REQUEST");
    if (!rawTarget || !path.isAbsolute(rawTarget)) {
      throw new TagWriteCoordinatorError("absolute target path is required", "INVALID_TARGET");
    }
    if (this.tasksById.has(id)) {
      throw new TagWriteCoordinatorError("request id already exists", "DUPLICATE_REQUEST");
    }

    const key = targetKey(rawTarget);
    const previous = this.pendingByPath.get(key);
    if (previous) this._stopPending(previous, "superseded", "newer-request");

    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const task = {
      id,
      key,
      targetPath: path.resolve(rawTarget),
      operation,
      state: "queued",
      resolve,
      completion,
      settled: false,
    };
    this.pendingByPath.set(key, task);
    this.tasksById.set(id, task);
    this._emit(task, key === this.playback.key ? "waiting-for-release" : "queued");
    this._schedule();
    return completion;
  }

  setPlaybackTarget(targetPath, generation) {
    const rawTarget = String(targetPath || "").trim();
    this.playback = {
      key: rawTarget ? targetKey(rawTarget) : "",
      generation: String(generation ?? ""),
    };
    for (const task of this.pendingByPath.values()) {
      if (task.key === this.playback.key) this._emit(task, "waiting-for-release");
      else if (task.state === "waiting-for-release") this._emit(task, "queued");
    }
    this._schedule();
  }

  releasePlayback(targetPath, generation) {
    const rawTarget = String(targetPath || "").trim();
    if (!rawTarget) return false;
    if (targetKey(rawTarget) !== this.playback.key) return false;
    if (String(generation ?? "") !== this.playback.generation) return false;
    this.playback = { key: "", generation: "" };
    this._schedule();
    return true;
  }

  cancel(requestId) {
    const task = this.tasksById.get(String(requestId || ""));
    if (!task || task.settled) return { cancelled: false, reason: "missing" };
    if (this.active.has(task)) return { cancelled: false, reason: "already-running" };
    this._stopPending(task, "cancelled", "user-cancelled");
    this._schedule();
    return { cancelled: true };
  }

  isWritingTarget(targetPath) {
    const rawTarget = String(targetPath || "").trim();
    return Boolean(rawTarget && this.activeByPath.has(targetKey(rawTarget)));
  }

  async waitForTarget(targetPath, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
    const rawTarget = String(targetPath || "").trim();
    if (!rawTarget) return { released: true };
    const task = this.activeByPath.get(targetKey(rawTarget));
    if (!task) return { released: true };
    const boundedTimeout = Math.max(0, Number(timeoutMs) || 0);
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundedTimeout);
    });
    const outcome = await Promise.race([
      task.completion.then(() => "released"),
      timedOut,
    ]);
    if (timer) clearTimeout(timer);
    return { released: outcome === "released" };
  }

  _schedule() {
    if (!this.accepting && this.pendingByPath.size === 0) {
      this._notifyDrainWaiters();
      return;
    }
    while (this.active.size < this.maxConcurrency) {
      let next = null;
      for (const task of this.pendingByPath.values()) {
        if (task.key === this.playback.key) {
          if (task.state !== "waiting-for-release") this._emit(task, "waiting-for-release");
          continue;
        }
        if (this.activeByPath.has(task.key)) continue;
        next = task;
        break;
      }
      if (!next) break;
      this.pendingByPath.delete(next.key);
      this._run(next);
    }
  }

  _run(task) {
    this.active.add(task);
    this.activeByPath.set(task.key, task);
    this._emit(task, "running");
    Promise.resolve()
      .then(() => this.execute({
        requestId: task.id,
        targetPath: task.targetPath,
        operation: task.operation,
      }))
      .then((value) => {
        try {
          this.onCommitted({
            requestId: task.id,
            targetPath: task.targetPath,
            operation: task.operation,
          }, value);
        } catch (_) {}
        this._emit(task, "committed");
        this._finish(task, publicSuccess(task, value));
      })
      .catch((error) => {
        const failure = controlledFailure(error);
        this._emit(task, "failed");
        this._finish(task, {
          ok: false,
          requestId: task.id,
          status: "failed",
          ...failure,
        });
      })
      .finally(() => {
        this.active.delete(task);
        if (this.activeByPath.get(task.key) === task) this.activeByPath.delete(task.key);
        this._schedule();
        this._notifyDrainWaiters();
      });
  }

  close() {
    if (!this.accepting) return;
    this.accepting = false;
    for (const task of [...this.pendingByPath.values()]) {
      this._stopPending(task, "cancelled", "shutdown");
    }
    this._notifyDrainWaiters();
  }

  _notifyDrainWaiters() {
    if (this.active.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  async drain({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
    if (this.active.size === 0) return { drained: true, pending: 0 };
    const boundedTimeout = Math.max(0, Number(timeoutMs) || 0);
    let waiter;
    const finished = new Promise((resolve) => {
      waiter = resolve;
      this.drainWaiters.add(resolve);
    });
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundedTimeout);
    });
    const outcome = await Promise.race([finished.then(() => "drained"), timedOut]);
    if (timer) clearTimeout(timer);
    this.drainWaiters.delete(waiter);
    return {
      drained: outcome === "drained",
      pending: this.active.size,
    };
  }
}

module.exports = {
  TagWriteCoordinator,
  TagWriteCoordinatorError,
  controlledFailure,
};
