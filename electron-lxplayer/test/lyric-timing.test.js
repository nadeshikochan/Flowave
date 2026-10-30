const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { wordState, clockTime } = require("../renderer/lyric-timing");

test("shared karaoke timing preserves short syllables, silence, seek and zero duration", () => {
  const line = { endTime: 3, words: [
    { time: 1, endTime: 1.04, text: "a" },
    { time: 2, endTime: 2.1, text: "b" },
    { time: 2.5, endTime: 2.5, text: "c" },
  ] };
  assert.equal(wordState(line, 0.9).wordIndex, -1);
  assert.ok(Math.abs(wordState(line, 1.02).wordProgress - 0.5) < 1e-8);
  assert.equal(wordState(line, 1.5).wordProgress, 1);
  assert.equal(wordState(line, 2.5).wordProgress, 1);
  assert.equal(wordState(line, 2.8).wordIndex, 2);
  assert.equal(wordState(line, 1.01).wordIndex, 0);
  assert.equal(wordState({ endTime: 4, words: [{ time: 2, text: "line" }] }, 3).wordProgress, 0.5);
});

test("desktop clock follows rate, freezes on pause/buffering and bounds stale extrapolation", () => {
  const clock = { baseTime: 10, baseAt: 1000, now: 1100, playing: true };
  assert.equal(clockTime(clock), 10.1);
  assert.equal(clockTime({ ...clock, playbackRate: 2 }), 10.2);
  assert.equal(clockTime({ ...clock, playing: false }), 10);
  assert.equal(clockTime({ ...clock, now: 10000 }), 10.25);
  assert.equal(clockTime({ ...clock, baseTime: 9.9, now: 1000 }), 9.9);
});

test("desktop renderer applies short-word progress, a small backward seek and pause without stale animation", () => {
  class Element {
    constructor(fragment = false) {
      this.children = []; this.dataset = {}; this.fragment = fragment;
      this.style = { values: {}, setProperty(key, value) { this.values[key] = value; }, removeProperty(key) { delete this.values[key]; } };
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ""; }
    appendChild(child) { this.children.push(...(child.fragment ? child.children : [child])); }
    querySelectorAll() { return this.children; }
    querySelector(selector) { return this.children.find((child) => selector.includes(`"${child.dataset.wordIdx}"`)) || null; }
    addEventListener() {}
  }
  const elements = new Map();
  const getElement = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let now = 1000, nextFrame = 0, receive;
  const frames = new Map();
  const context = {
    document: { getElementById: getElement, querySelector: getElement, documentElement: getElement("html"),
      createElement: () => new Element(), createDocumentFragment: () => new Element(true) },
    window: { LyricTiming: require("../renderer/lyric-timing"), addEventListener() {},
      lxOverlay: { onUpdate(callback) { receive = callback; }, onSettings() {}, onLock() {} } },
    performance: { now: () => now },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/overlay.js"), "utf8"), context);
  const update = { playbackIndex: 0, currentTime: 1, playing: true, playbackRate: 1,
    lyricHasTimeline: true, lyricKaraoke: true, karaokeWordIndex: 0, karaokeWordProgress: 0,
    current: { time: 1, endTime: 1.04, main: "a", words: [{ time: 1, endTime: 1.04, text: "a" }] }, next: {} };
  receive(update);
  const advance = (time) => {
    now = time;
    const [id, callback] = frames.entries().next().value;
    frames.delete(id); callback(time);
  };
  advance(1020);
  const word = elements.get("current-main").children[0];
  assert.equal(word.style.values["--word-progress"], "50%");
  receive({ ...update, currentTime: 1.01, playing: false, karaokeWordProgress: 0.25 });
  assert.equal(word.style.values["--word-progress"], "25%");
  assert.equal(frames.size, 0);
  receive({ ...update, currentTime: 1.01, playbackRate: 2, karaokeWordProgress: 0.25 });
  advance(1030);
  assert.equal(word.style.values["--word-progress"], "75%");
});
