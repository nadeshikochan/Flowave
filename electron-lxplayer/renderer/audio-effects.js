(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlowaveAudioEffects = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const frequencies = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const presets = Object.freeze({
    flat: { label: '平直', gains: [0,0,0,0,0,0,0,0,0,0] },
    bass: { label: '低音增强', gains: [4,4,3,1,0,0,0,0,0,0] },
    vocal: { label: '人声', gains: [-2,-1,0,1,2,3,2,1,0,-1] },
    soft: { label: '柔和', gains: [1,1,0,0,0,-1,-2,-2,-3,-3] },
  });
  const clamp = (value, min, max, fallback) => value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value))
    ? Math.min(max, Math.max(min, Number(value))) : fallback;
  function normalize(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const known = raw.version === undefined || raw.version === 1;
    return { version: 1, enabled: known && raw.enabled === true,
      gains: frequencies.map((_, i) => clamp(raw.gains?.[i], -12, 12, 0)),
      preamp: clamp(raw.preamp, -24, 0, 0), autoHeadroom: raw.autoHeadroom !== false,
      preset: Object.hasOwn(presets, raw.preset) ? raw.preset : (raw.preset ? 'custom' : 'flat'),
      crossfade: known && raw.crossfade === true, seconds: clamp(raw.seconds, 1, 8, 3) };
  }
  function waitReady(element, assertCurrent, timeout = 7000) {
    return new Promise((resolve, reject) => {
      let timer, guardTimer;
      const cleanup = () => { clearTimeout(timer); clearInterval(guardTimer); for (const name of ['canplay','error']) element.removeEventListener(name, check); };
      function check(event) {
        try {
          assertCurrent();
          if (event && event.type === 'error') throw new Error('备用音频加载失败');
          if (element.readyState < 3) return;
          cleanup(); resolve();
        } catch (error) { cleanup(); reject(error); }
      }
      for (const name of ['canplay','error']) element.addEventListener(name, check);
      timer = setTimeout(() => { cleanup(); reject(new Error('音频准备超时')); }, timeout);
      guardTimer = setInterval(() => check(), 200);
      check();
    });
  }
  class Engine {
    constructor(elements, Context, onRelease = () => {}) {
      this.elements = elements; this.Context = Context; this.onRelease = onRelease;
      this.context = null; this.nodes = new Map(); this.settings = normalize({});
      this.volume = 0.8; this.muted = false; this.tail = null; this.tailTimer = null;
    }
    async resume() {
      if (!this.Context) return false;
      clearTimeout(this.idleTimer);
      // A pending suspend must settle before resume, otherwise it can silence a new play.
      await this.idleSuspend;
      if (!this.context) {
        const context = new this.Context();
        this.context = context;
        this.preamp = context.createGain(); this.master = context.createGain();
        // 0 dB threshold + hard knee gives unity makeup gain. Keep the node in
        // the graph even when bypassed, so toggles never change graph latency.
        this.peakGuard = context.createDynamicsCompressor();
        this.peakGuard.threshold.value = 0; this.peakGuard.knee.value = 0;
        this.peakGuard.ratio.value = 1; this.peakGuard.attack.value = 0;
        this.peakGuard.release.value = 0.08;
        // Drive/restore cancel at unity below the threshold; the 1 dB margin
        // only affects compressed peaks (native compression is not true-peak limiting).
        this.guardDrive = context.createGain(); this.guardRestore = context.createGain();
        this.guardDrive.gain.value = 10 ** (1 / 20); this.guardRestore.gain.value = 10 ** (-1 / 20);
        this.filters = frequencies.map(frequency => {
          const filter = context.createBiquadFilter(); filter.type = 'peaking';
          filter.frequency.value = Math.min(frequency, context.sampleRate * 0.49); filter.Q.value = Math.SQRT2;
          return filter;
        });
        let previous = this.preamp;
        for (const filter of this.filters) { previous.connect(filter); previous = filter; }
        previous.connect(this.master); this.master.connect(this.guardDrive);
        this.guardDrive.connect(this.peakGuard); this.peakGuard.connect(this.guardRestore);
        this.guardRestore.connect(context.destination);
        for (const element of this.elements) {
          const source = context.createMediaElementSource(element), gain = context.createGain();
          gain.gain.value = 1; source.connect(gain); gain.connect(this.preamp);
          this.nodes.set(element, gain); element.volume = 1; element.muted = false;
        }
        this.apply(this.settings); this.setVolume(this.volume, this.muted);
      }
      if (this.context.state !== 'running') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('音频输出暂未就绪，请再次点击播放');
      clearTimeout(this.idleTimer);
      return true;
    }
    hasPlayback() {
      return this.elements.some(element => !element.paused && !element.ended)
        || Boolean(this.tail || this.releasingTail)
        || Boolean(this.externalActive ? this.externalActive() : this.externalMix || this.metronomeMix);
    }
    scheduleIdle(delay = 2000) {
      clearTimeout(this.idleTimer);
      const context = this.context;
      if (!context || context.state !== 'running' || this.hasPlayback()) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.context !== context || context.state !== 'running' || this.hasPlayback()) return;
        this.idleSuspend = context.suspend().catch(() => {}).finally(() => { this.idleSuspend = null; });
      }, delay);
    }
    smooth(param, value, seconds = 0.035) {
      const now = this.context.currentTime;
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now);
      else {
        let current = param.value;
        if (this.fadeState) {
          const progress = Math.max(0, Math.min(1, (now - this.fadeState.start) / this.fadeState.duration));
          if (this.nodes.get(this.fadeState.outgoing)?.gain === param) current = Math.cos(progress * Math.PI / 2);
          if (this.nodes.get(this.fadeState.incoming)?.gain === param) current = Math.sin(progress * Math.PI / 2);
        }
        param.cancelScheduledValues(now); param.setValueAtTime(current, now);
      }
      param.setTargetAtTime(value, now, seconds / 3);
    }
    apply(raw) {
      this.settings = normalize(raw);
      if (!this.context) return;
      const cfg = this.settings;
      // autoHeadroom is the persisted legacy key: now protect actual output
      // peaks, without subtracting predicted EQ boosts or a permanent fade reserve.
      this.updatePeakProtection();
      this.smooth(this.preamp.gain, cfg.enabled ? 10 ** (cfg.preamp / 20) : 1);
      this.filters.forEach((filter, i) => this.smooth(filter.gain, cfg.enabled ? cfg.gains[i] : 0));
    }
    updatePeakProtection() {
      if (!this.context) return;
      // A switch alone must not compress a flat signal. Protect only boosted EQ
      // or a real two-track overlap; retain the node to keep graph latency stable.
      const cfg = this.settings;
      const boosted = cfg.enabled && cfg.autoHeadroom && cfg.gains.some(value => value > 0);
      this.smooth(this.peakGuard.ratio, boosted || this.externalMix || this.metronomeMix || Boolean(this.tail || this.releasingTail) ? 20 : 1);
      this.scheduleIdle();
    }
    setVolume(volume, muted) {
      this.volume = clamp(volume, 0, 1, 0.8); this.muted = Boolean(muted);
      if (this.context) this.smooth(this.master.gain, this.muted ? 0 : this.volume);
      else for (const element of this.elements) { element.volume = this.volume; element.muted = this.muted; }
    }
    disable() {
      this.dispose(); this.context = null; this.nodes.clear(); this.Context = null; this.tail = null;
    }
    gain(element, value) {
      const node = this.nodes.get(element);
      if (!node) return;
      node.gain.cancelScheduledValues(this.context.currentTime);
      node.gain.setValueAtTime(value, this.context.currentTime);
    }
    release(element) {
      element.pause(); element.removeAttribute('src'); element.load();
      this.gain(element, 0); this.onRelease(element);
    }
    holdTail(incoming) {
      if (!this.tail || !this.context) return false;
      this.held = true;
      clearTimeout(this.tailTimer);
      this.smooth(this.nodes.get(this.tail).gain, 1);
      this.smooth(this.nodes.get(incoming).gain, 0);
      const old = this.tail;
      const left = Math.max(0.1, Math.min(8, (Number(old.duration) - Number(old.currentTime)) / (old.playbackRate || 1) || 1));
      this.tailTimer = setTimeout(() => this.stopTail(incoming), left * 1000);
      return true;
    }
    continueFade(incoming) {
      if (!this.held || !this.tail) return;
      const old = this.tail;
      const left = (Number(old.duration) - Number(old.currentTime)) / (old.playbackRate || 1);
      if (old.ended || left <= 0.05) this.stopTail(incoming);
      else this.fade(old, incoming, Math.min(this.settings.seconds, left));
    }
    stopTail(active, fast = false) {
      this.held = false;
      clearTimeout(this.tailTimer);
      if (this.releasingTail && this.releasingTail !== active) this.release(this.releasingTail);
      this.releasingTail = null;
      const tail = this.tail; this.tail = null;
      if (tail && tail !== active) {
        const node = this.nodes.get(tail);
        if (fast && node) {
          this.smooth(node.gain, 0, 0.06);
          this.releasingTail = tail;
          this.tailTimer = setTimeout(() => { this.releasingTail = null; this.release(tail); this.updatePeakProtection(); }, 90);
        } else this.release(tail);
      }
      if (active && this.nodes.has(active)) this.smooth(this.nodes.get(active).gain, 1);
      this.fadeState = null;
      this.updatePeakProtection();
    }
    fade(outgoing, incoming, seconds) {
      if (this.tail === outgoing) this.tail = null;
      this.stopTail(null);
      const duration = clamp(seconds, 0.05, 8, 3), now = this.context.currentTime;
      const curves = [new Float32Array(128), new Float32Array(128)];
      for (let i = 0; i < 128; i++) { const t = i / 127; curves[0][i] = Math.cos(t * Math.PI / 2); curves[1][i] = Math.sin(t * Math.PI / 2); }
      for (const [i, element] of [outgoing, incoming].entries()) {
        const param = this.nodes.get(element).gain;
        param.cancelScheduledValues(now); param.setValueCurveAtTime(curves[i], now, duration);
      }
      this.fadeState = { outgoing, incoming, start: now, duration };
      this.tail = outgoing;
      this.updatePeakProtection();
      this.tailTimer = setTimeout(() => { if (this.tail === outgoing) { this.tail = null; this.release(outgoing); this.updatePeakProtection(); } }, duration * 1000 + 50);
    }
    dispose() { clearTimeout(this.idleTimer); clearTimeout(this.tailTimer); for (const element of this.elements) this.release(element); this.context?.close().catch(() => {}); }
  }
  return { frequencies, presets, normalize, waitReady, Engine };
});
