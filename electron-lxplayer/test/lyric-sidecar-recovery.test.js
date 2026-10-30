const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createLyricSidecarRecoveryGate,
  recoverLyricSidecarTransactions,
} = require("../song-info/lyric-sidecar-recovery");

test("startup recovery reports only aggregate statuses", async () => {
  const diagnostics = [];
  const summary = await recoverLyricSidecarTransactions({
    store: {
      recoverIncomplete: async () => [
        { status: "committed", transactionId: "tx-1", audioPath: "D:/private/song.mp3" },
        { status: "aborted", transactionId: "tx-2" },
        { status: "conflict", transactionId: "tx-3", reason: "target-changed" },
        { status: "invalid", transactionId: "tx-4" },
        { status: "failed", transactionId: "tx-5" },
      ],
    },
    onDiagnostic: (value) => diagnostics.push(value),
  });

  assert.deepEqual(summary, {
    total: 5,
    committed: 1,
    aborted: 1,
    conflict: 1,
    invalid: 1,
    failed: 1,
  });
  assert.deepEqual(diagnostics, [summary]);
  assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  assert.equal(JSON.stringify(diagnostics).includes("tx-"), false);
});

test("startup recovery contains store failure without rejecting app bootstrap", async () => {
  const diagnostics = [];
  const summary = await recoverLyricSidecarTransactions({
    store: { recoverIncomplete: async () => { throw new Error("D:/private/manifest.json"); } },
    onDiagnostic: (value) => diagnostics.push(value),
  });

  assert.deepEqual(summary, {
    total: 0,
    committed: 0,
    aborted: 0,
    conflict: 0,
    invalid: 0,
    failed: 1,
  });
  assert.deepEqual(diagnostics, [summary]);
});

test("startup can continue while recent undo waits for sidecar recovery", async () => {
  let finishRecovery;
  const recoveryPending = new Promise((resolve) => { finishRecovery = resolve; });
  const order = [];
  const gate = createLyricSidecarRecoveryGate({
    recover: async () => {
      order.push("recovery-started");
      await recoveryPending;
      order.push("recovery-finished");
      return { total: 1, committed: 1, aborted: 0, conflict: 0, invalid: 0, failed: 0 };
    },
  });

  gate.start();
  order.push("window-created");
  const recentLookup = (async () => {
    await gate.wait();
    order.push("recent-read");
    return { ok: true, transaction: { transactionId: "tx-recovered" } };
  })();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["window-created", "recovery-started"]);
  finishRecovery();
  const recent = await recentLookup;
  assert.equal(recent.transaction.transactionId, "tx-recovered");
  assert.deepEqual(order, ["window-created", "recovery-started", "recovery-finished", "recent-read"]);
});

test("recovery gate settles failures without exposing the original error", async () => {
  const gate = createLyricSidecarRecoveryGate({
    recover: async () => { throw new Error("D:/private/transactions/tx-secret/manifest.json"); },
  });

  const summary = await gate.start();

  assert.deepEqual(summary, {
    total: 0,
    committed: 0,
    aborted: 0,
    conflict: 0,
    invalid: 0,
    failed: 1,
  });
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.deepEqual(await gate.wait(), summary);
});
