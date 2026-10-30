(function initOverlay() {
  const el = {
    root: document.getElementById("overlay"),
    content: document.querySelector(".overlay-content"),
    meta: document.getElementById("meta"),
    currentMain: document.getElementById("current-main"),
    currentSub: document.getElementById("current-sub"),
    nextMain: document.getElementById("next-main"),
    nextSub: document.getElementById("next-sub"),
    btnLock: document.getElementById("btn-lock"),
    btnFont: document.getElementById("btn-font"),
    btnOpacity: document.getElementById("btn-opacity"),
    btnCurrentOnly: document.getElementById("btn-current-only"),
  };

  const state = {
    locked: false,
    fontSize: 42,
    opacity: 0.86,
    currentOnly: false,
    mainFontSize: 42,
    subFontSize: 24,
    fontFamily: "Microsoft YaHei UI",
    strokeStrength: 0.55,
    activeColor: "#1f5f80",
    inactiveColor: "#5b6770",
    metaColor: "#6f8592",
    switchScrollMs: 300,
    title: "",
    artist: "",
    playbackIndex: -1,
    currentTime: 0,
    playing: false,
    playbackRate: 1,
    lyricHasTimeline: false,
    lyricKaraoke: false,
    karaokeWordIndex: -1,
    karaokeWordProgress: 0,
    focusNext: false,
    current: { main: "", sub: "", words: [], time: NaN, nextLineTime: NaN },
    next: { main: "", sub: "", words: [], time: NaN },
  };

  const renderState = {
    currentSignature: "",
    nextSignature: "",
    currentOnly: false,
    displayedCurrentMain: "",
    displayedCurrentSub: "",
  };

  const karaokeState = {
    rafId: 0,
    baseTime: 0,
    baseAt: 0,
    activeWordEl: null,
    activeWordIndex: -1,
    classWordIndex: -2,
    wordEls: [],
    renderedProgress: -1,
  };

  function clamp(num, min, max) {
    return Math.max(min, Math.min(max, num));
  }

  function quoteFontFamily(fontFamily) {
    return String(fontFamily || "Microsoft YaHei UI")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => `"${item.replace(/["\\]/g, "")}"`)
      .join(", ") || "\"Microsoft YaHei UI\"";
  }

  function normalizeWords(words) {
    if (!Array.isArray(words)) return [];
    return words.map((word) => ({
      time: Number(word?.time) || 0,
      endTime: word?.endTime !== null && word?.endTime !== undefined && Number.isFinite(Number(word.endTime))
        ? Number(word.endTime)
        : null,
      text: String(word?.text || ""),
    }));
  }

  function normalizeLine(line, nextLineTime) {
    return {
      time: Number(line?.time) || 0,
      endTime: line?.endTime !== null && line?.endTime !== undefined && Number.isFinite(Number(line.endTime))
        ? Number(line.endTime)
        : null,
      main: String(line?.main || ""),
      sub: String(line?.sub || ""),
      words: normalizeWords(line?.words),
      nextLineTime: Number.isFinite(Number(nextLineTime)) ? Number(nextLineTime) : NaN,
    };
  }

  function getLineSignature(line) {
    const words = Array.isArray(line?.words)
      ? line.words.map((word) => `${Number(word?.time || 0).toFixed(3)}-${word?.endTime !== null && word?.endTime !== undefined && Number.isFinite(Number(word.endTime)) ? Number(word.endTime).toFixed(3) : "nan"}:${String(word?.text || "")}`).join("|")
      : "";
    const lineTime = Number(line?.time || 0).toFixed(3);
    const nextLineTime = Number.isFinite(Number(line?.nextLineTime)) ? Number(line.nextLineTime).toFixed(3) : "nan";
    return `${lineTime}__${nextLineTime}__${String(line?.main || "")}__${String(line?.sub || "")}__${words}`;
  }

  function shouldUseKaraokeLine(line) {
    return !!(state.lyricHasTimeline && state.lyricKaraoke && Array.isArray(line?.words) && line.words.length);
  }

  function setWordClasses(wordIndex) {
    if (karaokeState.classWordIndex === wordIndex) return;
    const wordEls = karaokeState.wordEls.length ? karaokeState.wordEls : Array.from(el.currentMain.querySelectorAll(".ov-word"));
    karaokeState.wordEls = wordEls;
    wordEls.forEach((wordEl, index) => {
      wordEl.classList.toggle("done", wordIndex >= 0 && index < wordIndex);
      wordEl.classList.toggle("current", index === wordIndex);
      wordEl.classList.toggle("pending", wordIndex < 0 || index > wordIndex);
    });
    karaokeState.classWordIndex = wordIndex;
  }

  function resetActiveWord(options = {}) {
    const { preserveVisual = false, finalProgress = null } = options || {};
    if (karaokeState.activeWordEl) {
      if (preserveVisual) {
        const progress = Number.isFinite(finalProgress) ? finalProgress : karaokeState.renderedProgress;
        if (Number.isFinite(progress) && progress >= 0) {
          const percent = `${Math.round(clamp(progress, 0, 1) * 1000) / 10}%`;
          karaokeState.activeWordEl.style.setProperty("--word-progress", percent);
        }
      } else {
        karaokeState.activeWordEl.style.removeProperty("--word-progress");
      }
    }
    karaokeState.activeWordEl = null;
    karaokeState.activeWordIndex = -1;
    karaokeState.classWordIndex = -2;
    karaokeState.renderedProgress = -1;
  }

  function getCurrentWordElement(wordIndex) {
    if (!Number.isFinite(wordIndex) || wordIndex < 0) return null;
    if (karaokeState.activeWordEl && karaokeState.activeWordIndex === wordIndex) {
      return karaokeState.activeWordEl;
    }
    const wordEl = el.currentMain.querySelector(`.ov-word[data-word-idx="${wordIndex}"]`);
    karaokeState.activeWordEl = wordEl || null;
    karaokeState.activeWordIndex = wordIndex;
    return karaokeState.activeWordEl;
  }

  function applyWordProgress(progress) {
    const wordEl = getCurrentWordElement(karaokeState.activeWordIndex);
    if (!wordEl) return;
    const clamped = clamp(Number(progress) || 0, 0, 1);
    if (karaokeState.renderedProgress >= 0 && Math.abs(karaokeState.renderedProgress - clamped) < 0.003) return;
    wordEl.style.setProperty("--word-progress", `${Math.round(clamped * 1000) / 10}%`);
    karaokeState.renderedProgress = clamped;
  }

  function computeKaraokeState(line, currentTime) {
    return window.LyricTiming.wordState(line, currentTime, line?.nextLineTime);
  }

  function getAuthoritativeKaraokeState() {
    const wordIndex = Number.isFinite(Number(state.karaokeWordIndex))
      ? Math.max(-1, Math.floor(Number(state.karaokeWordIndex)))
      : -1;
    return {
      wordIndex,
      wordProgress: clamp(Number(state.karaokeWordProgress) || 0, 0, 1),
    };
  }

  function stabilizeKaraokeState(nextWordState) {
    const result = {
      wordIndex: Number.isFinite(Number(nextWordState?.wordIndex)) ? Number(nextWordState.wordIndex) : -1,
      wordProgress: clamp(Number(nextWordState?.wordProgress) || 0, 0, 1),
    };
    const authoritative = getAuthoritativeKaraokeState();
    if (authoritative.wordIndex < 0) return result;
    if (result.wordIndex < authoritative.wordIndex) {
      return authoritative;
    }
    if (result.wordIndex === authoritative.wordIndex) {
      result.wordProgress = Math.max(result.wordProgress, authoritative.wordProgress);
    }
    return result;
  }

  function updateKaraokeVisuals(currentTime) {
    if (!shouldUseKaraokeLine(state.current)) {
      setWordClasses(-1);
      resetActiveWord();
      return;
    }

    const nextWordState = stabilizeKaraokeState(computeKaraokeState(state.current, currentTime));
    setWordClasses(nextWordState.wordIndex);

    if (nextWordState.wordIndex < 0) {
      resetActiveWord();
      return;
    }

    const wordChanged = nextWordState.wordIndex !== karaokeState.activeWordIndex;
    if (wordChanged) {
      resetActiveWord({ preserveVisual: karaokeState.activeWordIndex >= 0, finalProgress: 1 });
      karaokeState.activeWordIndex = nextWordState.wordIndex;
    }

    karaokeState.activeWordEl = getCurrentWordElement(nextWordState.wordIndex);
    applyWordProgress(nextWordState.wordProgress);
  }

  function stopKaraokeTicker() {
    if (karaokeState.rafId) {
      cancelAnimationFrame(karaokeState.rafId);
      karaokeState.rafId = 0;
    }
  }

  function shouldRunKaraokeTicker() {
    return state.playing && shouldUseKaraokeLine(state.current);
  }

  function startKaraokeTicker() {
    if (!shouldRunKaraokeTicker()) {
      stopKaraokeTicker();
      return;
    }
    if (karaokeState.rafId) return;

    const tick = () => {
      karaokeState.rafId = 0;
      if (!shouldRunKaraokeTicker()) {
        stopKaraokeTicker();
        return;
      }
      const now = performance.now();
      const currentTime = window.LyricTiming.clockTime({ ...karaokeState, now, playing: state.playing, playbackRate: state.playbackRate });
      updateKaraokeVisuals(currentTime);
      karaokeState.rafId = requestAnimationFrame(tick);
    };

    karaokeState.rafId = requestAnimationFrame(tick);
  }

  function syncKaraokeClock(incomingTime) {
    const nextTime = Number(incomingTime || 0);
    state.currentTime = Math.max(0, nextTime);
    karaokeState.baseTime = state.currentTime;
    karaokeState.baseAt = performance.now();
  }

  function renderLineText(target, text) {
    target.textContent = String(text || "");
  }

  function renderCurrentMain() {
    if (!shouldUseKaraokeLine(state.current)) {
      renderLineText(el.currentMain, state.current?.main || "暂无歌词");
      return;
    }
    el.currentMain.textContent = "";
    const fragment = document.createDocumentFragment();
    const wordEls = [];
    state.current.words.forEach((word, index) => {
      const span = document.createElement("span");
      span.className = "ov-word pending";
      span.dataset.wordIdx = String(index);
      span.textContent = String(word?.text || "");
      fragment.appendChild(span);
      wordEls.push(span);
    });
    el.currentMain.appendChild(fragment);
    karaokeState.wordEls = wordEls;
    karaokeState.classWordIndex = -2;
  }

  function renderLyricContent(force = false) {
    const currentSignature = getLineSignature(state.current);
    const nextSignature = state.currentOnly ? "" : getLineSignature(state.next);
    const currentChanged = force || currentSignature !== renderState.currentSignature;
    const nextChanged = force || nextSignature !== renderState.nextSignature || state.currentOnly !== renderState.currentOnly;

    if (currentChanged) {
      resetActiveWord();
      renderCurrentMain();
      el.currentSub.textContent = state.current?.sub || "";
      renderState.currentSignature = currentSignature;
    }

    if (nextChanged) {
      renderLineText(el.nextMain, state.currentOnly ? "" : (state.next?.main || ""));
      el.nextSub.textContent = state.currentOnly ? "" : (state.next?.sub || "");
      renderState.nextSignature = nextSignature;
      renderState.currentOnly = !!state.currentOnly;
    }

    const displayedCurrentMain = shouldUseKaraokeLine(state.current) ? (state.current?.main || "") : el.currentMain.textContent;
    const displayedCurrentSub = el.currentSub.textContent;
    const currentDisplayChanged = currentChanged && (
      displayedCurrentMain !== renderState.displayedCurrentMain ||
      displayedCurrentSub !== renderState.displayedCurrentSub
    );

    if (currentDisplayChanged && el.content) {
      el.content.classList.remove("line-switch");
      void el.content.offsetWidth;
      el.content.classList.add("line-switch");
    }

    renderState.displayedCurrentMain = displayedCurrentMain;
    renderState.displayedCurrentSub = displayedCurrentSub;
    updateKaraokeVisuals(state.currentTime);
    startKaraokeTicker();
  }

  function renderShell() {
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--ov-font-size", `${clamp(Number(state.fontSize) || 42, 20, 72)}px`);
    rootStyle.setProperty("--ov-opacity", String(clamp(Number(state.opacity) || 0.86, 0.2, 1)));
    rootStyle.setProperty("--ov-active", state.activeColor || "#1f5f80");
    rootStyle.setProperty("--ov-inactive", state.inactiveColor || "#5b6770");
    rootStyle.setProperty("--ov-meta", state.metaColor || "#6f8592");
    rootStyle.setProperty("--ov-font-family", quoteFontFamily(state.fontFamily || "Microsoft YaHei UI"));
    rootStyle.setProperty("--ov-stroke-width", `${clamp(Number(state.strokeStrength) || 0, 0, 1.5)}px`);
    rootStyle.setProperty("--ov-switch-duration", `${clamp(Number(state.switchScrollMs) || 300, 120, 800)}ms`);

    el.currentMain.style.fontSize = `${clamp(Number(state.mainFontSize) || state.fontSize || 42, 16, 86)}px`;
    el.currentSub.style.fontSize = `${clamp(Number(state.subFontSize) || Math.round((state.mainFontSize || 42) * 0.56), 12, 72)}px`;
    el.nextMain.style.fontSize = `${clamp(Math.round((Number(state.subFontSize) || 24) * 0.92), 12, 66)}px`;
    el.nextSub.style.fontSize = `${clamp(Math.round((Number(state.subFontSize) || 24) * 0.78), 11, 54)}px`;

    el.meta.textContent = "";
    el.root.classList.toggle("locked", !!state.locked);
    el.root.classList.toggle("focus-next", !!(state.focusNext && !state.currentOnly));
    el.root.classList.toggle("line-highlight", !shouldUseKaraokeLine(state.current));
    el.btnLock.classList.toggle("active", !!state.locked);
    el.btnCurrentOnly.classList.toggle("active", !!state.currentOnly);
    el.btnLock.textContent = state.locked ? "已锁定" : "锁定";
  }

  function render(force = false) {
    renderShell();
    renderLyricContent(force);
  }

  function applySettings(settings) {
    if (!settings || typeof settings !== "object") return;
    if (Object.prototype.hasOwnProperty.call(settings, "locked")) state.locked = !!settings.locked;
    if (Object.prototype.hasOwnProperty.call(settings, "fontSize")) state.fontSize = Number(settings.fontSize) || state.fontSize;
    if (Object.prototype.hasOwnProperty.call(settings, "opacity")) state.opacity = Number(settings.opacity) || state.opacity;
    if (Object.prototype.hasOwnProperty.call(settings, "currentOnly")) state.currentOnly = !!settings.currentOnly;
    if (Object.prototype.hasOwnProperty.call(settings, "activeColor")) state.activeColor = settings.activeColor || state.activeColor;
    if (Object.prototype.hasOwnProperty.call(settings, "inactiveColor")) state.inactiveColor = settings.inactiveColor || state.inactiveColor;
    if (Object.prototype.hasOwnProperty.call(settings, "metaColor")) state.metaColor = settings.metaColor || state.metaColor;
    if (Object.prototype.hasOwnProperty.call(settings, "fontFamily")) state.fontFamily = String(settings.fontFamily || "").trim() || state.fontFamily;
    if (Object.prototype.hasOwnProperty.call(settings, "strokeStrength")) state.strokeStrength = clamp(Number(settings.strokeStrength) || 0, 0, 1.5);
    if (Object.prototype.hasOwnProperty.call(settings, "mainFontSize")) state.mainFontSize = Number(settings.mainFontSize) || state.mainFontSize;
    if (Object.prototype.hasOwnProperty.call(settings, "subFontSize")) state.subFontSize = Number(settings.subFontSize) || state.subFontSize;
    if (Object.prototype.hasOwnProperty.call(settings, "switchScrollMs")) state.switchScrollMs = Number(settings.switchScrollMs) || state.switchScrollMs;
    render(false);
  }

  function applyUpdate(update) {
    if (!update || typeof update !== "object") return;

    const previousPlaybackIndex = Number(state.playbackIndex);
    const nextPlaybackIndex = Number.isFinite(Number(update.playbackIndex)) ? Number(update.playbackIndex) : previousPlaybackIndex;

    const nextLine = normalizeLine(update.next || state.next, NaN);
    const currentLine = normalizeLine(update.current || state.current, nextLine.time);
    const currentSignature = getLineSignature(currentLine);
    const nextSignature = getLineSignature(nextLine);
    const contentChanged = currentSignature !== renderState.currentSignature || nextSignature !== renderState.nextSignature;

    state.current = currentLine;
    state.next = nextLine;
    state.title = update.title || "";
    state.artist = update.artist || "";
    state.playbackIndex = nextPlaybackIndex;
    state.lyricHasTimeline = !!update.lyricHasTimeline;
    state.lyricKaraoke = !!update.lyricKaraoke;
    state.playing = update.playing === true;
    state.playbackRate = Number.isFinite(Number(update.playbackRate)) && Number(update.playbackRate) > 0
      ? Number(update.playbackRate) : 1;
    state.karaokeWordIndex = Number.isFinite(Number(update.karaokeWordIndex))
      ? Math.max(-1, Math.floor(Number(update.karaokeWordIndex)))
      : -1;
    state.karaokeWordProgress = clamp(Number(update.karaokeWordProgress) || 0, 0, 1);
    state.focusNext = !!update.focusNext;

    syncKaraokeClock(update.currentTime);

    if (contentChanged) {
      render(false);
      return;
    }

    renderShell();
    updateKaraokeVisuals(state.currentTime);
    startKaraokeTicker();
  }

  el.btnLock.addEventListener("click", () => {
    window.lxOverlay?.emitAction?.("toggle-lock");
  });
  el.btnFont.addEventListener("click", () => {
    window.lxOverlay?.emitAction?.("cycle-font");
  });
  el.btnOpacity.addEventListener("click", () => {
    window.lxOverlay?.emitAction?.("cycle-opacity");
  });
  el.btnCurrentOnly.addEventListener("click", () => {
    window.lxOverlay?.emitAction?.("toggle-current-only");
  });

  window.addEventListener("beforeunload", () => {
    stopKaraokeTicker();
  });

  window.lxOverlay?.onSettings?.((settings) => applySettings(settings));
  window.lxOverlay?.onUpdate?.((payload) => applyUpdate(payload));
  window.lxOverlay?.onLock?.((payload) => applySettings(payload));

  render(true);
}());
