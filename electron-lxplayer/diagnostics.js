'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');
const {writeJsonObjectAtomic} = require('./async-json-writer');

function redact(value, roots = []) {
  const hidden = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length);
  function clean(item, key = '') {
    if (/token|password|authorization|cookie|secret|credential|api.?key/i.test(key)) return '[已隐藏]';
    if (typeof item === 'string') {
      let text = item.slice(0, 16384).replace(/\b[A-Z]:[\\/][^\r\n"'<>|]*/gi, '[本地路径]')
        .replace(/\\\\[^\\\s]+\\[^\r\n"'<>|]+/g, '[网络共享路径]');
      for (const root of hidden) {
        const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\\/]/g, '[\\\\/]');
        text = text.replace(new RegExp(escaped, 'gi'), '[本地目录]');
      }
      return text.replace(/https?:\/\/[^\s"'<>]+/gi, url => {
          try { return new URL(url).origin + '/[请求路径已隐藏]'; } catch { return '[网络地址]'; }
        })
        .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]');
    }
    if (Array.isArray(item)) return item.slice(-80).map(value => clean(value));
    if (item && typeof item === 'object') return Object.fromEntries(
      Object.entries(item).slice(0, 100).map(([name, value]) => [name, clean(value, name)]));
    return item;
  }
  return clean(value);
}

function createDiagnostics({root, dataDir, info, packages, resources, media, gpu}) {
  let preview = null;
  let generation = 0;

  return {
    async preview(errors = []) {
      const current = ++generation;
      let indexError = null;
      const file = path.join(dataDir, 'logs/index-worker-error.json');
      try {
        if ((await fs.stat(file)).size <= 65536) indexError = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {}
      const graphics = await gpu();
      const report = redact({
        schema:1, createdAt:new Date().toISOString(), application:info(),
        system:{platform:os.platform(), release:os.release(), arch:os.arch(), totalMemory:os.totalmem()},
        graphics, packages:packages(), resources:resources(), media:media(), indexError,
        rendererErrors:errors,
      }, [root, dataDir, os.homedir()]);
      if (current !== generation) throw Error('诊断预览已更新，请重新查看。');
      preview = {id:randomUUID(), report};
      return {id:preview.id, text:JSON.stringify(report, null, 2)};
    },
    async export(id, pickFile) {
      const selected = preview;
      if (!selected || selected.id !== id) throw Error('请先生成并查看诊断预览。');
      const file = await pickFile();
      if (!file) return {ok:true, cancelled:true};
      if (preview !== selected) throw Error('诊断内容已更新，请查看新预览后再次导出。');
      await writeJsonObjectAtomic(file, selected.report);
      return {ok:true};
    },
  };
}

module.exports = {redact, createDiagnostics};
