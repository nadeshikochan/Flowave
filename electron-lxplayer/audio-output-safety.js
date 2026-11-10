'use strict';

// Owns only Flowave's mute/lease. It never changes the system default device,
// other applications' volume or microphone permissions.
class AudioOutputSafety {
  constructor(monitor) {
    this.monitor = monitor;
    this.owner = null;
    this.mutedOwners = new WeakSet();
    this.active = false;
    this.blocked = false;
    this.endpoint = '';
    this.endpointConfirmed = false;
    this.revision = 0;
    this.lease = 'playback-output-safety';
    this.changed = value => this.route(value);
    this.event = value => this.deviceEvent(value);
    this.wear = value => {
      if (this.active && this.endpoint && value.id === this.endpoint && value.status === 'reported' && value.worn === false)
        this.trip('headphones-removed');
    };
    monitor.on('change', this.changed);
    monitor.on('device-event', this.event);
    monitor.on('wear-state', this.wear);
  }
  async prepare(owner, { resume = false, allowOutputChange = false } = {}) {
    if (this.owner && this.owner !== owner) this.release();
    this.owner = owner;
    if (this.mutedOwners.has(owner)) this.blocked = true;
    if (!this.active) { this.active = true; this.monitor.acquire(this.lease); }
    const revision = this.revision;
    const cached = this.monitor.state;
    const route = cached?.id && ['bluetooth','other'].includes(cached.transport) && Date.now() - cached.sampledAt < 1000
      ? cached : await this.monitor.get();
    if (revision !== this.revision || owner !== this.owner || !this.active) return { ok: false, blocked: this.blocked };
    if (!this.blocked && resume && allowOutputChange) { this.endpoint = ''; this.endpointConfirmed = false; }
    if (this.blocked) {
      const sameHeadphones = route.transport === 'bluetooth' && route.id && route.id === this.endpoint;
      if (!resume || !(allowOutputChange || sameHeadphones)) { this.pause(owner); return { ok: false, blocked: true }; }
      this.blocked = false;
      this.endpoint = route.transport === 'bluetooth' ? route.id : '';
      this.endpointConfirmed = route.confirmed === true;
      owner.setAudioMuted(false);
      this.mutedOwners.delete(owner);
    }
    this.route(route);
    return { ok: !this.blocked, blocked: this.blocked, warning: !this.endpoint && route.transport !== 'other' ? 'output-unconfirmed' : '' };
  }
  route(value) {
    if (!this.active || this.blocked || !value) return;
    if (value.transport === 'bluetooth' && value.id && (value.confirmed || value.route === 'default')) {
      if (this.endpoint && this.endpoint !== value.id && this.endpointConfirmed) this.trip('output-changed');
      else { this.endpoint = value.id; this.endpointConfirmed = this.endpointConfirmed || value.confirmed === true; }
    } else if (value.confirmed && !this.endpointConfirmed) {
      this.endpoint = ''; // The app's actual output can differ from the default.
    } else if (this.endpoint && (value.confirmed || ['no-output', 'probe-unavailable', 'probe-stale', 'probe-timeout'].includes(value.reason))) {
      this.trip('headphones-unavailable');
    }
    // A native wear report can precede the route snapshot during startup.
    this.wear(this.monitor.wearState || {});
  }
  deviceEvent(value) {
    if (!this.active || !this.endpoint || this.blocked) return;
    const lost = value.id === this.endpoint && (value.kind === 'removed' || value.kind === 'state' && value.state !== 1);
    const switched = value.kind === 'default' && value.flow === 0 && value.role !== 2 && value.id !== this.endpoint;
    if (lost || switched) this.trip(lost ? 'headphones-disconnected' : 'output-changed');
  }
  trip(reason) {
    if (this.blocked) return;
    this.blocked = true;
    this.revision++;
    if (this.owner && !this.owner.isDestroyed()) {
      this.mutedOwners.add(this.owner);
      this.owner.setAudioMuted(true); // Mute before asking the renderer to pause.
      this.owner.send('lx-audio-output-safety', { reason });
    }
  }
  pause(owner) {
    if (owner !== this.owner || !this.active) return;
    this.active = false;
    this.revision++;
    this.monitor.release(this.lease);
  }
  release() {
    this.active = false;
    this.revision++;
    this.monitor.release(this.lease);
    this.owner = null;
    this.endpoint = '';
    this.endpointConfirmed = false;
    this.blocked = false;
  }
  dispose() {
    this.release();
    this.monitor.off('change', this.changed);
    this.monitor.off('device-event', this.event);
    this.monitor.off('wear-state', this.wear);
  }
}

module.exports = { AudioOutputSafety };
