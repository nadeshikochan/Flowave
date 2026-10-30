"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const targetKey = value => { const key = path.resolve(String(value)); return process.platform === "win32" ? key.toLowerCase() : key; };
const { TagWriteCoordinator } = require("./tag-write-coordinator");

function createTagEditor({ request, onChanged = async () => {}, onResult = () => {} }) {
  const confirmations = new Map(), outcomes = new Map(), failures = new Map();
  let playback = "";
  const coordinator = new TagWriteCoordinator({ maxConcurrency: 1,
    execute: async ({ targetPath, operation, requestId }) => {
      let result;
      try { result = await request(operation.undo ? "undo" : "commit", operation.undo
        ? { transaction_id: operation.transactionId } : { confirmation_id: operation.token }); }
      catch (error) { failures.set(requestId, error.message); throw error; }
      if (!result?.ok) { const message = result?.message || "保存失败"; failures.set(requestId, message); throw new Error(message); }
      try { await onChanged(targetPath, result.resourceId); }
      catch (_) { result.refreshFailed = true; }
      outcomes.set(requestId, result);
      return result;
    },
  });
  const submit = async (targetPath, operation) => {
    const requestId = crypto.randomUUID();
    const completion = coordinator.submit({ requestId, targetPath, operation }).then(async result => {
      const outcome = { ...(outcomes.get(requestId) || result), requestId, ...(failures.has(requestId) ? { message: failures.get(requestId) } : {}) }; outcomes.delete(requestId); failures.delete(requestId);
      if (!outcome.ok && operation.token) { try { await request("cancel", { confirmation_id: operation.token }); } catch (_) {} }
      try { onResult({ ...outcome, trackPath: targetPath, undo: Boolean(operation.undo) }); } catch (_) { outcome.refreshFailed = true; }
      return outcome;
    });
    if (playback && targetKey(targetPath) === targetKey(playback)) return { ok: true, status: "queued", requestId };
    return completion;
  };
  return {
    async prepare(payload) {
      const result = await request("prepare", { track_path: payload.trackPath, resource_id: payload.resourceId, updates: payload.updates });
      if (result.confirmationId) {
        for (const [key, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(key);
        confirmations.set(result.confirmationId, { path: payload.trackPath, expires: Date.now() + 3600000 });
      }
      return result;
    },
    async cancel(token) { confirmations.delete(token); return request("cancel", { confirmation_id: token }); },
    cancelQueued: requestId => coordinator.cancel(requestId),
    async commit(token) {
      const item = confirmations.get(token); confirmations.delete(token);
      if (!item || item.expires < Date.now()) throw new Error("修改确认已过期");
      return submit(item.path, { token });
    },
    async undo(payload) { const info = await request("undo-info", { transaction_id: payload.transactionId });
      return submit(info.trackPath, { undo: true, transactionId: payload.transactionId }); },
    setPlayback(path, generation) { playback = String(path || ""); coordinator.setPlaybackTarget(playback, generation); },
    waitForTarget: (path) => coordinator.waitForTarget(path),
    close: () => coordinator.close(),
    drain: () => coordinator.drain(),
  };
}
module.exports = { createTagEditor };
