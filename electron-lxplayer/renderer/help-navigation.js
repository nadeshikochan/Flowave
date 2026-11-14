(function (root) {
  'use strict';
  let loading;
  const files = new Map();
  function resource(file, stylesheet = false) {
    if (files.has(file)) return files.get(file);
    const pending = new Promise((resolve, reject) => {
      const element = document.createElement(stylesheet ? 'link' : 'script');
      if (stylesheet) { element.rel = 'stylesheet'; element.href = file; }
      else element.src = file;
      element.onload = () => { element.onload = element.onerror = null; resolve(); };
      element.onerror = () => { element.remove(); reject(Error('手册文件无法载入，请重试。')); };
      document.head.appendChild(element);
    }).catch(error => { files.delete(file); throw error; });
    files.set(file, pending);
    return pending;
  }
  async function loadReader() {
    loading ||= Promise.all([resource('user-manual.css', true), resource('user-manual.js')]).then(() => {
      if (!root.FlowaveUserManual) throw Error('手册未能注册，请重新打开软件。');
      return root.FlowaveUserManual;
    }).catch(error => { loading = null; throw error; });
    let timer;
    // A timeout retains the one in-flight resource. Retrying waits for it,
    // preventing duplicate scripts if a delayed local read eventually completes.
    try { return await Promise.race([loading, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('手册载入超时，请重试。')), 15000);
    })]); }
    finally { clearTimeout(timer); }
  }
  const settingsTopics = {
    general: 'sound', 'library-settings': 'add-music', source: 'online', downloads: 'online',
    advanced: 'prepare-recommendation', recommendation: 'recommendation-controls',
    lyric: 'lyrics', 'desktop-lyric': 'desktop-lyrics', theme: 'appearance',
    shortcuts: 'shortcuts', features: 'packages', storage: 'workspace', logs: 'troubleshooting',
    manual: 'start', history: 'history', 'song-info': 'song-info',
  };
  const viewTopics = {library: 'library', online: 'online', seeds: 'seeds', 'sound-map': 'map',
    insights: 'filters', analysis: 'analysis', practice: 'practice'};
  root.FlowaveHelp = {
    state: () => ({helpTopic: 'start', helpTour: false, helpReturn: null, helpSaveBusy: false, helpSaveError: ''}),
    component: {
      inheritAttrs: false,
      data: () => ({reader: null, failure: '', disposed: false}),
      mounted() { this.load(); },
      beforeUnmount() { this.disposed = true; },
      methods: {
        async load() {
          this.failure = '';
          try {
            const reader = await loadReader();
            if (!this.disposed) this.reader = Vue.markRaw(reader);
          } catch (error) { if (!this.disposed) this.failure = error.message; }
        },
      },
      template: `<component v-if="reader" :is="reader" v-bind="$attrs" />
        <section v-else class="help-loading" aria-live="polite"><h1>使用手册</h1>
        <p>{{failure || '正在载入离线手册…'}}</p><button v-if="failure" class="mini" @click="load">重试</button></section>`,
    },
    methods: {
      openUserManual(topic = '', tour = false) {
        if (this.view !== 'help') this.helpReturn = {view: this.view, lyric: this.showLyric};
        if (this.audioDetail?.visible) this.closeAudioDetail();
        if (this.equalizerOpen) this.closeEqualizer();
        this.closeOnlineContextMenu();
        this.closePlaylistContextMenu();
        this.closeTrackContextMenu();
        this.showLyric = false;
        this.helpTopic = topic || this.helpTopic || 'start';
        this.helpTour = tour;
        this.helpSaveError = '';
        this.setView('help');
      },
      closeUserManual() {
        const target = this.helpReturn;
        this.setView(target?.view || 'library');
        if (target?.lyric) this.showLyric = true;
      },
      openContextHelp() {
        const topic = this.audioDetail?.visible ? 'audio-details' : this.equalizerOpen ? 'sound'
          : this.showLyric ? 'lyrics' : this.view === 'settings'
          ? settingsTopics[this.settingsTab] : viewTopics[this.view];
        this.openUserManual(topic || 'start');
      },
      navigateFromHelp(action) {
        if (action.page) this.openSettingsSection(action.page, action.anchor || '');
        else if (action.view) this.setView(action.view);
      },
      maybeOpenFirstUse() {
        if (!this.startupSplashVisible && this.firstUseStatus === 'pending' && !this.helpTour)
          this.openUserManual('start', true);
      },
      async finishFirstUse(status) {
        if (this.helpSaveBusy || !['completed', 'skipped'].includes(status)) return;
        this.helpSaveBusy = true;
        this.helpSaveError = '';
        try {
          const result = await root.lxEnv?.setRendererState?.('lx-first-use', status);
          if (!result?.ok) throw Error(result?.error || '引导状态未保存，请重试。');
          // Use the host's existing state writer. Only publish completion after it succeeds.
          this.firstUseStatus = status;
          this.helpTour = false;
          this.closeUserManual();
        } catch (error) { this.helpSaveError = error.message; }
        finally { this.helpSaveBusy = false; }
      },
      handleHelpKey(event) {
        if (event.key !== 'F1' || event.defaultPrevented || event.isComposing || event.repeat
          || event.ctrlKey || event.altKey || event.metaKey || this.confirmDialog?.visible
          || event.target?.closest?.('.shortcut-row input')) return false;
        event.preventDefault();
        if (this.view === 'help') return true;
        this.openContextHelp();
        return true;
      },
    },
  };
})(window);
