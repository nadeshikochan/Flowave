const assert = require("node:assert/strict");
const test = require("node:test");

const { validateBackendHealth } = require("../backend-health");

const OPTIONS = {
  serviceId: "kumiko-music-local",
  protocolVersion: 1,
  dataDir: "D:\\Apps\\Flowave\\data",
};

function health(overrides = {}) {
  return {
    ok: true,
    service: "kumiko-music-local",
    protocol_version: 1,
    data_dir: "D:\\Apps\\Flowave\\data",
    ...overrides,
  };
}

test("backend handshake accepts the same portable data directory case-insensitively", () => {
  const result = validateBackendHealth(
    health({ data_dir: "d:/apps/FLOWAVE/data/" }),
    OPTIONS,
  );

  assert.equal(result.valid, true);
});

test("backend handshake rejects another installation of the same product", () => {
  const result = validateBackendHealth(
    health({ data_dir: "D:\\Projects\\Flowave\\data" }),
    OPTIONS,
  );

  assert.equal(result.valid, false);
  assert.match(result.detail, /数据目录不匹配/);
});

test("backend handshake still rejects service and protocol mismatches", () => {
  assert.equal(validateBackendHealth(health({ service: "other" }), OPTIONS).valid, false);
  assert.equal(validateBackendHealth(health({ protocol_version: 2 }), OPTIONS).valid, false);
  assert.equal(validateBackendHealth(health({ ok: false }), OPTIONS).valid, false);
});
