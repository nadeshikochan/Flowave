const path = require("path");

function normalizeWindowsPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.win32.resolve(raw).replace(/[\\/]+$/, "").toLowerCase();
}

function validateBackendHealth(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return { valid: false, detail: "健康信息格式无效" };
  }
  if (payload.service !== options.serviceId) {
    return { valid: false, detail: "服务标识不匹配" };
  }
  if (Number(payload.protocol_version) !== Number(options.protocolVersion)) {
    return { valid: false, detail: "协议版本不匹配" };
  }
  if (payload.ok !== true) {
    return { valid: false, detail: "服务尚未就绪" };
  }
  if (options.featureSignature && payload.features_signature !== options.featureSignature) {
    return {valid:false,detail:'功能选择与当前软件不一致，请完全退出旧后台后重试'};
  }
  const expectedDataDir = normalizeWindowsPath(options.dataDir);
  const actualDataDir = normalizeWindowsPath(payload.data_dir);
  if (!expectedDataDir || !actualDataDir || expectedDataDir !== actualDataDir) {
    return { valid: false, detail: "运行数据目录不匹配" };
  }
  return { valid: true, detail: "" };
}

module.exports = {
  normalizeWindowsPath,
  validateBackendHealth,
};
