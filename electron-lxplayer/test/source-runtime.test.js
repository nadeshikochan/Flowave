const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.KUMIKO_SOURCE_RESOLVE_TIMEOUT_MS = "80";
const runtime = require("../online/source-runtime");

function writeScript(dir, name, body) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, body, "utf8");
  return target;
}

function validScript(source, marker) {
  return `
    const { EVENT_NAMES, on, send } = globalThis.lx;
    on(EVENT_NAMES.request, ({ source: requested }) => Promise.resolve("https://example.com/${marker}/" + requested));
    send(EVENT_NAMES.inited, {
      status: true,
      sources: {
        ${source}: {
          name: "${source}",
          type: "music",
          actions: ["musicUrl"],
          qualitys: ["320K", "flac"]
        }
      }
    });
  `;
}

test("candidate validation does not replace the active runtime before commit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-source-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firstPath = writeScript(dir, "first.js", validScript("wy", "first"));
  const secondPath = writeScript(dir, "second.js", validScript("tx", "second"));

  runtime.setScriptPath(firstPath);
  await runtime.reloadRuntime();
  const candidate = await runtime.prepareScriptPath(secondPath);

  assert.equal(runtime.getScriptPath(), path.resolve(firstPath));
  assert.deepEqual(Object.keys(runtime.getSourceInfo()), ["wy"]);
  assert.equal(await runtime.resolveMusicUrl("wy", {}, "320k"), "https://example.com/first/wy");

  runtime.commitPreparedRuntime(candidate);
  assert.equal(runtime.getScriptPath(), path.resolve(secondPath));
  assert.deepEqual(Object.keys(runtime.getSourceInfo()), ["tx"]);
  assert.deepEqual(runtime.getSourceInfo().tx.qualities, ["320k", "flac"]);
  assert.equal(await runtime.resolveMusicUrl("tx", {}, "320k"), "https://example.com/second/tx");
});

test("invalid candidates leave the last-known-good runtime usable", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-source-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const goodPath = writeScript(dir, "good.js", validScript("kg", "good"));
  const syntaxErrorPath = writeScript(dir, "syntax-error.js", "const = broken");
  const noHandlerPath = writeScript(
    dir,
    "no-handler.js",
    `globalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, {
      status: true,
      sources: { wy: { actions: ["musicUrl"], qualitys: ["320k"] } }
    });`,
  );

  runtime.setScriptPath(goodPath);
  await runtime.reloadRuntime();

  await assert.rejects(runtime.prepareScriptPath(syntaxErrorPath));
  await assert.rejects(runtime.prepareScriptPath(noHandlerPath), /request handler/);
  assert.equal(runtime.getScriptPath(), path.resolve(goodPath));
  assert.deepEqual(Object.keys(runtime.getSourceInfo()), ["kg"]);
  assert.equal(await runtime.resolveMusicUrl("kg", {}, "320k"), "https://example.com/good/kg");
});

test("invalid source declarations are rejected", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-source-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missingQualityPath = writeScript(
    dir,
    "missing-quality.js",
    `const { EVENT_NAMES, on, send } = globalThis.lx;
     on(EVENT_NAMES.request, () => Promise.resolve("url"));
     send(EVENT_NAMES.inited, {
       status: true,
       sources: { wy: { actions: ["musicUrl"], qualitys: [] } }
     });`,
  );
  const missingActionPath = writeScript(
    dir,
    "missing-action.js",
    `const { EVENT_NAMES, on, send } = globalThis.lx;
     on(EVENT_NAMES.request, () => Promise.resolve("url"));
     send(EVENT_NAMES.inited, {
       status: true,
       sources: { wy: { actions: [], qualitys: ["320k"] } }
     });`,
  );

  await assert.rejects(runtime.prepareScriptPath(missingQualityPath), /有效音质/);
  await assert.rejects(runtime.prepareScriptPath(missingActionPath), /musicUrl/);
});

test("resolver responses enforce deadline, URL policy, and runtime generation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-source-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const neverPath = writeScript(
    dir,
    "never.js",
    `const { EVENT_NAMES, on, send } = globalThis.lx;
     on(EVENT_NAMES.request, () => new Promise(() => {}));
     send(EVENT_NAMES.inited, {
       status: true,
       sources: { wy: { actions: ["musicUrl"], qualitys: ["320k"] } }
     });`,
  );
  const invalidUrlPath = writeScript(
    dir,
    "invalid-url.js",
    `const { EVENT_NAMES, on, send } = globalThis.lx;
     on(EVENT_NAMES.request, () => Promise.resolve("file:///C:/secret.mp3"));
     send(EVENT_NAMES.inited, {
       status: true,
       sources: { wy: { actions: ["musicUrl"], qualitys: ["320k"] } }
     });`,
  );
  const slowPath = writeScript(
    dir,
    "slow.js",
    `const { EVENT_NAMES, on, send } = globalThis.lx;
     on(EVENT_NAMES.request, () => new Promise((resolve) => {
       setTimeout(() => resolve("https://example.com/stale"), 40);
     }));
     send(EVENT_NAMES.inited, {
       status: true,
       sources: { wy: { actions: ["musicUrl"], qualitys: ["320k"] } }
     });`,
  );
  const replacementPath = writeScript(dir, "replacement.js", validScript("wy", "replacement"));

  runtime.setScriptPath(neverPath);
  await runtime.reloadRuntime();
  await assert.rejects(runtime.resolveMusicUrl("wy", {}, "320k"), /超过 80ms/);

  runtime.setScriptPath(invalidUrlPath);
  await runtime.reloadRuntime();
  await assert.rejects(runtime.resolveMusicUrl("wy", {}, "320k"), /协议不允许/);

  runtime.setScriptPath(slowPath);
  await runtime.reloadRuntime();
  const staleRequest = runtime.resolveMusicUrl("wy", {}, "320k");
  const replacement = await runtime.prepareScriptPath(replacementPath);
  runtime.commitPreparedRuntime(replacement);
  await assert.rejects(staleRequest, /旧解析结果已丢弃/);
});
