const fs = require('node:fs/promises');
const path = require('node:path');
// Raw append-only events are authoritative. Retries may repeat event IDs;
// consumers deduplicate by eventId, never by track or playback attempt.
function createTracePersistence(directory) {
  let queue = Promise.resolve();
  const recovered = new Set();
  async function append(event) {
    if (!event || event.schemaVersion !== 1 || !/^[a-zA-Z0-9-]{8,100}$/.test(event.eventId || '') ||
        !Number.isFinite(event.occurredAt) || !event.attemptId || !event.type) throw new Error('轨迹记录格式无效');
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body) > 32768) throw new Error('轨迹记录过大');
    const month = new Date(event.occurredAt).toISOString().slice(0,7);
    const file = path.join(directory, month + '.jsonl');
    await fs.mkdir(directory, {recursive:true});
    if (!recovered.has(file)) {
      let bytes;
      try { bytes = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (bytes?.length && bytes[bytes.length-1] !== 10) {
        // Preserve the original damaged suffix before making the log appendable.
        const boundary = bytes.lastIndexOf(10) + 1;
        const suffix = bytes.subarray(boundary);
        let valid = false;
        try { JSON.parse(suffix.toString('utf8')); valid = true; } catch (_) {}
        if (valid) await fs.appendFile(file, '\n');
        else {
          const backup = await fs.open(file + '.tail-' + Date.now(), 'wx');
          try { await backup.writeFile(suffix); await backup.sync(); } finally { await backup.close(); }
          await fs.truncate(file, boundary);
        }
      }
      recovered.add(file);
    }
    const handle = await fs.open(file, 'a');
    try { await handle.writeFile(body + '\n'); await handle.sync(); }
    catch (error) { recovered.delete(file); throw error; }
    finally { await handle.close(); }
    return {ok:true,eventId:event.eventId};
  }
  return {
    append(event) { const result = queue.then(() => append(event)); queue = result.catch(() => {}); return result; },
    frontier() {
      const result = queue.then(async () => {
        const offsets = {};
        let names;
        try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return offsets; throw error; }
        for (const name of names.filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name))) {
          const handle = await fs.open(path.join(directory, name), 'r');
          try {
            const {size} = await handle.stat();
            const tail = Buffer.alloc(Math.min(size, 32769));
            await handle.read(tail, 0, tail.length, size - tail.length);
            const newline = tail.lastIndexOf(10);
            // A damaged/unfinished suffix has no durable event boundary.
            if (size && newline < 0) throw new Error('轨迹日志尾部无法确认');
            offsets[name] = size - tail.length + newline + 1;
          } finally { await handle.close(); }
        }
        return offsets;
      });
      queue = result.catch(() => {});
      return result;
    },
    flush() { return queue; },
  };
}
module.exports = {createTracePersistence};
