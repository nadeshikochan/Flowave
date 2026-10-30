"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  TagWriteCoordinator,
  TagWriteCoordinatorError,
} = require("../song-info/tag-write-coordinator");

const song = (name) => path.resolve(`D:\\Music\\${name}.mp3`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a non-playing target starts immediately and exposes only a controlled result", async () => {
  const calls = [];
  const coordinator = new TagWriteCoordinator({
    execute: async (request) => {
      calls.push(request);
      return { transaction_id: "tx-1", path: request.targetPath, privateManifest: true };
    },
  });

  const result = await coordinator.submit({ requestId: "request-1", targetPath: song("One"), operation: { title: "One" } });

  assert.equal(calls.length, 1);
  assert.deepEqual(result, { ok: true, requestId: "request-1", status: "committed", transactionId: "tx-1" });
  assert.equal("path" in result, false);
  assert.equal("privateManifest" in result, false);
});

test("the current playback target waits for a matching release generation", async () => {
  const calls = [];
  const coordinator = new TagWriteCoordinator({ execute: async (request) => calls.push(request) });
  coordinator.setPlaybackTarget(song("Current"), 12);
  const completion = coordinator.submit({ requestId: "request-current", targetPath: song("Current") });

  await flush();
  assert.equal(calls.length, 0);
  assert.equal(coordinator.releasePlayback(song("Current"), 11), false);
  assert.equal(coordinator.releasePlayback(song("Other"), 12), false);
  await flush();
  assert.equal(calls.length, 0);

  assert.equal(coordinator.releasePlayback(song("Current"), 12), true);
  assert.equal((await completion).ok, true);
  assert.equal(calls.length, 1);
});

test("a late release cannot unlock a newer playback generation", async () => {
  const calls = [];
  const coordinator = new TagWriteCoordinator({ execute: async (request) => calls.push(request) });
  coordinator.setPlaybackTarget(song("Current"), "generation-1");
  const completion = coordinator.submit({ requestId: "request-current", targetPath: song("Current") });
  coordinator.setPlaybackTarget(song("Current"), "generation-2");

  assert.equal(coordinator.releasePlayback(song("Current"), "generation-1"), false);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(coordinator.releasePlayback(song("Current"), "generation-2"), true);
  await completion;
  assert.equal(calls.length, 1);
});

test("only the newest deferred request for a target runs", async () => {
  const calls = [];
  const coordinator = new TagWriteCoordinator({ execute: async (request) => calls.push(request.requestId) });
  coordinator.setPlaybackTarget(song("Current"), 4);
  const oldCompletion = coordinator.submit({ requestId: "old", targetPath: song("Current") });
  const newCompletion = coordinator.submit({ requestId: "new", targetPath: song("Current") });

  assert.deepEqual(await oldCompletion, { ok: false, requestId: "old", status: "superseded", reason: "newer-request" });
  coordinator.releasePlayback(song("Current"), 4);
  assert.equal((await newCompletion).ok, true);
  assert.deepEqual(calls, ["new"]);
});

test("cancelling a deferred request prevents a later release from running it", async () => {
  let calls = 0;
  const coordinator = new TagWriteCoordinator({ execute: async () => { calls += 1; } });
  coordinator.setPlaybackTarget(song("Current"), 5);
  const completion = coordinator.submit({ requestId: "cancel-me", targetPath: song("Current") });

  assert.deepEqual(coordinator.cancel("cancel-me"), { cancelled: true });
  assert.equal((await completion).status, "cancelled");
  coordinator.releasePlayback(song("Current"), 5);
  await flush();
  assert.equal(calls, 0);
});

test("writes for the same path stay serialized while other paths use bounded concurrency", async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const coordinator = new TagWriteCoordinator({
    maxConcurrency: 2,
    execute: ({ requestId }) => {
      calls.push(requestId);
      return requestId === "one" ? first.promise : second.promise;
    },
  });

  const one = coordinator.submit({ requestId: "one", targetPath: song("Same") });
  const same = coordinator.submit({ requestId: "same-next", targetPath: song("Same") });
  const other = coordinator.submit({ requestId: "other", targetPath: song("Other") });
  await flush();
  assert.deepEqual(calls, ["one", "other"]);

  second.resolve({ transactionId: "tx-other" });
  await other;
  assert.deepEqual(calls, ["one", "other"]);
  first.resolve({ transactionId: "tx-one" });
  await one;
  await flush();
  assert.deepEqual(calls, ["one", "other", "same-next"]);
  assert.equal((await same).ok, true);
});

test("an in-flight atomic write cannot be cancelled", async () => {
  const transaction = deferred();
  const coordinator = new TagWriteCoordinator({ execute: () => transaction.promise });
  const completion = coordinator.submit({ requestId: "running", targetPath: song("Running") });
  await flush();

  assert.deepEqual(coordinator.cancel("running"), { cancelled: false, reason: "already-running" });
  transaction.resolve({ transactionId: "tx-running" });
  assert.equal((await completion).status, "committed");
});

test("playback can wait for an active write on the same target", async () => {
  const transaction = deferred();
  const coordinator = new TagWriteCoordinator({ execute: () => transaction.promise });
  const completion = coordinator.submit({ requestId: "writing", targetPath: song("Writing") });
  await flush();

  assert.equal(coordinator.isWritingTarget(song("Writing")), true);
  assert.deepEqual(await coordinator.waitForTarget(song("Writing"), { timeoutMs: 5 }), { released: false });
  transaction.resolve({ transactionId: "tx-writing" });
  await completion;
  assert.deepEqual(await coordinator.waitForTarget(song("Writing"), { timeoutMs: 5 }), { released: true });
  assert.equal(coordinator.isWritingTarget(song("Writing")), false);
});

test("close stops queued work and rejects new requests while allowing active work to finish", async () => {
  const transaction = deferred();
  const coordinator = new TagWriteCoordinator({ execute: () => transaction.promise, maxConcurrency: 1 });
  const active = coordinator.submit({ requestId: "active", targetPath: song("Active") });
  const queued = coordinator.submit({ requestId: "queued", targetPath: song("Queued") });
  await flush();
  coordinator.close();

  assert.equal((await queued).reason, "shutdown");
  assert.throws(
    () => coordinator.submit({ requestId: "late", targetPath: song("Late") }),
    (error) => error instanceof TagWriteCoordinatorError && error.code === "COORDINATOR_CLOSED",
  );
  transaction.resolve({ transactionId: "tx-active" });
  assert.equal((await active).status, "committed");
  assert.deepEqual(await coordinator.drain({ timeoutMs: 10 }), { drained: true, pending: 0 });
});

test("drain timeout reports active work without terminating the atomic operation", async () => {
  const transaction = deferred();
  const coordinator = new TagWriteCoordinator({ execute: () => transaction.promise });
  const completion = coordinator.submit({ requestId: "slow", targetPath: song("Slow") });
  await flush();
  coordinator.close();

  assert.deepEqual(await coordinator.drain({ timeoutMs: 5 }), { drained: false, pending: 1 });
  transaction.resolve({ transactionId: "tx-slow" });
  assert.equal((await completion).status, "committed");
  assert.deepEqual(await coordinator.drain({ timeoutMs: 5 }), { drained: true, pending: 0 });
});

test("transaction failures are converted to short stable states", async () => {
  const coordinator = new TagWriteCoordinator({
    execute: async () => {
      const error = new Error(`private failure at ${song("Secret")}`);
      error.name = "ExternalFileChanged";
      throw error;
    },
  });

  const result = await coordinator.submit({ requestId: "changed", targetPath: song("Changed") });

  assert.deepEqual(result, {
    ok: false,
    requestId: "changed",
    status: "failed",
    code: "EXTERNAL_CHANGE",
    message: "歌曲已被其他程序修改",
  });
});
