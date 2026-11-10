'use strict';

// Windows can report one media command through several independent providers.
// Firmware maps gestures to commands; this coordinator never counts taps.
class MediaInputCoordinator {
  constructor({ deliver, now = Date.now, schedule = setTimeout, cancel = clearTimeout, windowMs = 40, duplicateMs = 250 }) {
    Object.assign(this, { deliver, now, schedule, cancel, windowMs, duplicateMs });
    this.pending = new Map();
    this.recent = new Map();
  }
  submit(action, source) {
    if (!['play', 'pause', 'play_pause', 'stop', 'next_like', 'dislike_next'].includes(action)) return false;
    const family = ['play', 'pause', 'play_pause', 'stop'].includes(action) ? 'transport' : action;
    const time = this.now();
    const previous = this.recent.get(family);
    if (previous && time - previous.time < this.duplicateMs && previous.source !== source) {
      // A late explicit pause may correct an earlier ambiguous toggle. A late
      // toggle must never undo a pause (including a wear-detection pause).
      if (!(action === 'pause' && previous.action === 'play_pause')) return false;
    }
    let pending = this.pending.get(family);
    if (pending && pending.source === source) {
      this.flush(family); // Distinct commands from one provider remain distinct.
      pending = null;
    }
    if (pending) {
      const priority = { stop: 4, pause: 3, play: 2, play_pause: 1 };
      if ((priority[action] || 0) > (priority[pending.action] || 0)) pending.action = action;
      return true;
    }
    pending = { action, source, timer: this.schedule(() => this.flush(family), this.windowMs) };
    this.pending.set(family, pending);
    return true;
  }
  flush(family) {
    const item = this.pending.get(family);
    if (!item) return;
    this.pending.delete(family);
    this.cancel(item.timer);
    this.recent.set(family, { action: item.action, source: item.source, time: this.now() });
    this.deliver(item.action, item.source);
  }
  dispose() {
    for (const item of this.pending.values()) this.cancel(item.timer);
    this.pending.clear();
    this.recent.clear();
  }
}

module.exports = { MediaInputCoordinator };
