(function (root) {
  'use strict';
  const labels = root.FlowaveStemPlayer.LABELS;
  const message = error => error?.response?.data?.detail || error?.message || '操作未完成，请重试。';
  let saveChain = Promise.resolve();
  root.FlowavePractice = {
    components: root.FlowavePracticeScore ? {'practice-score': root.FlowavePracticeScore} : {},
    props: { configureTraining: Function, createCalibrationOutput: Function, previewMetronome: Function, setMetronomeSound: Function, configureMetronome: Function, setMetronomeVolume: Function, active: Boolean, switching: Boolean, baseUrl: String, path: String, title: String, artist: String, enabled: Boolean, loadingMix: Boolean, loadProgress: String, libraryRevision: Number, readClock: Function, currentTime: Number, playing: Boolean },
    emits: ['back', 'enable', 'disable', 'mix', 'seek', 'play'],
    data: () => ({ melodyLanguage:'unspecified', versionRows:[], selectedVersion:'', versionLoading:false, versionRequest:0, structure:null, structureRequest:0, autoUseKey: '', analysis: null, detail: null, mix: {}, solo: '', loop: true, error: '', busy: false, loading: false, request: 0, timer: null, saveTimer: null, savePayload: null, savePending: false, confirmDelete: false, savedRows: [], libraryLoading: false, deleteId: '' }),
    computed: {
      songKey(){return this.detail?.id?this.detail.id+':'+JSON.stringify(this.detail.source||''):'';},
      stems() { return Object.keys(this.detail?.stems || {}).sort((a, b) => ['vocals','drums','bass','guitar','piano','other'].indexOf(a) - ['vocals','drums','bass','guitar','piano','other'].indexOf(b)); },
      task() { return this.detail?.preparation || {}; },
      working() { return ['running','cancelling'].includes(this.task.state); },
      ownTask() { return this.task.id === this.detail?.id; },
      taskText() { return ({ preparing: '检查已有结果', decoding: '读取音乐', loading: '准备分离', separating: '分离音轨', encoding: '保存伴奏音轨', saved: '音轨已保存，继续准备演奏信息', checking: '校验分析组件', harmony: '分析拍点、和弦与调性', melody: '分析主唱旋律', analysis_saved: '保存演奏信息', ready: '准备完成' })[this.task.stage] || '准备演奏中'; },
      size() { return Object.values(this.detail?.stems || {}).reduce((n, x) => n + x.bytes, 0); },
    },
    watch: {
      active(value) { if (value) {this.autoUseKey='';this.refresh();} else {this.stopPoll();this.request++;if(this.loadingMix)this.$emit('disable');} },
      switching(value) { if(!value){this.maybeAutoUse();this.$refs.score?.$refs.training?.apply(false);} },
      path() { this.versionLoading=false;this.versionRequest++;this.versionRows=[];this.selectedVersion='';this.autoUseKey='';this.flushSave(); this.request++; this.analysis = null; this.structure=null;this.structureRequest++;this.detail = null; this.mix = {}; this.solo = ''; this.error = ''; this.confirmDelete = false; if (this.active) this.refresh(true); },
      libraryRevision() { this.request++;this.analysis=null;if (this.active) this.refresh(true); },
    },
    mounted() { if (this.active) this.refresh(true); },
    beforeUnmount() { this.versionRequest++;this.flushSave(); this.request++; this.stopPoll(); },
    methods: {
      async loadStructure(id){const request=++this.structureRequest;this.structure=null;if(!id)return;try{const {data}=await root.axios.get(this.baseUrl+'/analysis/track',{params:{resource_id:id}});if(request===this.structureRequest&&this.detail?.id===id)this.structure=data.structure?.status==='ready'?root.Vue.markRaw(data.structure):null}catch{}},
      playSaved(row) { if (row.available && row.id) this.$emit('play', row.id); },
      label(name) { return labels[name] || name; },
      bytes(value) { return ((Number(value) || 0) / 1000000).toFixed(1) + ' MB'; },
      stopPoll() { clearTimeout(this.timer); this.timer = null; },
      async refresh(reset = false) {
        this.stopPoll(); const request = ++this.request; const path = this.path;
        this.loading = !this.detail;
        try {
          const { data } = await root.axios.get(this.baseUrl + '/practice/track', { params: { path } });
          if (request !== this.request || path !== this.path) return;
          const changed = this.detail?.generation !== data.generation || this.detail?.id !== data.id;
          this.detail = data;
          if(reset||changed)this.loadStructure(data.id);
          if (!this.analysis || this.analysis.revision !== data.analysis?.revision || this.analysis.status !== data.analysis?.status) {
            this.analysis = root.Vue.markRaw(data.analysis || {status:'missing'});

            this.versionRequest++;this.versionRows=[];this.selectedVersion='';this.versionLoading=false;
            const language=this.analysis.analysis?.provenance?.language;
            this.melodyLanguage=['ja','en','zh','yue'].includes(language)?language:'unspecified';
          }
          if (reset || changed) {
            this.mix = Object.fromEntries(Object.keys(data.stems || {}).map(name => [name, { volume: data.mix?.[name]?.volume ?? 100, muted: data.mix?.[name]?.muted === true }]));
            this.solo='';this.loop=true;try{const state=JSON.parse(localStorage.getItem('lx-practice-mix-state:'+this.songKey)||'{}');this.solo=Object.hasOwn(data.stems||{},state.solo)?state.solo:'';this.loop=state.loop!==false}catch{}this.$emit('mix',{mix:this.mix,solo:this.solo,loop:this.loop});
          }
          this.maybeAutoUse();
        } catch (error) { if (request === this.request) this.error = message(error); }
        finally {
          if (request === this.request) { this.loading = false; if (this.active && this.working) this.timer = setTimeout(() => this.refresh(), 1500); }
        }
      },
      saveMixer(){if(!this.songKey)return;try{localStorage.setItem('lx-practice-mix-state:'+this.songKey,JSON.stringify({solo:this.solo,loop:this.loop}))}catch{this.error='练习设置未能保存。'}},
      changed() {
        this.saveMixer();
        this.$emit('mix', { mix: this.mix, solo: this.solo, loop: this.loop });
        this.savePending = true; clearTimeout(this.saveTimer);
        const payload = { resource_id: this.detail.id, mix: JSON.parse(JSON.stringify(this.mix)) };
        this.savePayload = payload;
        this.saveTimer = setTimeout(() => this.save(payload), 350);
      },
      async save(payload) {
        this.savePending = false; this.savePayload = null;
        const write = saveChain.catch(() => {}).then(() => root.axios.post(this.baseUrl + '/stems/mix', payload));
        saveChain = write;
        try { await write; }
        catch (error) { if (payload.resource_id === this.detail?.id) this.error = '音量设置未保存：' + message(error); }
      },
      flushSave() { clearTimeout(this.saveTimer); if (this.savePayload) this.save(this.savePayload); },
      soloTrack(name) { this.solo = this.solo === name ? '' : name; this.saveMixer();this.$emit('mix', { mix: this.mix, solo: this.solo }); },
      reset() { for (const name of this.stems) this.mix[name] = { volume: 100, muted: false }; this.solo = ''; this.changed(); },
      async start(force = false, melodyOnly = false) {
        if (this.busy || this.working || !this.detail?.id || this.detail.preparation_message) return;
        const id = this.detail.id, path = this.path;
        this.busy = true; this.error = '';
        try {
          if ((force === true || melodyOnly === true) && (this.enabled || this.loadingMix)) {
            this.$emit('disable');
            await this.$nextTick();
            if (this.enabled || this.loadingMix) throw new Error('尚未切回原曲，请稍后重试。');
          }
          if (path !== this.path || id !== this.detail?.id || !this.active) return;
          await root.axios.post(this.baseUrl + '/practice/start', { resource_id: id, force: force === true, melody_only: melodyOnly === true, melody_language: this.melodyLanguage });
          if (path === this.path && id === this.detail?.id) await this.refresh();
        }
        catch (error) { this.error = message(error); }
        finally { this.busy = false; }
      },
      versionLabel(row){return new Date(row.updated*1000).toLocaleString('zh-CN')+' · '+row.notes+' 音'+(row.current?' · 当前':'');},
      async loadVersions(){
        const id=this.detail?.id,path=this.path,revision=this.analysis?.revision,request=++this.versionRequest;
        if(!id)return;this.versionLoading=true;
        try{const {data}=await root.axios.get(this.baseUrl+'/practice/melody/versions',{params:{resource_id:id}});
          if(request!==this.versionRequest||this.detail?.id!==id||this.path!==path||this.analysis?.revision!==revision)return;
          this.versionRows=data.rows||[];this.selectedVersion=this.versionRows.find(r=>r.current)?.digest||'';
        }catch(error){if(request===this.versionRequest)this.error=message(error)}finally{if(request===this.versionRequest)this.versionLoading=false}
      },
      async restoreVersion(){
        const current=this.versionRows.find(r=>r.current),target=this.versionRows.find(r=>r.digest===this.selectedVersion);
        if(this.busy||this.working||!current||!target||target.current)return;
        const id=this.detail.id,path=this.path;this.busy=true;this.error='';
        try{await root.axios.post(this.baseUrl+'/practice/melody/version',{resource_id:id,digest:target.digest,expected_digest:current.digest});
          if(this.detail?.id===id&&this.path===path){await this.refresh();await this.loadVersions()}
        }catch(error){if(this.detail?.id===id)this.error=message(error)}finally{this.busy=false}
      },
      async cancel() {
        this.busy = true;
        try { await root.axios.post(this.baseUrl + '/practice/cancel'); await this.refresh(); }
        catch (error) { this.error = message(error); }
        finally { this.busy = false; }
      },
      maybeAutoUse() {
        if(this.busy||this.working||!this.active||this.switching||!this.path||this.detail?.status!=='ready'||!this.stems.length||this.loadingMix)return;
        const key=JSON.stringify([this.path,this.detail.id,this.detail.generation]);
        if(this.autoUseKey===key)return;this.autoUseKey=key;
        if(!this.enabled)this.use();
      },
      use() { this.flushSave(); this.$emit('enable', { detail: this.detail, mix: JSON.parse(JSON.stringify(this.mix)), solo: this.solo, loop: this.loop }); },
      async remove() {
        this.busy = true; this.error = ''; this.flushSave();
        const id = this.detail.id;
        try { await saveChain.catch(() => {}); await root.axios.delete(this.baseUrl + '/practice/track/' + encodeURIComponent(id)); if(root.FlowavePracticeTraining?.clear(id)===false)this.error='演奏数据已清理，练习偏好未能清除。';if (this.detail?.id === id) { this.confirmDelete = false; await this.refresh(true); } }
        catch (error) { this.error = message(error); }
        finally { this.busy = false; }
      },
      async loadLibrary() {
        this.libraryLoading = true;
        try { const { data } = await root.axios.get(this.baseUrl + '/practice/library'); this.savedRows = data.rows || []; }
        catch (error) { this.error = message(error); }
        finally { this.libraryLoading = false; }
      },
      async removeStored(row) {
        if ((this.enabled || this.loadingMix) && row.id === this.detail?.id) return;
        this.busy = true; this.flushSave();
        try { await saveChain.catch(() => {}); await root.axios.delete(this.baseUrl + '/practice/track/' + encodeURIComponent(row.id)); if(root.FlowavePracticeTraining?.clear(row.id)===false)this.error='演奏数据已清理，练习偏好未能清除。';this.deleteId = ''; await this.loadLibrary(); await this.refresh(); }
        catch (error) { this.error = message(error); }
        finally { this.busy = false; }
      },
    },
    template: `<section v-show="active" class="content practice-page" aria-label="演奏">
      <header class="practice-heading"><button type="button" class="mini practice-back" @click="$emit('back')" aria-label="返回上一页">‹</button><div><h1>演奏</h1><p>{{ title || '还没有播放歌曲' }}<span v-if="artist"> · {{artist}}</span></p></div><span v-if="enabled" class="practice-mode">伴奏播放中</span></header>
      <section v-if="detail?.id && (!detail.prepared || working)" class="practice-preparation"><div class="practice-actions"><button v-if="!working" type="button" class="primary" :disabled="busy||!!detail.preparation_message" @click="start()">{{ownTask&&['failed','cancelled','interrupted'].includes(task.state)?'继续准备演奏':'准备演奏'}}</button><template v-else><span class="practice-note">{{ownTask?taskText:'另一首歌曲正在准备演奏'}}<span v-if="task.device"> · {{task.device}}</span></span><button type="button" class="mini" :disabled="busy||task.state==='cancelling'" @click="cancel">{{task.state==='cancelling'?'正在取消…':'取消准备'}}</button></template></div><progress v-if="working" :value="task.progress||0" max="100" aria-label="演奏准备进度"></progress><p v-if="detail.preparation_message&&!detail.prepared" class="practice-note">{{detail.preparation_message}}</p><p v-if="ownTask&&['failed','cancelled','interrupted'].includes(task.state)" class="practice-note" role="status">{{task.message}}</p></section>
      <practice-score ref="score" :configure-training="configureTraining" :song-key="songKey" :segments="structure?.segments||[]" :duration="detail?.duration||0" :create-calibration-output="createCalibrationOutput" :preview-metronome="previewMetronome" :set-metronome-sound="setMetronomeSound" :configure-metronome="configureMetronome" :set-metronome-volume="setMetronomeVolume" :active="active" :path="path" :analysis="analysis" :loading="loading" :read-clock="readClock" :current-time="currentTime" :playing="playing" @seek="$emit('seek',$event)"></practice-score>
      <p v-if="error" class="practice-error" role="alert">{{error}}</p>
      <p v-if="loading" role="status">正在读取已保存的音轨…</p>
      <template v-else-if="detail">
        <section v-if="detail.status==='ready'" class="practice-mixer">
          <div class="practice-section-title"><h2>伴奏音轨</h2><div class="practice-actions"><button v-if="enabled" type="button" class="mini" @click="$emit('disable')">切回原曲</button><button v-else type="button" class="primary" :disabled="loadingMix" @click="use">{{loadingMix?'载入音轨…':'使用分轨伴奏'}}</button><button v-if="loadingMix" type="button" class="mini" @click="$emit('disable')">取消载入</button><button type="button" class="mini" :disabled="loadingMix" @click="reset">恢复全部</button><label class="practice-loop"><input class="ui-toggle" type="checkbox" v-model="loop" @change="saveMixer();$emit('mix',{mix,solo,loop})">循环本曲</label></div></div>
          <p v-if="loadingMix" role="status">{{loadProgress}}</p>
          <div class="practice-tracks"><div class="practice-track" v-for="name in stems" :key="name"><div class="practice-track-label"><strong>{{label(name)}}</strong><small>{{bytes(detail.stems[name].bytes)}}</small></div><input type="range" min="0" max="100" step="1" v-model.number="mix[name].volume" :disabled="loadingMix" @input="changed" :aria-label="label(name)+'音量'"><output>{{mix[name].volume}}%</output><button type="button" class="mini" :disabled="loadingMix" :class="{active:mix[name].muted}" :aria-pressed="mix[name].muted" @click="mix[name].muted=!mix[name].muted;changed()">静音</button><button type="button" class="mini" :disabled="loadingMix" :class="{active:solo===name}" :aria-pressed="solo===name" @click="soloTrack(name)">独听</button></div></div>

        </section>
        <section v-else class="practice-empty"><h2>{{detail.status==='outdated'?'这首歌的分轨需要更新':detail.status==='unsupported'?'选择一首本地歌曲':'还没有分离音轨'}}</h2><p>{{detail.message || '点击上方“准备演奏”，完成后可分别控制人声与乐器。'}}</p><p v-if="detail.model">{{detail.model.label}}</p><p v-if="detail.component_message">{{detail.component_message}}</p></section>
        <details v-if="detail.id" class="practice-storage"><summary>本曲演奏数据</summary><div class="practice-section-title"><span v-if="size">本曲音轨 {{bytes(size)}}</span></div><p v-if="detail.usage?.tracks">伴奏分轨已保存 {{detail.usage.tracks}} 首 · {{bytes(detail.usage.bytes)}}（包含旧版本）</p><div class="practice-actions" v-if="size||analysis?.status==='ready'"><button type="button" class="mini" :disabled="busy||working||!!detail.preparation_message" @click="start(true)">重新准备</button><button type="button" class="mini" :disabled="busy||enabled||loadingMix||(working&&ownTask)" @click="confirmDelete=!confirmDelete">清理本曲演奏数据</button></div><div v-if="confirmDelete" class="practice-confirm"><p>清理这首歌的分轨、演奏分析和调音设置？原音乐会保留。</p><button type="button" :disabled="busy||enabled||loadingMix" @click="remove">确认清理</button><button type="button" class="mini" @click="confirmDelete=false">保留</button></div><p v-if="enabled" class="practice-note">清理前请先切回原曲。</p><div v-if="analysis?.status==='ready' && detail.status==='ready'" class="practice-actions practice-melody-controls"><label>演唱语言 <select v-model="melodyLanguage" :disabled="busy||working"><option value="unspecified">未指定</option><option value="ja">日语</option><option value="en">英语</option><option value="zh">普通话</option><option value="yue">粤语</option></select></label><button type="button" class="mini" :disabled="busy||working||!!detail.preparation_message" @click="start(false,true)">更新旋律</button></div><details v-if="analysis?.status==='ready'" class="practice-analysis-versions" @toggle="$event.target=== $event.currentTarget && $event.target.open && loadVersions()"><summary>分析版本</summary><span v-if="versionLoading" class="practice-note">正在读取…</span><div v-else class="practice-actions practice-version-controls"><select v-model="selectedVersion" aria-label="分析版本" :disabled="busy||working"><option v-for="row in versionRows" :value="row.digest">{{versionLabel(row)}}</option></select><button type="button" class="mini" :disabled="busy||working||!selectedVersion||versionRows.find(r=>r.digest===selectedVersion)?.current" @click="restoreVersion">使用此版本</button></div></details></details>
      </template>
      <details class="practice-library" @toggle="$event.target.open && loadLibrary()"><summary>管理已保存的演奏数据</summary><p v-if="libraryLoading">正在读取…</p><p v-else-if="!savedRows.length">尚无已保存的演奏数据。</p><div v-for="row in savedRows" :key="row.id" class="practice-saved-row"><div class="practice-saved-title" role="button" :tabindex="row.available?0:-1" :aria-disabled="!row.available" :title="row.available?'双击播放这首歌':'歌曲已移出曲库，暂不能播放'" @dblclick="playSaved(row)" @keydown.enter.prevent="playSaved(row)" @keydown.space.prevent="playSaved(row)"><strong>{{row.title}}</strong><small>{{row.count}} 轨<span v-if="row.analysis"> · 演奏分析</span> · {{bytes(row.bytes)}}<span v-if="!row.available"> · 已移出曲库</span></small></div><button type="button" class="mini" :disabled="busy || ((enabled||loadingMix)&&row.id===detail?.id) || (working&&row.id===task.id)" @click="deleteId=deleteId===row.id?'':row.id">清理</button><div v-if="deleteId===row.id" class="practice-saved-confirm"><span>清理这首歌的分轨、演奏分析和调音设置？</span><button type="button" class="mini" :disabled="busy || ((enabled||loadingMix)&&row.id===detail?.id)" @click="removeStored(row)">确认清理</button><button type="button" class="mini" @click="deleteId=''">保留</button></div></div></details>
    </section>`
  };
})(window);
