(function(root){
 'use strict';
 const {shallowReactive,markRaw}=root.Vue;
 // hostApi 1 also supports older hosts which do not ship the shared reader.
 if(!root.FlowaveAnalysisData){
 const store=shallowReactive({rows:markRaw([]),task:{state:'idle'},revision:0,loaded:false,base:'',structure:{available:false,message:'正在确认段落分析组件。'}});
 let pending=null,catalogGeneration=0;
 async function catalog(base,force=false){
   if(!force&&pending&&store.base===base)return pending;
   const generation=++catalogGeneration;
   store.base=base;const request=root.axios.get(base+'/analysis/catalog').then(({data})=>{if(store.base!==base||generation!==catalogGeneration)return;store.rows=markRaw(data.rows||[]);store.task=data.task||{};store.structure=data.structure||{available:false,message:'段落分析组件尚未准备完整。'};store.loaded=true;store.revision++;});
   pending=request;try{await request;}finally{if(pending===request)pending=null;}
 }
 root.FlowaveAnalysisData={store,catalog};
 }
 const {store,catalog}=root.FlowaveAnalysisData;
 const names={instrument:'乐器与音色',genre:'风格',mood:'氛围',theme:'主题'};
 const structureNames={intro:'前奏',verse:'主歌','pre-chorus':'预副歌',chorus:'副歌',bridge:'桥段',inst:'器乐段',outro:'尾奏',silence:'静默区间'};
 function time(value){value=Math.max(0,Number(value)||0);return Math.floor(value/60)+':'+String(Math.floor(value%60)).padStart(2,'0');}
 function rowTags(row){return Object.values(row?.tags||{}).flat();}
 root.FlowaveMusicInsights={
  props:{active:Boolean,baseUrl:String,tracks:Array,path:String,playingPath:String,currentTime:Number,kind:String,libraryRevision:Number},
  emits:['back','inspect','queue','play','seek','current'],
  data:()=>({shared:store,loading:false,error:'',detail:null,request:0,focusedRow:'',selected:[],includes:[],excludes:[],query:'',draft:'',page:1,chosen:[],preview:null,feature:'',processingOpen:false,processingTarget:'tags',pollTimer:0,searchTimer:0,busy:false,onlyMissing:false,includeUnknown:false,showAllTags:false}),
  computed:{
   library(){const metadata=new Map((this.tracks||[]).map(t=>[t.path,t]));return this.shared.rows.filter(r=>metadata.has(r.path)).map(r=>{const t=metadata.get(r.path)||{};return {...r,title:t.title||t.name||r.path.split(/[\\/]/).pop(),artist:t.artist||'未知艺术家'};});},
   trackMap(){return new Map(this.library.map(r=>[r.path,r]));},
   current(){return this.trackMap.get(this.path)||{path:this.path,title:(this.path||'').split(/[\\/]/).pop()||'还没有播放歌曲',artist:''};},
   activeJob(){return ['running','paused','cancelling'].includes(this.shared.task.state);},
   taskLabel(){return ({idle:'尚未开始',running:'处理中',paused:'已暂停',cancelling:'正在取消',cancelled:'已取消',interrupted:'上次处理已中断',completed:'处理完成',failed:'处理未完成'})[this.shared.task.state]||'尚未开始';},
   stageLabel(){return ({preparing:'准备歌曲',loading:'加载模型',analyzing:'分析音频',result:'保存结果',failed:'记录失败',fatal:'组件检查'})[this.shared.task.stage]||'';},
   readyCount(){return this.library.filter(r=>r.status==='ready').length;},
   structureReadyCount(){return this.library.filter(r=>r.structure_status==='ready').length;},
   processingReadyCount(){return this.processingTarget==='structure'?this.structureReadyCount:this.readyCount;},
   taskTargetLabel(){return this.shared.task.target==='structure'?'段落':'标签';},
   structure(){return this.detail?.structure||null;},
   structureSegments(){return this.structure?.segments||[];},
   activeStructure(){return this.structureSegments.find(s=>s.start<=this.observedTime&&this.observedTime<s.end)||null;},
   structureCursor(){return Math.max(0,Math.min(100,this.observedTime/(this.structure?.duration||1)*100));},
   phaseLabel(){return ({checking:'校验组件','precision-fallback':'使用高精度计算',muq:'分析整曲音色','muq-local':'分析局部音色',musicfm:'分析整曲关系','musicfm-local':'分析局部关系',structure:'识别段落'})[this.shared.task.phase]||'';},
   processingTitle(){return this.library.find(r=>r.id===this.shared.task.current_id)?.title||'';},
   facets(){const groups={};for(const [kind,name] of Object.entries(names)){const counts=new Map();for(const row of this.library){if(row.status!=='ready')continue;for(const tag of row.tags[kind]||[]){const old=counts.get(tag.id)||{...tag,count:0};old.count++;counts.set(tag.id,old);}}groups[kind]={name,items:[...counts.values()].sort((a,b)=>b.count-a.count).slice(0,this.showAllTags?Infinity:18)};}return groups;},
   filterSummary(){const lookup=new Map(this.library.flatMap(rowTags).map(t=>[t.id,t.label]));const label=id=>lookup.get(id)||'已失效条件';const groups=Object.keys(names).map(kind=>this.includes.filter(id=>id.startsWith(kind+':')).map(label).join(' 或 ')).filter(Boolean);return (groups.length?'包含：'+groups.join('；同时满足 '):'')+(this.excludes.length?'　排除：'+this.excludes.map(label).join('、'):'');},
   filtered(){const q=this.query.trim().toLocaleLowerCase();return this.library.filter(r=>{if(q&&!(r.title+' '+r.artist).toLocaleLowerCase().includes(q))return false;if(this.onlyMissing&&(this.processingTarget==='structure'?r.structure_status:r.status)==='ready')return false;
    if(r.status!=='ready')return (!this.includes.length&&!this.excludes.length)||this.includeUnknown;
    const tags=new Set(rowTags(r).map(t=>t.id));if(this.excludes.some(id=>tags.has(id)))return false;
    for(const kind of Object.keys(names)){const required=this.includes.filter(id=>id.startsWith(kind+':'));if(required.length&&!required.some(id=>tags.has(id)))return false;}return true;});},
   pageRows(){return this.filtered.slice((this.page-1)*60,this.page*60);},
   pageCount(){return Math.max(1,Math.ceil(this.filtered.length/60));},
   distributions(){return Object.entries(names).map(([kind,name])=>{const counts=new Map();for(const row of this.filtered){if(row.status!=='ready')continue;for(const tag of row.tags[kind]||[]){const value=counts.get(tag.id)||{...tag,count:0};value.count++;counts.set(tag.id,value);}}return {kind,name,total:this.filtered.filter(r=>r.status==='ready').length,items:[...counts.values()].sort((a,b)=>b.count-a.count).slice(0,4)};});},
   segments(){return this.detail?.segments||[];},
   observedTime(){return this.preview===null&&this.path===this.playingPath?Number(this.currentTime)||0:Number(this.preview)||0;},
   segment(){return this.segments.find(s=>this.observedTime>=s.from&&this.observedTime<s.to)||this.segments[this.segments.length-1]||null;},
   localFeatures(){return Object.entries(names).map(([kind,name])=>({kind,name,tags:this.segment?.tags?.[kind]||[]}));},
   featureSegments(){return this.feature?this.segments.filter(s=>Object.values(s.tags||{}).flat().some(t=>t.id===this.feature)):[];}
  },
  watch:{active(value){if(value)this.activate();else{clearTimeout(this.pollTimer);this.request++;this.loading=false;}},baseUrl(){if(this.active)this.activate(true);},path(){this.preview=null;this.feature='';if(this.active&&this.kind==='player')this.loadDetail();},libraryRevision(){this.chosen=[];if(this.active)this.activate(true);},'shared.revision'(){if(this.active&&this.kind==='player')this.loadDetail();},'shared.task'(task){if(this.activeJob&&['tags','structure'].includes(task.target))this.processingTarget=task.target;},pageCount(value){this.page=Math.min(this.page,value);}},
  mounted(){if(this.active)this.activate();},beforeUnmount(){clearTimeout(this.pollTimer);clearTimeout(this.searchTimer);this.request++;},
  methods:{time,sectionStyle(label){return root.FlowaveSectionColors?.style(label)||{};},
   async activate(force=false){try{await catalog(this.baseUrl,force===true);if(!this.active)return;if(!this._processingTargetInitialized){if(['tags','structure'].includes(this.shared.task.target))this.processingTarget=this.shared.task.target;this._processingTargetInitialized=true;}if(this.kind==='player')await this.loadDetail();this.poll();}catch(e){this.error=this.message(e,'分析数据库暂时无法读取。');}},
   async loadDetail(){const request=++this.request;this.detail=null;this.error='';const row=this.trackMap.get(this.path);if(!row)return;this.loading=true;try{const {data}=await root.axios.get(this.baseUrl+'/analysis/track',{params:{resource_id:row.id}});if(request===this.request&&this.active)this.detail=markRaw(data);}catch(e){if(request===this.request)this.error=this.message(e,'分析结果暂时无法读取。');}finally{if(request===this.request)this.loading=false;}},
   message(e,fallback){return typeof e?.response?.data?.detail==='string'?e.response.data.detail:fallback;},
   poll(){clearTimeout(this.pollTimer);if(!this.active)return;this.pollTimer=setTimeout(async()=>{try{const {data}=await root.axios.get(this.baseUrl+'/analysis/task');if(!this.active)return;const old=this.shared.task;this.shared.task=data;if(data.success!==old.success||data.state!==old.state)await catalog(this.baseUrl);}catch(e){this.error=this.message(e,'进度暂时无法读取。');}finally{if(this.active&&this.activeJob)this.poll();}},1800);},
   async start(mode,ids,target=this.processingTarget){if(this.busy)return;this.busy=true;this.error='';try{const {data}=await root.axios.post(this.baseUrl+'/analysis/start',{mode,ids:ids||[],target});this.shared.task=data;this.processingTarget=data.target||target;this.processingOpen=true;this.poll();}catch(e){this.error=this.message(e,'音乐处理未能开始。');}finally{this.busy=false;}},
   async control(action){if(this.busy)return;this.busy=true;try{const {data}=await root.axios.post(this.baseUrl+'/analysis/control/'+action);this.shared.task=data;this.poll();}catch(e){this.error=this.message(e,'操作暂时未完成。');}finally{this.busy=false;}},
   search(){clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>{this.query=this.draft;this.page=1;},120);},
   toggle(id,exclude=false){const key=exclude?'excludes':'includes',other=exclude?'includes':'excludes';this[key]=this[key].includes(id)?this[key].filter(x=>x!==id):[...this[key],id];this[other]=this[other].filter(x=>x!==id);this.page=1;},
   clear(){this.includes=[];this.excludes=[];this.onlyMissing=false;this.includeUnknown=false;this.draft='';this.query='';this.page=1;},
   choose(id){this.chosen=this.chosen.includes(id)?this.chosen.filter(x=>x!==id):[...this.chosen,id];},
   chooseFiltered(){this.chosen=this.filtered.every(r=>this.chosen.includes(r.id))?[]:this.filtered.map(r=>r.id);},
   playList(row){this.$emit('queue',{paths:this.filtered.map(r=>r.path),path:row.path});},
   tagText(row){return Object.values(row?.tags||{}).map(tags=>tags[0]?.label).filter(Boolean).slice(0,4).join(' · ')||(row.status==='ready'?'暂无明显特点':row.status==='outdated'?'结果待更新':'未分析');},
   statusText(row){return row.status==='ready'?'自动分析':row.status==='outdated'?'结果待更新':'未分析';},
   width(tag){return Math.max(0,Math.min(100,Number(tag.score)*100))+'%';},
   segmentAt(s){if(this.path===this.playingPath){this.preview=null;this.$emit('seek',s.start);}else this.preview=s.start;},
   inspectTagTime(event){this.segmentAt({start:Math.max(0,Math.min(this.detail?.duration||0,Number(event.target.value)||0))});},
   analyzeCurrent(target='tags'){const row=this.trackMap.get(this.path);if(row)this.start('selected',[row.id],target);},
   structureName(label){return structureNames[label]||'未明确';},
   structureAt(s){if(this.path===this.playingPath){this.preview=null;this.$emit('seek',s.start);}else this.preview=s.start;},
   structureSeek(event){const t=Math.max(0,Math.min(this.structure?.duration||0,Number(event.target.value)||0));this.structureAt({start:t});},
   async openData(){try{const result=await root.lxEnv?.openAnalysisData?.();if(!result?.ok)this.error=result?.message||'请在桌面软件中打开数据位置。';}catch(e){this.error='数据目录暂时无法打开。';}},
   featureName(){return rowTags(this.detail).find(t=>t.id===this.feature)?.label||'局部特点';}
  },
  template:`<section v-show="active" class="music-insights content" :class="{'analysis-playing':kind==='player'}">
   <header class="insights-heading"><div><button v-if="kind==='player'" class="analysis-back" @click="$emit('back')">‹ 返回</button><h1>{{kind==='library'?'曲库概览':'歌曲分析'}}</h1><p v-if="kind==='library'">{{library.length}} 首 · {{readyCount}} 首分析有效 · {{library.length-readyCount}} 首待处理</p><template v-else><h2>{{current.title}}</h2><p>{{current.artist}} <button v-if="path!==playingPath" @click="$emit('current')">回到当前播放</button></p></template></div><button @click="processingOpen=!processingOpen">音乐处理 <span v-if="activeJob">· {{taskLabel}}</span></button></header>
   <p v-if="error" class="analysis-error" role="alert">{{error}} <button @click="activate">重新读取</button></p>
   <section v-if="processingOpen||activeJob" class="analysis-processing" aria-label="音乐处理">
    <div class="analysis-section-title"><h2>音乐处理</h2><span>{{shared.task.target==='structure'?'段落结构':'歌曲标签'}} · {{taskLabel}} · {{activeJob?(phaseLabel||stageLabel):''}}</span></div><p>标签与段落分别保存到本软件的数据目录；不改动原音乐文件。 <button @click="openData">打开数据位置</button></p>
    <div class="analysis-actions"><label>处理内容 <select v-model="processingTarget" :disabled="activeJob||busy" aria-label="处理内容"><option value="tags">歌曲标签</option><option value="structure">段落结构</option></select></label><span>{{processingReadyCount}} / {{library.length}} 首已有有效{{processingTarget==='structure'?'段落':'标签'}}</span></div>
    <p v-if="processingTarget==='structure'">识别前奏、主歌、副歌等段落；仅使用音频。当前支持5秒至{{Math.floor((shared.structure.max_duration||600)/60)}}分钟的完整歌曲，细分名称可能存在歧义，器乐曲仅供参考。</p><p v-if="processingTarget==='structure'&&!shared.structure.available" class="analysis-warning">{{shared.structure.message}}</p>
    <div class="analysis-actions"><button :disabled="activeJob||busy||(processingTarget==='structure'&&!shared.structure.available)" @click="start('missing')">处理新增／待更新歌曲</button><button :disabled="activeJob||busy||!chosen.length||(processingTarget==='structure'&&!shared.structure.available)" @click="start('selected',chosen)">处理所选 {{chosen.length||''}}</button><button :disabled="activeJob||busy||!library.length||(processingTarget==='structure'&&!shared.structure.available)" @click="start('all')">重新处理全库</button><button v-if="['interrupted','cancelled','failed'].includes(shared.task.state)&&shared.task.remaining" :disabled="activeJob||busy" @click="start('resume',[],shared.task.target)">继续{{taskTargetLabel}}未完成 {{shared.task.remaining}} 首</button><button v-if="shared.task.failed" :disabled="activeJob||busy" @click="start('retry',[],shared.task.target)">重试{{taskTargetLabel}}失败 {{shared.task.failed}} 首</button></div>
    <template v-if="shared.task.total"><progress :value="shared.task.done||0" :max="shared.task.total" :aria-label="'已处理'+(shared.task.done||0)+'首'"></progress><p>{{shared.task.done||0}} / {{shared.task.total}} 首 · 成功 {{shared.task.success||0}} · 失败 {{shared.task.failed||0}} · 复用 {{shared.task.reused||0}} <template v-if="shared.task.started"> · {{time(((shared.task.finished||Date.now()/1000)-shared.task.started))}}</template></p><p v-if="activeJob&&shared.task.segment_total">{{processingTitle||'当前歌曲'}} · {{phaseLabel}} {{time(shared.task.segment_end)}} / {{time(shared.task.segment_total)}}</p><p v-if="shared.task.device">{{shared.task.device}} · {{shared.task.target==='structure'?'段落使用显卡，CPU限2线程':'氛围使用显卡，乐器与风格使用2个CPU线程'}}</p></template>
    <div class="analysis-actions" v-if="activeJob"><button v-if="shared.task.state==='running'" :disabled="busy" @click="control('pause')">暂停</button><button v-if="shared.task.state==='paused'" :disabled="busy" @click="control('resume')">继续</button><button :disabled="busy||shared.task.state==='cancelling'" @click="control('cancel')">取消处理</button></div><p v-if="shared.task.message" role="status">{{shared.task.message}}</p><details v-if="shared.task.failures?.length"><summary>查看失败歌曲</summary><p v-for="f in shared.task.failures" :key="f.id">{{library.find(r=>r.id===f.id)?.title||'曲库外歌曲'}} · {{f.message}}</p></details>
   </section>
   <template v-if="kind==='library'">
    <div class="analysis-overview" aria-label="全库分析覆盖"><span>有效标签 <strong>{{readyCount}}</strong></span><span>有效段落 <strong>{{structureReadyCount}}</strong></span><span>标签待处理 <strong>{{library.length-readyCount}}</strong></span><span>段落待处理 <strong>{{library.length-structureReadyCount}}</strong></span><span>筛选结果 <strong>{{filtered.length}}</strong></span></div>
    <section class="analysis-distributions"><div class="analysis-section-title"><h2>当前范围的特点分布</h2><span>仅统计较明显的特点，可重复归类</span></div><div class="analysis-feature-columns"><div v-for="group in distributions" :key="group.kind"><h3>{{group.name}}</h3><button v-for="tag in group.items" :key="tag.id" class="analysis-distribution-row" @click="toggle(tag.id)"><span>{{tag.label}}</span><i><b :style="{width:(tag.count/Math.max(1,group.total)*100)+'%'}"></b></i><small>{{tag.count}} 首</small></button><p v-if="!group.items.length">{{group.total?'暂无明显标签':'暂无有效结果'}}</p></div></div></section>
    <section class="analysis-filters"><div class="analysis-section-title"><h2>组合筛选</h2><div class="analysis-actions"><button @click="showAllTags=!showAllTags" :aria-expanded="showAllTags">{{showAllTags?'收起标签':'全部标签'}}</button><button @click="clear">清除条件</button></div></div><p>每类可选任一，类别之间同时满足。标签为自动分析建议。</p><div v-for="(group,kind) in facets" :key="kind" class="analysis-facet"><h3>{{group.name}}</h3><div><span v-for="tag in group.items" :key="tag.id" class="analysis-filter-choice"><button :class="{selected:includes.includes(tag.id)}" :aria-pressed="includes.includes(tag.id)" @click="toggle(tag.id)">{{includes.includes(tag.id)?'✓ ':''}}{{tag.label}} <small>{{tag.count}}</small></button><button :class="{selected:excludes.includes(tag.id)}" :aria-pressed="excludes.includes(tag.id)" :aria-label="'排除'+tag.label" :title="'排除'+tag.label" @click="toggle(tag.id,true)">{{excludes.includes(tag.id)?'×':'−'}}</button></span><span v-if="!group.items.length" class="muted">{{readyCount?'暂无明显标签':'处理音乐后显示'}}</span></div></div><p v-if="filterSummary">{{filterSummary}}</p><p class="analysis-small">标签数量按全库有效分析统计，可重复归类。</p><div class="analysis-actions"><label><input type="checkbox" v-model="onlyMissing" @change="page=1">只看{{processingTarget==='structure'?'段落':'标签'}}待处理</label><label><input type="checkbox" v-model="includeUnknown" @change="page=1">筛选时也包含未分析歌曲</label></div></section>
    <div class="analysis-list-toolbar"><input type="search" v-model="draft" @input="search" placeholder="搜索歌曲、歌手" aria-label="搜索分析歌曲"><button @click="chooseFiltered" :disabled="!filtered.length">选择／取消当前全部结果</button><span>{{filtered.length}} 首</span></div>
    <div class="analysis-track-list"><div v-for="row in pageRows" :key="row.id" class="analysis-track" :class="{focused:focusedRow===row.id}" @dblclick="playList(row)"><input type="checkbox" :checked="chosen.includes(row.id)" @click.stop @dblclick.stop @change="choose(row.id)" :aria-label="'选择'+row.title"><button class="analysis-track-info" @click="focusedRow=row.id" @keydown.enter.prevent="playList(row)" title="双击播放当前列表"><strong>{{row.title}}</strong><small>{{row.artist}}</small><span :class="{muted:row.status!=='ready'}">{{tagText(row)}} · {{row.structure_status==='ready'?'段落已分析':row.structure_status==='outdated'?'段落待更新':row.structure_status==='unavailable'?'段落读取异常':'段落未分析'}} <small v-if="row.status==='outdated'">· 待更新</small></span></button><button @click.stop="$emit('inspect',row.path)" @dblclick.stop :aria-label="'查看'+row.title+'的分析'">分析</button><button @click.stop="playList(row)" @dblclick.stop :aria-label="'从'+row.title+'播放筛选列表'">播放</button></div><p v-if="!filtered.length" class="analysis-empty">{{library.length?'没有符合条件的歌曲，可清除筛选。':'音乐库中还没有歌曲，请先选择音乐文件夹。'}}</p></div><div class="analysis-pagination"><button :disabled="page<=1" @click="page--">上一页</button><span>{{page}} / {{pageCount}}</span><button :disabled="page>=pageCount" @click="page++">下一页</button></div>
   </template>
   <template v-else>
     <section class="analysis-local analysis-current-fragment" v-if="!loading&&segment"><div class="analysis-section-title"><h2>当前片段 <small>{{time(segment.start)}}—{{time(segment.end)}}</small></h2><input class="analysis-time-range" type="range" min="0" :max="detail.duration" step="1" :value="observedTime" @input="inspectTagTime" aria-label="选择局部标签时间"></div><div class="analysis-actions"><button v-if="preview!==null&&path===playingPath" @click="preview=null">跟随播放</button><button v-if="path!==playingPath" @click="$emit('play',path)">播放这首</button></div><p v-if="segment.silent">这段较安静，未推断标签。</p><div class="analysis-feature-columns"><div v-for="group in localFeatures" :key="group.kind"><h3>{{group.name}}</h3><span v-for="tag in group.tags" :key="tag.id" class="analysis-local-label">{{tag.label}}</span><span v-if="!group.tags.length" class="muted">暂不明确</span></div></div></section>
    <section v-if="!loading&&trackMap.has(path)" class="analysis-structure" aria-label="歌曲段落结构">
     <div class="analysis-section-title"><h2>段落结构</h2><button :disabled="busy||activeJob||!shared.structure.available||structure?.status==='unavailable'" @click="analyzeCurrent('structure')">{{structureSegments.length?'重新分析段落':'分析这首的段落'}}</button></div>
     <p v-if="!shared.structure.available" class="analysis-warning">{{shared.structure.message}}</p>
     <p v-if="structure?.message" class="analysis-warning">{{structure.message}}</p>
     <p v-if="structure?.status==='outdated'" class="analysis-warning">这是之前保存的段落，歌曲或分析方法已变化，可重新分析。</p>
     <template v-if="structureSegments.length">
      <div class="analysis-structure-now"><strong :style="sectionStyle(activeStructure?.label)">{{activeStructure?structureName(activeStructure.label):'未覆盖区间'}}</strong><span>{{time(observedTime)}} / {{time(structure.duration)}}</span><button v-if="preview!==null&&path===playingPath" @click="preview=null">跟随播放</button><button v-if="path!==playingPath" @click="$emit('play',path)">播放这首</button></div>
      <div class="analysis-structure-timeline" role="group" aria-label="选择歌曲段落"><button v-for="(s,i) in structureSegments" :key="i" :class="['structure-'+s.label,{current:activeStructure===s}]" :style="{...sectionStyle(s.label),flexBasis:((s.end-s.start)/structure.duration*100)+'%'}" :aria-label="structureName(s.label)+' '+time(s.start)+'至'+time(s.end)" :aria-pressed="activeStructure===s" :title="structureName(s.label)+' '+time(s.start)+'—'+time(s.end)" @click="structureAt(s)">{{structureName(s.label)}}</button><i class="analysis-cursor" :style="{left:structureCursor+'%'}"></i></div>
      <input class="analysis-time-range" type="range" min="0" :max="structure.duration" step="0.1" :value="Math.min(observedTime,structure.duration)" @input="structureSeek" aria-label="定位歌曲段落时间">
      <p class="analysis-small">{{path===playingPath?'点击段落跳转播放位置。':'点击段落仅预览位置。'}} 细分名称可能有歧义；段落类型不代表能量高低。</p>
      <details class="analysis-structure-list"><summary>全部段落 · {{structureSegments.length}}</summary><ol><li v-for="(s,i) in structureSegments" :key="i"><button :class="{current:activeStructure===s}" @click="structureAt(s)"><span>{{time(s.start)}}—{{time(s.end)}}</span><strong :style="sectionStyle(s.label)">{{structureName(s.label)}}</strong></button></li></ol></details>
     </template><p v-else-if="structure?.status!=='unavailable'">尚未分析这首歌的段落，可单独处理，无需先生成歌曲标签。</p>
    </section>
    <p v-if="loading" role="status">正在读取分析结果…</p><section v-else-if="!detail?.segments?.length" class="analysis-empty"><h2>这首歌还没有标签结果</h2><p>处理后可查看乐器、风格与氛围等特点。</p><button :disabled="busy||activeJob||!trackMap.has(path)" @click="analyzeCurrent()">分析这首歌的标签</button><p v-if="!trackMap.has(path)">当前仅支持音乐库中的本地歌曲。</p></section>
    <template v-else><p v-if="detail.status==='outdated'" class="analysis-warning">这是之前保存的结果，歌曲或分析方法已有变化。<button :disabled="activeJob||busy" @click="analyzeCurrent()">更新这首</button></p>
     <section class="analysis-summary"><div class="analysis-section-title"><h2>整曲特点</h2><span>自动分析建议</span></div><div class="analysis-feature-columns"><div v-for="(tags,kind) in detail.tags" :key="kind"><h3>{{({instrument:'乐器与音色',genre:'风格',mood:'氛围',theme:'主题'})[kind]}}</h3><button class="analysis-feature" :class="{selected:feature===tag.id}" v-for="tag in tags" :key="tag.id" @click="feature=feature===tag.id?'':tag.id"><span>{{tag.label}}</span><i><b :style="{width:width(tag)}"></b></i></button><span v-if="!tags.length" class="muted">暂不明确</span></div></div><p class="analysis-small">横条表示各自模型的匹配强度，仅供同类参考。点一个特点查看局部分布。</p></section>
     <section v-if="feature" class="analysis-local"><h2>{{featureName()}} · 局部特点</h2><div class="analysis-segment-strip"><button v-for="s in featureSegments" :key="s.start" @click="segmentAt(s)">{{time(s.start)}}—{{time(s.end)}}</button></div><p v-if="!featureSegments.length">没有进入片段候选的明确位置，整曲概括仍保留供参考。</p></section>
    </template>
   </template>
  </section>`
 };
})(window);
