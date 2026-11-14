(function(root) {
  'use strict';
  const modules = root.FlowaveFeatureModules;
  if (modules && !modules.enabled('recommendation') && !modules.enabled('analysis')) return;

  const {shallowReactive, markRaw} = root.Vue;
  const store = shallowReactive({
    rows: markRaw([]),
    task: {state: 'idle'},
    revision: 0,
    loaded: false,
    base: '',
    structure: {available: false, message: '正在确认段落分析组件。'},
  });
  let pending = null;
  let catalogGeneration = 0;

  async function catalog(base, force = false) {
    if (!force && pending && store.base === base) return pending;
    const generation = ++catalogGeneration;
    store.base = base;
    const endpoint = modules?.enabled('analysis') !== false ? '/analysis/catalog' : '/index/features';
    const request = root.axios.get(base + endpoint).then(({data}) => {
      if (store.base !== base || generation !== catalogGeneration) return;
      store.rows = markRaw(data.rows || []);
      store.task = data.task || {};
      store.structure = data.structure || {available: false, message: '段落分析组件尚未准备完整。'};
      store.loaded = true;
      store.revision++;
    });
    pending = request;
    try {
      await request;
    } finally {
      if (pending === request) pending = null;
    }
  }

  root.FlowaveAnalysisData = {store, catalog};
})(window);
