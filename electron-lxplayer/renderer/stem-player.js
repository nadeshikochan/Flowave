(function (root) {
  'use strict';
  const LABELS = { vocals: '人声', drums: '鼓', bass: '贝斯', guitar: '吉他', piano: '钢琴', other: '其他伴奏' };
  const MEMORY_LIMIT = 768 * 1024 * 1024;
  const IDLE_CACHE_MS = 45000;
  const stretchUrl=typeof document==='undefined'?'':new URL('vendor/soundtouch-processor-2.1.1.js',document.currentScript?.src||location.href).href;
  const stretchContexts=new WeakMap();
  async function prepareStretch(context){
    if(!context.audioWorklet)throw new Error('当前设备不支持保调变速。');
    if(!stretchContexts.has(context))stretchContexts.set(context,context.audioWorklet.addModule(stretchUrl).catch(error=>{stretchContexts.delete(context);throw error}));
    await stretchContexts.get(context);
  }
  let decodedCache = null, cacheTimer = null, cacheEpoch = 0;
  let decodeTail = Promise.resolve();
  function clearCache() {
    clearTimeout(cacheTimer); cacheTimer = null; decodedCache = null; cacheEpoch++;
  }
  function pin(buffers) {
    if (decodedCache?.buffers !== buffers) return;
    clearTimeout(cacheTimer); cacheTimer = null;
  }
  function release(buffers, keep = true) {
    if (decodedCache?.buffers !== buffers) return;
    if (!keep) { clearCache(); return; }
    clearTimeout(cacheTimer); cacheTimer = setTimeout(clearCache, IDLE_CACHE_MS);
  }
  // Audio-like adapter: one clock, one set of playback events, no hidden reference player.
  class StemPlayer extends EventTarget {
    constructor(context, destination, buffers, detail, src, mix) {
      super(); this.context = context; this.buffers = buffers; this.src = src; this.currentSrc = src;
      this.duration = Math.min(detail.samples / detail.sample_rate, ...Object.values(buffers).map(b => b.duration));
      this.readyState = 4; this.networkState = 1; this.error = null; this.seeking = false;
      this.paused = true; this.ended = false; this.offset = 0; this.rate = 1; this.sources = [];
      this.loop = true;
      this.gains = {}; this.mix = {}; this.solo = ''; this.volume = 1; this.muted = false;
      this.bus = context.createGain(); this.bus.connect(destination);
      this.bus.gain.value = 1 / (Number(detail.common_gain) || 1);
      for (const name of Object.keys(buffers)) {
        this.gains[name] = context.createGain(); this.gains[name].connect(this.bus);
      }
      this.setMix(mix); this.disposed = false;
    }
    event(name) { this.dispatchEvent(new Event(name)); }
    getAttribute(name) { return name === 'src' ? this.src : null; }
    get currentTime() {
      let at=this.offset+(this.paused?0:Math.max(0,this.context.currentTime-this.started)*this.rate);
      const r=this.practiceRegion;if(r&&at>=r.end)at=r.start+(at-r.end)%(r.end-r.start);
      return Math.min(this.duration,at);
    }
    setPracticeRegion(region){
      const at=this.currentTime,playing=!this.paused;this.stopNodes();this.offset=at;this.practiceRegion=region;this.practiceCycle=0;
      if(playing)this.schedule();
      this.event('ratechange');
    }
    set currentTime(value) {
      if (!Number.isFinite(Number(value))) return;
      const playing = !this.paused;
      this.seeking = true; this.event('seeking'); this.stopNodes();
      this.offset = Math.min(this.duration, Math.max(0, Number(value))); this.ended = false;
      if (playing) this.schedule();
      this.seeking = false; this.event('seeked'); this.event('timeupdate');
    }
    get playbackRate() { return this.rate; }
    set playbackRate(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 4) return;
      if(rate===this.rate)return;
      if(rate!==1&&!stretchContexts.has(this.context))throw new Error('请先准备保调变速。');
      const at = this.currentTime; const playing = !this.paused;
      this.stopNodes(); this.offset = at; this.rate = rate;
      if (playing) this.schedule();
      this.event('ratechange');
    }
    stopNodes() {
      clearInterval(this.timer); this.timer = null;
      for (const node of this.sources) { try { node.stop(); } catch {} node.disconnect(); }
      this.sources = [];
      if(this.stretch){this.stretch.port.postMessage('dispose');this.stretch.port.close();this.stretch.disconnect();this.stretch=null;}
      this.stretchInput?.disconnect();this.stretchInput=null;this.stretchWaiting=false;
    }
    setupGraph(begin) {
      this.started=begin;this.practiceCycle=0;let destination=null;
      if(this.rate!==1){
        if(!stretchContexts.has(this.context))throw new Error('请先准备保调变速。');
        this.stretchWaiting=true;this.started=Infinity;
        const node=this.stretch=new AudioWorkletNode(this.context,'flowave-stretch',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{startFrame:Math.round(begin*this.context.sampleRate)}});
        node.parameters.get('playbackRate').value=this.rate;node.parameters.get('pitch').value=1;
        this.stretchInput=this.context.createGain();this.stretchInput.connect(node);node.connect(this.bus);
        node.port.onmessage=e=>{if(this.stretch!==node||e.data?.type!=='ready')return;this.started=e.data.time;this.stretchWaiting=false;this.event('playing')};
        node.onprocessorerror=()=>{if(this.stretch!==node)return;this.pause();this.error={message:'保调变速发生错误，请切回原速后重试。'};this.event('error')};
        destination=this.stretchInput;
      }
      for(const gain of Object.values(this.gains)){gain.disconnect();gain.connect(destination||this.bus)}
    }
    schedule() {
      this.lastProgress=this.context.currentTime;
      const begin=Math.ceil((this.context.currentTime+.03)*this.context.sampleRate/128)*128/this.context.sampleRate;
      this.setupGraph(begin);
      for (const [name, buffer] of Object.entries(this.buffers)) {
        const node = this.context.createBufferSource(); node.buffer = buffer;
        node.playbackRate.value = this.rate; node.connect(this.gains[name]);
        const r=this.practiceRegion;if(r){node.loop=true;node.loopStart=r.start;node.loopEnd=r.end;}
        node.start(begin, Math.min(this.offset, this.duration)); this.sources.push(node);
      }
      this.timer = setInterval(() => {
        const r=this.practiceRegion;
        if(r&&!this.stretchWaiting){const raw=this.offset+Math.max(0,this.context.currentTime-this.started)*this.rate;const cycle=raw>=r.end?1+Math.floor((raw-r.end)/(r.end-r.start)):0;if(cycle!==this.practiceCycle){this.practiceCycle=cycle;this.event('practicecycle')}this.progress();return;}
        if (this.currentTime >= this.duration) {
          if (this.loop) { this.stopNodes(); this.offset = 0; this.schedule(); this.event('timeupdate'); return; }
          this.stopNodes(); this.offset = this.duration; this.paused = true; this.ended = true;
          this.event('timeupdate'); this.event('ended');
        } else this.progress();
      }, 20);
    }
    progress(){if(this.context.currentTime-this.lastProgress>=.1){this.lastProgress=this.context.currentTime;this.event('timeupdate')}}
    async play() {
      if (this.disposed) throw new Error('伴奏已释放，请重新载入。');
      await this.context.resume();
      if (this.disposed) throw new Error('伴奏载入已取消。');
      if (!this.paused) return;
      if (this.offset >= this.duration) this.offset = 0;
      this.paused = false; this.ended = false; this.error=null; await this.schedule();
      if(this.error)throw new Error(this.error.message);
      if(this.disposed||this.paused)return;
      this.event('play'); if(!this.stretchWaiting)this.event('playing');
    }
    pause() {
      if (this.paused) return;
      this.offset = this.currentTime; this.paused = true; this.stopNodes(); this.event('pause');
    }
    setMix(value, solo = this.solo) {
      this.mix = value || {}; this.solo = solo;
      for (const [name, node] of Object.entries(this.gains)) {
        const item = this.mix[name] || { volume: 100 };
        const volume = Math.max(0, Math.min(100, Number(item.volume) || 0)) / 100;
        const gain = item.muted || (solo && solo !== name) ? 0 : volume;
        node.gain.cancelScheduledValues(this.context.currentTime);
        node.gain.setTargetAtTime(gain, this.context.currentTime, .012);
      }
    }
    dispose() {
      this.disposed = true; this.stopNodes(); this.paused = true; this.buffers = {};
      Object.values(this.gains).forEach(n => n.disconnect()); this.gains = {}; this.bus.disconnect();
    }
  }
  function decode(...args) {
    // A cancelled native decoder can still be finishing in the browser. Queue
    // the next attempt behind its cleanup rather than doubling peak PCM memory.
    const task = decodeTail.then(() => decodeNow(...args));
    decodeTail = task.then(() => {}, () => {});
    return task;
  }
  async function decodeNow(context, base, detail, signal, progress, offset = 0) {
    const names = Object.keys(detail.stems);
    signal.throwIfAborted();
    const key = JSON.stringify([base, detail.id, detail.generation, detail.source, detail.recipe,
      context.sampleRate, detail.sample_rate, detail.samples,
      names.map(name => [name, detail.stems[name].sha256, detail.stems[name].bytes])]);
    if (decodedCache?.key === key) {
      progress(names.length, names.length);
      return decodedCache.buffers;
    }
    // Context sample rate may differ from the 48 kHz files; include transient decode overhead.
    const budget = detail.duration * context.sampleRate * 2 * 4 * (names.length + 1);
    if (!Number.isFinite(budget)) throw new Error('音轨时长无效，请重新准备。');
    if (budget > MEMORY_LIMIT) {
      clearCache();
      const pages = new root.FlowaveStemPages(context, base, detail);
      const abort=()=>pages.close();signal.addEventListener('abort',abort,{once:true});
      try {
        await pages.get(Math.floor(Math.max(0,Math.min(offset,detail.duration-.001))/pages.seconds));
        signal.throwIfAborted();progress(names.length,names.length);
        const buffers=Object.fromEntries(names.map(name=>[name,{duration:detail.samples/detail.sample_rate}]));
        Object.defineProperty(buffers,'pages',{value:pages});return buffers;
      } catch(error){pages.close();throw error}
      finally{signal.removeEventListener('abort',abort)}
    }
    clearCache(); const epoch = cacheEpoch;
    const buffers = {}, pending = new Set(), controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const estimatedTrackBytes = Math.ceil(detail.duration * context.sampleRate) * 2 * 4;
    let total = 0, index = 0, failure = null;
    async function load(name) {
      const url = base + '/stems/audio/' + encodeURIComponent(detail.id) + '/' + encodeURIComponent(detail.generation) + '/' + name;
      const response = await fetch(url, { signal: controller.signal, headers: window.FlowaveBackendAccess?.headers(url) });
      if (!response.ok) throw new Error('分轨无法读取，请刷新结果或重新分离。');
      const encoded = await response.arrayBuffer();
      controller.signal.throwIfAborted();
      const buffer = await context.decodeAudioData(encoded);
      controller.signal.throwIfAborted();
      if (buffer.numberOfChannels !== 2 || Math.abs(buffer.duration - detail.samples / detail.sample_rate) > .002) throw new Error('音轨时轴不一致，已停止载入。');
      total += buffer.length * buffer.numberOfChannels * 4;
      if (total > MEMORY_LIMIT) throw new Error('分轨解码超过内存预算，已停止载入。');
      buffers[name] = buffer; progress(Object.keys(buffers).length, names.length);
    }
    try {
      while (index < names.length || pending.size) {
        controller.signal.throwIfAborted();
        // At most two decoders. Reserve output plus one scratch buffer per active
        // decoder; near the memory ceiling, finish the remaining stems sequentially.
        while (index < names.length && pending.size < 2
          && total + (pending.size + 1) * estimatedTrackBytes * 2 <= MEMORY_LIMIT) {
          const name = names[index++];
          const task = load(name).catch(error => {
            if (!failure) failure = error;
            controller.abort(error);
          }).finally(() => pending.delete(task));
          pending.add(task);
        }
        if (!pending.size) throw new Error('分轨解码超过内存预算，已停止载入。');
        await Promise.race(pending);
        if (failure) throw failure;
      }
      signal.throwIfAborted();
      if (epoch !== cacheEpoch) throw new DOMException('伴奏载入已取消。', 'AbortError');
      decodedCache = { key, buffers }; release(buffers);
      return buffers;
    } catch (error) {
      controller.abort(error);
      // Native decoding cannot be interrupted: drain these two jobs before a
      // cancelled attempt releases its buffers or permits another full-song load.
      await Promise.allSettled([...pending]);
      for (const name of Object.keys(buffers)) delete buffers[name];
      throw failure || error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  root.FlowaveStemPlayer = { StemPlayer, prepareStretch, decode, pin, release, clearCache, LABELS, MEMORY_LIMIT, IDLE_CACHE_MS };
})(window);
