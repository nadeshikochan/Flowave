const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, Engine, waitReady } = require('../renderer/audio-effects');
class Param {
  constructor() { this.value = 1; this.events = []; }
  cancelScheduledValues() { this.events = []; }
  setValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  setValueCurveAtTime(curve, at, duration) { this.events.push({ curve, at, duration }); }
}
class Context {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'suspended'; this.sources = 0; }
  node() { return { connect() {}, gain: new Param(), frequency: new Param(), Q: new Param() }; }
  createGain() { return this.node(); }
  createBiquadFilter() { return this.node(); }
  createDynamicsCompressor() {
    return { connect() {}, threshold: new Param(), knee: new Param(), ratio: new Param(), attack: new Param(), release: new Param() };
  }
  createMediaElementSource() { this.sources++; return this.node(); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class Element extends EventTarget {
  constructor() { super(); this.readyState = 3; this.paused = false; }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
}
test('EQ config retains zero, clamps invalid values and disables unknown schema', () => {
  const cfg = normalize({ version: 1, enabled: true, gains: [0, 30, -30, Infinity], preamp: 0, seconds: NaN });
  assert.deepEqual(cfg.gains.slice(0,4), [0,12,-12,0]);
  assert.equal(cfg.preamp, 0); assert.equal(cfg.seconds, 3);
  assert.equal(normalize({ version: 99, enabled: true, crossfade: true }).enabled, false);
  assert.equal(normalize({ version: 99, enabled: true, crossfade: true }).crossfade, false);
});
test('two sources share one graph, equal-power curves and one volume; cancellation releases all tails', async () => {
  const a = new Element(), b = new Element(), engine = new Engine([a,b], Context);
  await engine.resume(); await engine.resume();
  assert.equal(engine.context.sources, 2);
  engine.apply({ enabled: true, gains: [6], crossfade: true });
  assert.equal(engine.preamp.gain.value, 1);
  assert.equal(engine.peakGuard.ratio.value, 20);
  engine.setVolume(0.4, true); assert.equal(engine.master.gain.value, 0);
  engine.setVolume(0.4, false); assert.equal(engine.master.gain.value, 0.4);
  engine.fade(a,b,1);
  const out = engine.nodes.get(a).gain.events[0].curve;
  const incoming = engine.nodes.get(b).gain.events[0].curve;
  assert.equal(out[0], 1); assert.equal(incoming[0], 0); assert.equal(incoming[127], 1);
  for (let i=0;i<128;i++) assert.ok(Math.abs(out[i]**2 + incoming[i]**2 - 1) < 0.000001);
  a.duration = 180; a.currentTime = 178; a.playbackRate = 1;
  assert.equal(engine.holdTail(b), true);
  engine.continueFade(b);
  assert.equal(a.paused, false);
  assert.equal(engine.nodes.get(b).gain.events[0].duration, 2);
  engine.stopTail(b,true);
  engine.stopTail(b); // repeated cancellation must release the timer-owned tail too
  assert.equal(a.paused, true); assert.equal(engine.tail, null);
  engine.dispose();
});

test('effects toggles preserve volume and only enable output peak protection', async () => {
  const engine = new Engine([new Element(),new Element()], Context);
  await engine.resume(); engine.setVolume(0.65, false);
  for (const cfg of [{}, {crossfade:true}, {enabled:true},
    {enabled:true,gains:[12,12,12,12,12,12,12,12,12,12]},
    {enabled:true,autoHeadroom:false}, {crossfade:true,autoHeadroom:false}]) {
    engine.apply(cfg);
    assert.equal(engine.master.gain.value, 0.65);
    assert.equal(engine.preamp.gain.value, 1);
    assert.equal(engine.peakGuard.threshold.value, 0);
    assert.equal(engine.peakGuard.knee.value, 0);
    assert.equal(engine.peakGuard.ratio.value, cfg.enabled && cfg.autoHeadroom !== false && cfg.gains?.some(value => value > 0) ? 20 : 1);
  }
  engine.apply({enabled:true,preamp:-6});
  assert.equal(engine.preamp.gain.value, 10 ** (-6/20));
  engine.apply({enabled:false,preamp:-6});
  assert.equal(engine.preamp.gain.value, 1);
  engine.apply({ crossfade: true });
  assert.equal(engine.peakGuard.ratio.value, 1);
  engine.fade(engine.elements[0], engine.elements[1], 1);
  assert.equal(engine.peakGuard.ratio.value, 20);
  engine.stopTail(engine.elements[1]);
  assert.equal(engine.peakGuard.ratio.value, 1);
  engine.dispose();
});
test('preload waits for canplay, accepts load emptied events, and rejects stale readiness', async () => {
  const element = new Element(); element.readyState = 0;
  const pending = waitReady(element, () => {}, 500);
  element.dispatchEvent(new Event('emptied'));
  element.readyState = 3; element.dispatchEvent(new Event('canplay'));
  await pending;
  await assert.rejects(waitReady(element, () => { throw Error('stale generation'); }), /stale/);
});
