const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// Immutable lyric bodies live beside the small metadata index. This owner keeps
// pending writes and a bounded recent-text cache, independent of renderer state.
class MetadataLyricsCache {
  constructor(directory, budget = 4 * 1024 * 1024) {
    this.directory = directory;
    this.budget = budget;
    this.pending = new Map();
    this.recent = new Map();
    this.bytes = 0;
  }
  remember(hash, text) {
    const previous = this.recent.get(hash);
    if (previous !== undefined) { this.bytes -= previous.length * 2; this.recent.delete(hash); }
    if (text.length * 2 > this.budget) return;
    this.recent.set(hash, text); this.bytes += text.length * 2;
    while (this.bytes > this.budget) {
      const oldest = this.recent.keys().next().value;
      this.bytes -= this.recent.get(oldest).length * 2;
      this.recent.delete(oldest);
    }
  }
  pack(value) {
    if (!value || typeof value !== 'object') return value;
    if (!Object.hasOwn(value, 'lyrics') && !Object.hasOwn(value, 'lyricsProvenance')) return value;
    const small = { ...value };
    delete small.lyrics; delete small.lyricsProvenance; delete small.lyricsModel;
    if (!value.lyrics && !value.lyricsProvenance) {
      delete small._lyricBlob;
      return small;
    }
    const text = JSON.stringify({ lyrics: value.lyrics || '', lyricsProvenance: value.lyricsProvenance || null });
    const hash = createHash('sha256').update(text).digest('hex');
    if (value._lyricBlob !== hash) this.pending.set(hash, text);
    this.remember(hash, text);
    small._lyricBlob = hash;
    return small;
  }
  async expand(value) {
    const hash = value?._lyricBlob;
    if (!hash) return value;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('歌词缓存索引无效');
    let text = this.pending.get(hash) ?? this.recent.get(hash);
    if (text === undefined) {
      text = await fs.readFile(path.join(this.directory, hash + '.json'), 'utf8');
      if (createHash('sha256').update(text).digest('hex') !== hash) throw Error('歌词缓存校验失败');
    }
    const details = JSON.parse(text);
    this.remember(hash, text);
    return { ...value, ...details };
  }
  async persist() {
    if (!this.pending.size) return;
    await fs.mkdir(this.directory, { recursive: true });
    for (const [hash, text] of [...this.pending]) {
      const target = path.join(this.directory, hash + '.json');
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, text, { flag: 'wx' });
        await fs.rename(temporary, target);
        if (this.pending.get(hash) === text) this.pending.delete(hash);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
  }
}

module.exports = { MetadataLyricsCache };
