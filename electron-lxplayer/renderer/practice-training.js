(function(root){
 'use strict';
 const names={intro:'前奏',verse:'主歌','pre-chorus':'预副歌',chorus:'副歌',bridge:'桥段',inst:'器乐段',outro:'尾奏',silence:'静默'};
 const defaults={rate:1,start:0,end:0,loop:false,ramp:false,every:3,step:5,target:100,last:0};
 function read(key){try{const v=JSON.parse(localStorage.getItem('lx-practice-training:'+key)||'{}');return {...defaults,...v,loop:v.loop===true,ramp:v.ramp===true,rate:Math.max(.5,Math.min(1.25,Number(v.rate)||1)),every:Math.max(1,Math.min(20,Number(v.every)||3)),step:Math.max(1,Math.min(10,Number(v.step)||5)),target:Math.max(50,Math.min(125,Number(v.target)||100))}}catch{return {...defaults}}}
 class Transport {
  constructor({source,config,readCurrent,setRate,seek,onError}){
   Object.assign(this,{source,config,readCurrent,setRate,seek,onError,cycles:0,lastCycle:0,disposed:false});
   const duration=Number(source.duration)||0;this.region=config.loop&&config.end-config.start>=.25&&config.start>=0&&config.end<=duration+.01?{start:config.start,end:Math.min(duration,config.end)}:null;
   if(this.region&&(source.currentTime<this.region.start||source.currentTime>=this.region.end))seek(this.region.start);
   source.setPracticeRegion?.(this.region);
   this.cycle=()=>{if(this.disposed||!this.region||!this.config.loop)return;const n=Number(source.practiceCycle)||0;if(n>this.lastCycle)this.completed(n-this.lastCycle);this.lastCycle=n};
   source.addEventListener('practicecycle',this.cycle);
   this.timer=setInterval(()=>{if(this.disposed)return;if(readCurrent()!==source){this.dispose();return}if(!this.region||source.paused||source.seeking||source.setPracticeRegion)return;const at=source.currentTime;if(at>=this.region.end)this.wrap()},20);
  }
  async completed(count=1){
   if(this.disposed||!this.region||!this.config.loop)return;
   const before=this.cycles;this.cycles+=count;const c=this.config,steps=Math.floor(this.cycles/Number(c.every))-Math.floor(before/Number(c.every));if(!c.ramp||steps<1||this.changing)return;
   const next=Math.round(Math.min(c.target/100,(Number(this.source.playbackRate)||1)+c.step/100*steps)*100)/100;if(next<=this.source.playbackRate)return;
   this.changing=true;try{await this.setRate(next);this.lastCycle=0}catch(e){this.onError?.(e.message)}finally{this.changing=false}
  }
  wrap(){if(!this.region||this.disposed)return false;this.seek(this.region.start);this.completed();return true}
  disableLoop(){this.region=null;this.config.loop=false;this.lastCycle=0;this.source.setPracticeRegion?.(null)}
  ended(){if(!this.wrap())return false;this.source.play().catch(e=>this.onError?.(e.message));return true}
  dispose(reset=true){if(this.disposed)return;this.disposed=true;clearInterval(this.timer);this.source.removeEventListener('practicecycle',this.cycle);if(!this.source.disposed){this.source.setPracticeRegion?.(null);if(reset)this.source.playbackRate=1}}
 }
 function clear(id){if(!id)return true;try{const prefixes=['lx-practice-training:','lx-practice-information-display:','lx-practice-mix-state:'];const keys=Object.keys(localStorage).filter(k=>prefixes.some(p=>k.startsWith(p+id+':')));for(const k of keys)localStorage.removeItem(k);root.dispatchEvent(new CustomEvent('flowave-practice-state-cleared',{detail:{id}}));return true}catch{return false}}
 root.FlowavePracticeTraining={Transport,read,clear};
 root.FlowaveTrainingControls={
  props:{active:Boolean,path:String,songKey:String,duration:Number,segments:Array,readClock:Function,configure:Function},emits:['seek'],
  data(){return {settings:{...defaults},error:'',busy:false,cycles:0,current:0,actualRate:1,lastSaved:0,drag:null,request:0}},
  computed:{parts(){return (this.segments||[]).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start).map(s=>({...s,name:names[s.label]||'段落'}))},length(){return Number(this.duration)||0},percent(){return this.length?Math.max(0,Math.min(100,this.current/this.length*100)):0}},
  watch:{active(v){if(v)this.restore();else this.leave()},songKey(){this.leave();if(this.active)this.restore()}},
  mounted(){if(this.active)this.restore();this.stateCleared=e=>{if(this.loadedKey?.startsWith(e.detail.id+':')){this.configure?.({enabled:false,path:this.loadedPath});this.loadedKey='';this.settings={...defaults}}};root.addEventListener('flowave-practice-state-cleared',this.stateCleared);this.loopDisabled=()=>{this.settings.loop=false;this.save()};root.addEventListener('flowave-practice-loop-disabled',this.loopDisabled);this.visibility=()=>{cancelAnimationFrame(this.frame);if(!document.hidden&&this.active)this.tick()};document.addEventListener('visibilitychange',this.visibility)},
  beforeUnmount(){this.leave();root.removeEventListener('flowave-practice-state-cleared',this.stateCleared);root.removeEventListener('flowave-practice-loop-disabled',this.loopDisabled);document.removeEventListener('visibilitychange',this.visibility)},
  methods:{sectionStyle(label){return root.FlowaveSectionColors?.style(label)||{};},
   async restore(){this.settings=read(this.songKey);if(this.settings.end>this.length||this.settings.start<0||this.settings.end-this.settings.start<.25){this.settings.loop=false;this.settings.start=0;this.settings.end=0}await this.apply(false);if(this.active)this.tick()},
   leave(){++this.request;cancelAnimationFrame(this.frame);if(this.loadedKey){this.save(true);this.configure?.({enabled:false,path:this.loadedPath});this.loadedKey=''}},
   save(position=false){if(!this.loadedKey)return;try{const v={...this.settings,last:position?this.current:this.settings.last};localStorage.setItem('lx-practice-training:'+this.loadedKey,JSON.stringify(v))}catch{this.error='练习设置未能保存。'}},
   async apply(persist=true){
    if(!this.active||!this.songKey||!this.configure)return;this.error='';this.busy=true;const request=++this.request;this.loadedKey=this.songKey;this.loadedPath=this.path;if(persist&&!this.settings.loop)this.save();
    try{await this.configure({enabled:true,path:this.path,...this.settings});if(request!==this.request)return;if(persist)this.save();}
    catch(e){if(request===this.request)this.error=e.message||'练习设置未能应用。'}finally{if(request===this.request)this.busy=false}
   },
   tick(){cancelAnimationFrame(this.frame);if(!this.active||document.hidden)return;const c=this.readClock?.();if(c?.path===this.path){this.current=Number(c.time)||0;this.actualRate=Number(c.rate)||1;this.cycles=Number(c.trainingCycles)||0;if(performance.now()-this.lastSaved>5000){this.lastSaved=performance.now();this.save(true)}}this.frame=requestAnimationFrame(()=>this.tick())},
   time(t){t=Math.max(0,Number(t)||0);return Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0')},
   point(e){const r=e.currentTarget.getBoundingClientRect();return Math.max(0,Math.min(this.length,(e.clientX-r.left)/r.width*this.length))},
   down(e){if(e.button!==0||!this.length)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);this.drag={x:e.clientX,start:this.point(e),end:this.point(e)}},
   move(e){if(this.drag)this.drag={...this.drag,end:this.point(e)}},
   up(e){if(!this.drag)return;const d=this.drag;this.drag=null;if(Math.abs(e.clientX-d.x)<6){this.$emit('seek',this.point(e));return}const a=Math.min(d.start,d.end),b=Math.max(d.start,d.end);if(b-a<.25)return;this.settings.start=a;this.settings.end=b;this.settings.loop=true;this.apply()},
   rangeStyle(a,b){return {left:(a/this.length*100)+'%',width:((b-a)/this.length*100)+'%'}},
  },
  template:`<section class="practice-training" aria-label="练习控制"><div class="training-toolbar"><label>练习速度 <select v-model.number="settings.rate" @change="apply()" :disabled="busy||!configure" aria-label="练习速度"><option v-for="v in [.5,.6,.7,.75,.8,.85,.9,.95,1,1.1,1.25]" :value="v">{{Math.round(v*100)}}%</option></select></label><span v-if="Math.abs(actualRate-settings.rate)>.005">当前 {{Math.round(actualRate*100)}}%</span><label><input class="ui-toggle" type="checkbox" v-model="settings.loop" @change="apply()" :disabled="settings.end-settings.start<.25">循环选段</label><span v-if="settings.end>settings.start">{{time(settings.start)}}–{{time(settings.end)}}</span><button v-if="settings.end>settings.start" class="mini" @click="$emit('seek',settings.start)">回到起点</button><button v-if="settings.last>3" class="mini" @click="$emit('seek',settings.last)">上次练习 {{time(settings.last)}}</button><details class="training-ramp"><summary>逐步提速</summary><div><label><input class="ui-toggle" type="checkbox" v-model="settings.ramp" @change="apply()">循环后提速</label><label>每 <input type="number" min="1" max="20" v-model.number="settings.every" @change="apply()"> 遍</label><label>提高 <input type="number" min="1" max="10" v-model.number="settings.step" @change="apply()">%</label><label>至 <input type="number" min="50" max="125" v-model.number="settings.target" @change="apply()">%</label><span v-if="settings.loop">已循环 {{cycles}} 遍</span></div></details></div><div class="training-navigation" role="slider" tabindex="0" aria-label="段落与练习范围，点击定位，拖选循环" :aria-valuemin="0" :aria-valuemax="length" :aria-valuenow="current" @keydown.left.prevent="$emit('seek',Math.max(0,current-5))" @keydown.right.prevent="$emit('seek',Math.min(length,current+5))" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="drag=null"><span v-for="s in parts" class="training-segment" :style="{...rangeStyle(s.start,s.end),...sectionStyle(s.label)}" :title="s.name+' '+time(s.start)+'–'+time(s.end)">{{s.name}}</span><span v-if="!parts.length" class="training-no-segments"></span><span v-if="settings.loop" class="training-range" :style="rangeStyle(settings.start,settings.end)"></span><span v-if="drag" class="training-range" :style="rangeStyle(Math.min(drag.start,drag.end),Math.max(drag.start,drag.end))"></span><span class="training-head" :style="{left:percent+'%'}"></span></div><p v-if="error" class="practice-error" role="alert">{{error}}</p></section>`
 };
})(window);
