(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RecommendationContext = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const clone = value => JSON.parse(JSON.stringify(value));
  const key = ref => String(ref?.resourceId || ref?.path || "");
  const unique = (rows, limit = 3) => {
    const seen = new Set();
    return [...rows].reverse().filter(ref => key(ref) && !seen.has(key(ref)) && seen.add(key(ref))).slice(0, limit).reverse();
  };
  const departing = state => unique([...(state.segment || []).filter(ref =>
    !state.blocked.some(item => key(item) === key(ref))), state.current].filter(Boolean), 64);
  function fresh(current, revision = 0) {
    return { version: 3, revision, current, origin: current, core: current ? [current] : [], qualified: 0,
      anchors: current ? [current] : [], recent: [], before: { anchors: current ? [current] : [], recent: [] },
      repair: null, blocked: [], negatives: [], memories: [], songs: 0, switches: 0,
      segment: current ? [current] : [], excluded: [], route: [], cooldown: current ? [current] : [],
      plays: current ? [current] : [], outcomes: [], accepted: 0 };
  }
  function ensure(value, current) {
    if (![2, 3].includes(value?.version) || key(value.current) !== key(current) || !Array.isArray(value.anchors)
        || !Array.isArray(value.recent) || !Array.isArray(value.blocked)) return fresh(current);
    const state = clone(value);
    state.segment ||= unique([...state.anchors, ...state.recent, current], 64);
    state.excluded ||= [];
    state.route ||= unique(state.segment.filter(ref => key(ref) !== key(current)
      && !state.blocked.some(blocked => key(blocked) === key(ref))), 3);
    if (state.version === 2 || ['core', 'negatives', 'memories', 'plays', 'outcomes'].some(name => !Array.isArray(state[name]))) {
      // Preserve frozen references; migration never manufactures listening evidence.
      Object.assign(state, { version: 3, origin: state.segment[0] || state.anchors[0] || current,
        core: state.anchors.slice(-3), qualified: 0, negatives: [], songs: 0, switches: 0,
        memories: state.excluded.length ? [{ refs: state.excluded.slice(-6), songs: 0, switches: 0 }] : [],
        plays: (state.cooldown || [current]).slice(-100), outcomes: [] });
    }
    return state;
  }
  function repair(value, current) {
    const state = ensure(value, current);
    const before = state.repair || state.before || { anchors: state.anchors, recent: state.recent };
    state.blocked = unique([...state.blocked, current], 64);
    const clean = rows => (rows || []).filter(ref => !state.blocked.some(item => key(item) === key(ref)));
    state.repair = { anchors: clean(before.anchors), recent: clean(before.recent) };
    const positive = unique([...state.core, state.origin, ...state.repair.anchors, ...state.repair.recent].filter(Boolean), 8);
    state.negatives = [...state.negatives.filter(n => key(n.track) !== key(current)),
      { track: current, positive: clean(positive) }].slice(-16);
    for (const name of ['anchors', 'recent', 'route', 'core']) state[name] = clean(state[name]);
    if (key(state.origin) === key(current)) state.origin = null;
    state.before = clone(state.repair);
    state.revision++;
    return state;
  }
  function qualified(previous) {
    const duration = Number(previous.duration) || 0, listened = Number(previous.listenedSeconds) || 0;
    const media = Number(previous.creditedMediaSeconds);
    return listened >= 10 && (listened >= 60 || duration > 0 && Number.isFinite(media) && media >= duration * .5);
  }
  function commit(value, target, source, previous = {}) {
    const old = ensure(value, previous.reference || value?.current);
    const accepted = qualified(previous) && !previous.rejected && key(previous.reference)
      && !old.blocked.some(ref => key(ref) === key(previous.reference));
    const songs = old.songs + (qualified(previous) ? 1 : 0);
    const cooldown = [...(old.cooldown || [old.current]), target].filter(Boolean).slice(-20);
    const repeated = (old.plays || []).some(ref => key(ref) === key(target)) || !!previous.targetPreviouslyPlayed;
    const plays = [...(old.plays || []), target].slice(-100);
    const outcomes = [...old.outcomes, { ref: target, repeated,
      automatic: ['like_next', 'dislike_next', 'next', 'ended_fallback'].includes(source) }].slice(-20);
    const shared = { cooldown, plays, outcomes, songs, switches: old.switches, memories: old.memories };
    if (!["like_next", "dislike_next", "next", "ended_fallback"].includes(source)) {
      return { ...fresh(target, old.revision + 1), ...shared, memories: [] };
    }
    if ((source === "dislike_next" || previous.resetDirection) && key(target) !== key(old.current)) {
      const others = unique([...old.core, ...old.recent, ...old.route, old.current].filter(ref => ref && key(ref) !== key(old.origin)), 5);
      const refs = old.origin ? [old.origin, ...others] : others;
      const switches = old.switches + 1;
      const memories = [...old.memories, { refs, songs, switches }]
        .filter(m => switches - m.switches < 10 && songs - m.songs < 100).slice(-10);
      return { ...fresh(target, old.revision + 1), ...shared, switches, memories,
        excluded: departing(old) };
    }
    if (accepted) {
      old.recent = unique([...old.recent, previous.reference]);
      old.qualified++;
      old.accepted++;
      if (old.repair || old.accepted >= 2) {
        old.anchors = unique([...old.anchors, previous.reference]);
        old.accepted = 0;
      }
      // Slow exemplars update only from real continued listening, not recommended ancestry.
      if (old.qualified % 4 === 0) old.core = unique([...old.core, previous.reference]);
      old.repair = null;
    }
    if (key(previous.reference) && !previous.rejected
        && !old.blocked.some(ref => key(ref) === key(previous.reference))) old.route = unique([...old.route, previous.reference]);
    old.before = clone(old.repair || { anchors: old.route.length ? old.route : old.anchors, recent: old.recent });
    old.segment = unique([...old.segment, target], 64);
    Object.assign(old, shared, { current: target, revision: old.revision + 1 });
    old.memories = old.memories.filter(m => songs - m.songs < 100 && old.switches - m.switches < 10);
    return old;
  }
  function request(value, current, intent) {
    const state = ensure(value, current);
    const clean = rows => (rows || []).filter(ref => !state.blocked.some(item => key(item) === key(ref)));
    const basis = intent === "change" ? { anchors: departing(state), recent: [] }
      : intent === "recover" ? state.repair || state.before
      : state.repair || { anchors: state.route.length ? state.route : state.anchors, recent: state.recent };
    return { anchors: unique(intent === 'change' ? basis.anchors : clean(basis?.anchors), intent === 'change' ? 64 : 8),
      excluded: intent === 'change' || state.qualified >= 2 ? [] : state.excluded,
      recent: unique(clean(basis?.recent)), blocked: state.blocked, cooldown: state.cooldown,
      direction: intent === 'change' ? [] : unique(clean([...state.core, state.origin].filter(Boolean)), 4),
      directionStrength: .22 / (1 + state.qualified / 12), negatives: intent === 'change' ? [] : state.negatives,
      memories: state.memories.map(m => ({ refs: m.refs,
        strength: Math.max(0, 1 - Math.max((state.switches - m.switches) / 10, (state.songs - m.songs) / 100)) ** 2 })),
      plays: state.plays, outcomes: state.outcomes, revision: state.revision };
  }
  return { fresh, ensure, repair, commit, request, key };
});
