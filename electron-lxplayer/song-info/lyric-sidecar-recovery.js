function emptySummary() {
  return {
    total: 0,
    committed: 0,
    aborted: 0,
    conflict: 0,
    invalid: 0,
    failed: 0,
  };
}

async function recoverLyricSidecarTransactions({ store, onDiagnostic = () => {} } = {}) {
  if (!store || typeof store.recoverIncomplete !== "function") {
    throw new TypeError("recoverLyricSidecarTransactions requires store");
  }
  const summary = emptySummary();
  try {
    const outcomes = await store.recoverIncomplete();
    for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
      const status = String(outcome?.status || "");
      summary.total += 1;
      if (Object.hasOwn(summary, status) && status !== "total") summary[status] += 1;
      else summary.failed += 1;
    }
  } catch (_) {
    summary.failed += 1;
  }
  if (summary.total || summary.failed) {
    try { onDiagnostic({ ...summary }); } catch (_) {}
  }
  return summary;
}

function createLyricSidecarRecoveryGate({ recover = recoverLyricSidecarTransactions } = {}) {
  if (typeof recover !== "function") {
    throw new TypeError("createLyricSidecarRecoveryGate requires recover");
  }
  let pending = Promise.resolve(emptySummary());
  return {
    start(options) {
      pending = Promise.resolve()
        .then(() => recover(options))
        .catch(() => ({ ...emptySummary(), failed: 1 }));
      return pending;
    },
    wait() {
      return pending;
    },
  };
}

module.exports = {
  createLyricSidecarRecoveryGate,
  emptySummary,
  recoverLyricSidecarTransactions,
};
