'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readInstallPlan(root, catalog) {
  if (!catalog.installation_plan) return {profiles: {}, archives: {}};
  const entry = catalog.installation_plan;
  const bytes = fs.readFileSync(path.join(root, entry.file));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw Error('安装资源预算清单校验失败，请更新软件。');
  return JSON.parse(bytes);
}

function modulePlan(catalog, plan, id, ready) {
  const module = catalog.modules[id];
  const downloads = new Map();
  const items = [];
  let expandedBytes = 0;
  for (const key of module.profiles || []) {
    const profile = catalog.profiles[key], row = plan.profiles[key];
    if (!row || row.lock_sha256 !== profile.lock_sha256)
      throw Error('计算环境的安装清单不完整，请更新软件。');
    const installed = ready('runtimes', key, profile);
    items.push({id: key, name: profile.name, ready: installed,
      bytes: row.files.reduce((sum, file) => sum + file.bytes, 0)});
    if (!installed) {
      for (const file of row.files) downloads.set(file.sha256, file);
      expandedBytes += row.expandedBytes * 2;
    }
  }
  for (const key of module.groups || []) {
    const group = catalog.groups[key], installed = ready('assets', key, group);
    items.push({id: key, name: group.name, ready: installed,
      bytes: group.files.reduce((sum, file) => sum + file.bytes, 0)});
    if (!installed) {
      for (const file of group.files) {
        downloads.set(file.sha256, file);
        if (file.extract_files) expandedBytes += file.extract_files.reduce((sum, row) => sum + row.bytes, 0);
        else if (file.extract_to || file.extract_member_suffix) expandedBytes += plan.archives[file.sha256];
        else expandedBytes += file.bytes;
      }
    }
  }
  const files = [...downloads.values()];
  const downloadBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const largestFileBytes = Math.max(0, ...files.map(file => file.bytes));
  return {ready: items.every(row => row.ready), items, license: module.license,
    downloadBytes, expandedBytes, largestFileBytes,
    spaceBudgetBytes: downloadBytes + expandedBytes + largestFileBytes};
}

module.exports = {readInstallPlan, modulePlan};
