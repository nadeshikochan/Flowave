const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadListeningHistoryWithRecovery,
  readHistoryFile,
} = require("../listening-history-store");

function createTempConfig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-history-store-"));
  const configDir = path.join(root, "config");
  fs.mkdirSync(configDir, { recursive: true });
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return configDir;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeBackup(configDir, day, value) {
  const filePath = path.join(
    configDir,
    "listening-history-backups",
    `listening_history.${day}.json`,
  );
  writeText(filePath, typeof value === "string" ? value : JSON.stringify(value));
  return filePath;
}

test("corrupt primary skips invalid latest backup and restores the newest valid backup", (t) => {
  const configDir = createTempConfig(t);
  const primaryPath = path.join(configDir, "listening_history.json");
  writeText(primaryPath, "{broken-primary");
  writeBackup(configDir, "2026-07-30", "{broken-backup");
  writeBackup(configDir, "2026-07-29", { version: 1, totalSeconds: 42, tracks: {}, days: {} });

  const result = loadListeningHistoryWithRecovery({
    configDir,
    now: new Date(2026, 6, 30, 12, 0, 0).getTime(),
    randomBytes: () => Buffer.from("01020304", "hex"),
  });

  assert.equal(result.history.totalSeconds, 42);
  assert.equal(result.status.state, "recovered");
  assert.equal(result.status.recovered, true);
  assert.equal(result.status.writeBlocked, false);
  assert.equal(result.status.sourceBackup, "listening_history.2026-07-29.json");
  assert.deepEqual(result.status.invalidBackups, ["listening_history.2026-07-30.json"]);
  assert.match(result.status.corruptArchive, /\.corrupt\.json$/);
  const archivePath = path.join(configDir, "listening-history-corrupt", result.status.corruptArchive);
  assert.equal(fs.readFileSync(archivePath, "utf-8"), "{broken-primary");
  assert.equal(readHistoryFile(primaryPath).value.totalSeconds, 42);
});

test("missing primary restores the newest valid daily backup", (t) => {
  const configDir = createTempConfig(t);
  const primaryPath = path.join(configDir, "listening_history.json");
  writeBackup(configDir, "2026-07-28", { version: 1, totalSeconds: 12, tracks: {}, days: {} });
  writeBackup(configDir, "2026-07-29", { version: 1, totalSeconds: 24, tracks: {}, days: {} });

  const result = loadListeningHistoryWithRecovery({ configDir });

  assert.equal(result.history.totalSeconds, 24);
  assert.equal(result.status.sourceDay, "2026-07-29");
  assert.equal(result.status.corruptArchive, "");
  assert.equal(readHistoryFile(primaryPath).value.totalSeconds, 24);
});

test("unreadable primary and backups are preserved and block automatic overwrite", (t) => {
  const configDir = createTempConfig(t);
  const primaryPath = path.join(configDir, "listening_history.json");
  writeText(primaryPath, "{still-broken");
  writeBackup(configDir, "2026-07-30", "[]");

  const result = loadListeningHistoryWithRecovery({
    configDir,
    randomBytes: () => Buffer.from("05060708", "hex"),
  });

  assert.deepEqual(result.history, {});
  assert.equal(result.status.state, "unrecoverable");
  assert.equal(result.status.writeBlocked, true);
  assert.deepEqual(result.status.invalidBackups, ["listening_history.2026-07-30.json"]);
  assert.equal(fs.readFileSync(primaryPath, "utf-8"), "{still-broken");
  assert.match(result.status.warning, /阻止自动覆盖/);
  const archivePath = path.join(configDir, "listening-history-corrupt", result.status.corruptArchive);
  assert.equal(fs.readFileSync(archivePath, "utf-8"), "{still-broken");
});

test("new install without primary or backups starts empty without write blocking", (t) => {
  const configDir = createTempConfig(t);

  const result = loadListeningHistoryWithRecovery({ configDir });

  assert.deepEqual(result.history, {});
  assert.equal(result.status.state, "empty");
  assert.equal(result.status.recovered, false);
  assert.equal(result.status.writeBlocked, false);
});


test("ordinary saves reject lost tracks while allowing identity relocation", () => {
  const { validateHistoryProgress } = require("../listening-history-store");
  const track = { resourceId: "r1", path: "old", playCount: 2, listenedSeconds: 30 };
  const before = { totalSeconds: 30, totalPlays: 2, days: { "2026-10-01": 30 }, tracks: { old: track } };
  assert.equal(validateHistoryProgress(before, { ...before, tracks: {} }), false);
  assert.equal(validateHistoryProgress(before, { ...before, tracks: { moved: { ...track, path: "moved" } } }), true);
  assert.equal(validateHistoryProgress(before, { ...before, days: {} }), false);
});

test("pending recovery retains new listening and survives cleanup failure without duplication", t => {
  const configDir = createTempConfig(t);
  const baseline = { totalSeconds: 10, totalPlays: 1, days: { "2026-10-18": 10 }, tracks: { x: { resourceId: "r", playCount: 1, listenedSeconds: 10 } } };
  const current = { ...baseline, totalSeconds: 15, totalPlays: 2, days: { "2026-10-18": 15 }, tracks: { x: { resourceId: "r", playCount: 2, listenedSeconds: 15 } } };
  const recovered = { ...baseline, days: { "2026-10-17": 30, "2026-10-18": 10 }, tracks: { x: { resourceId: "r", playCount: 4, listenedSeconds: 40 } } };
  writeText(path.join(configDir, "listening_history.json"), JSON.stringify(current));
  writeText(path.join(configDir, "listening_history.recovery-pending.json"), JSON.stringify({ recoveryKind: "verified-disjoint-days-v1", recoveryId: "once", history: recovered, baseline }));
  let fail = true;
  const fileSystem = Object.create(fs);
  fileSystem.unlinkSync = p => { if (fail && p.endsWith("recovery-pending.json")) throw Error("locked"); return fs.unlinkSync(p); };
  const first = loadListeningHistoryWithRecovery({ configDir, fileSystem });
  assert.equal(first.history.totalSeconds, 45);
  assert.equal(first.history.totalPlays, 5);
  fail = false;
  const second = loadListeningHistoryWithRecovery({ configDir, fileSystem });
  assert.equal(second.history.totalPlays, 5);
  assert.equal(second.history.totalSeconds, 45);
});
