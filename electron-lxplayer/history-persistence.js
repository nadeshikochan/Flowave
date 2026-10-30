const { validateHistoryProgress } = require('./listening-history-store');

// 保存可合并，维护操作为不可跨越的顺序屏障。成功只在文件提交后返回。
function createHistoryPersistence({ initial, write, operate }) {
  let state = initial, running = false;
  const queue = [], drains = [];
  const revision = value => Number(value?.persistenceRevision || 0);
  function finish() { if (!running && !queue.length) drains.splice(0).forEach(resolve => resolve()); }
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const task = queue.shift();
      let result;
      try {
        if (task.kind === 'save') {
          if (revision(task.value) !== revision(state) || !validateHistoryProgress(state, task.value)) {
            result = { ok: false, error: '听歌记录版本过期或统计异常减少，原有记录已保留。' };
          } else {
            result = await write(task.value);
            if (result.ok) state = task.value;
          }
        } else {
          result = await operate(state, task.kind, revision(state) + 1);
          if (result.ok) state = result.history;
        }
      } catch (error) { result = { ok: false, error: String(error?.message || error) }; }
      task.waiters.forEach(resolve => resolve(result));
    }
    running = false;
    finish();
  }
  function enqueue(kind, value) {
    return new Promise(resolve => {
      const tail = queue[queue.length - 1];
      // 不允许较旧快照覆盖等待中的更新。
      if (kind === 'save' && tail?.kind === 'save'
          && revision(value) === revision(tail.value) && validateHistoryProgress(tail.value, value)) {
        tail.value = value;
        tail.waiters.push(resolve);
      } else queue.push({ kind, value, waiters: [resolve] });
      queueMicrotask(pump);
    });
  }
  return {
    get state() { return state; },
    save: value => enqueue('save', value),
    operation: kind => enqueue(kind),
    flush: () => !running && !queue.length ? Promise.resolve() : new Promise(resolve => drains.push(resolve)),
  };
}
module.exports = { createHistoryPersistence };
