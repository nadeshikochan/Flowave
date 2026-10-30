// Managed startup artwork. Decode only on explicit import; startup reads a tiny record.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeJsonObjectAtomic } = require('./async-json-writer');
const { toLocalMediaUrl } = require('./secure-protocols');

class StartupBackgroundStore {
  constructor(directory, { writeRecord = writeJsonObjectAtomic, sharp } = {}) {
    this.directory = directory;
    this.recordPath = path.join(directory, 'startup-background.json');
    this.writeRecord = writeRecord;
    this.sharp = sharp;
    this.pending = Promise.resolve();
    try { this.record = JSON.parse(fs.readFileSync(this.recordPath, 'utf8')); } catch { this.record = null; }
  }
  get() {
    const file = this.record?.file;
    if (!/^[a-f0-9]{64}\.webp$/.test(file || '')) return { custom: false, name: '', url: '' };
    const target = path.join(this.directory, file);
    try { if (fs.statSync(target).isFile()) return { custom: true, name: String(this.record.name || '自定义图片'), url: toLocalMediaUrl(target) }; } catch {}
    return { custom: false, name: '', url: '', message: '自定义图片不可用，已使用默认背景。' };
  }
  enqueue(work) {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
  importFile(source) {
    return this.enqueue(async () => {
      const stat = await fsp.stat(source);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('请选择不超过25MB的图片。');
      const input = await fsp.readFile(source);
      if (input.length > 25 * 1024 * 1024) throw new Error('请选择不超过25MB的图片。');
      const sharp = this.sharp || require('sharp');
      const image = sharp(input, { limitInputPixels: 40000000 });
      const meta = await image.metadata();
      if (!['png', 'jpeg', 'webp', 'avif', 'heif'].includes(meta.format) || (meta.pages || 1) > 1) {
        throw new Error('请选择PNG、JPEG、WebP或AVIF静态图片。');
      }
      const bytes = await image.rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
      const file = createHash('sha256').update(bytes).digest('hex') + '.webp';
      const target = path.join(this.directory, file), staged = path.join(this.directory, randomUUID() + '.tmp');
      await fsp.mkdir(this.directory, { recursive: true });
      try {
        await fsp.writeFile(staged, bytes, { flag: 'wx' });
        await fsp.rename(staged, target);
        const next = { file, name: path.basename(source) };
        await this.writeRecord(this.recordPath, next);
        const previous = this.record?.file;
        this.record = next;
        // Keep the previous choice for in-flight image loads; remove only our own older exports.
        for (const entry of await fsp.readdir(this.directory).catch(() => [])) {
          if (/^[a-f0-9]{64}\.webp$/.test(entry) && entry !== file && entry !== previous) {
            await fsp.unlink(path.join(this.directory, entry)).catch(() => {});
          }
        }
        return this.get();
      } finally { await fsp.unlink(staged).catch(() => {}); }
    });
  }
  reset() {
    return this.enqueue(async () => {
      await this.writeRecord(this.recordPath, {});
      this.record = null;
      return this.get();
    });
  }
}
module.exports = { StartupBackgroundStore };
