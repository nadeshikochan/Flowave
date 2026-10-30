(function(root){
 'use strict';
 function read(){return root.FlowaveOutputCalibration?.read()||{enabled:false,savedEnabled:false,offsetMs:0,range:null,output:{transport:'unknown',confirmed:false,id:''}}}
 function save(value,device){if(!root.FlowaveOutputCalibration)throw new Error('设备识别尚未就绪。');root.FlowaveOutputCalibration.save(value,device)}
 const quantile=(sorted,q)=>{const i=(sorted.length-1)*q,a=Math.floor(i);return sorted[a]+(sorted[Math.ceil(i)]-sorted[a])*(i-a)};
 function estimate(values){
  const samples=values.slice(2).filter(Number.isFinite);if(samples.length<10)return {valid:false,message:'继续跟随声音点击，至少再收集 '+Math.max(0,12-values.length)+' 次。'};
  const sorted=samples.slice().sort((a,b)=>a-b),median=quantile(sorted,.5),deviations=samples.map(x=>Math.abs(x-median)).sort((a,b)=>a-b),limit=Math.max(25,3*quantile(deviations,.5)),kept=samples.filter(x=>Math.abs(x-median)<=limit).sort((a,b)=>a-b);
  if(kept.length<10)return {valid:false,message:'稳定点击不足，请重新校准。'};
  const low=quantile(kept,.25),high=quantile(kept,.75),center=quantile(kept,.5);
  if(high-low>100||center<0||center>900)return {valid:false,message:'点击波动较大，请重新校准。'};
  return {valid:true,offsetMs:Math.round(center),range:[Math.round(low),Math.round(high)],kept:kept.length,total:samples.length};
 }
 const tempoCache=new WeakMap(),median=values=>quantile(values.slice().sort((a,b)=>a-b),.5);
 function tempoMap(data){
  if(!data)return [];if(tempoCache.has(data))return tempoCache.get(data);
  const beats=data.beats||[],bars=[],intervals=[];
  for(let i=0;i<beats.length-1;i++){const a=beats[i],b=beats[i+1];if(b[0]<=a[0]||a[3]!==b[3]||!(b[1]===a[1]+1||b[1]===1&&a[1]===a[2]))continue;const bpm=60/(b[0]-a[0])*4/a[3];if(bpm>=15&&bpm<=480)intervals.push(bpm);}
  const downs=beats.map((b,i)=>b[1]===1?i:-1).filter(i=>i>=0);
  for(let j=0;j<downs.length-1;j++){const a=beats[downs[j]],end=beats[downs[j+1]],group=beats.slice(downs[j],downs[j+1]);if(group.length!==a[2]||!group.every((b,i)=>b[1]===i+1&&b[2]===a[2]&&b[3]===a[3])||end[0]<=a[0])continue;const bpm=60*a[2]*4/a[3]/(end[0]-a[0]);if(bpm>=15&&bpm<=480)bars.push({start:a[0],bpm,meter:[a[2],a[3]]});}
  const result=[],duration=Number(data.duration)||beats.at(-1)?.[0]||0;
  if(bars.length){let start=0,values=[bars[0].bpm],meter=bars[0].meter;
   const different=(a,b)=>Math.abs(a-b)>Math.max(3,a*.03);
   for(let i=1;i<bars.length;i++){const current=median(values),a=bars[i],b=bars[i+1];
    if(b&&different(current,a.bpm)&&different(current,b.bpm)&&!different(a.bpm,b.bpm)&&Math.sign(a.bpm-current)===Math.sign(b.bpm-current)){
     result.push({start,end:a.start,bpm:Math.round(current),meter});start=a.start;values=[a.bpm];meter=a.meter;
    }else values.push(a.bpm);
   }result.push({start,end:duration,bpm:Math.round(median(values)),meter});
  }else if(intervals.length)result.push({start:0,end:duration,bpm:Math.round(median(intervals)),meter:[beats[0][2],beats[0][3]]});
  tempoCache.set(data,result);return result;
 }
 function tempoAt(data,time){return tempoMap(data).find(s=>time>=s.start&&time<s.end)||null}
 root.FlowavePracticeTiming={read,save,estimate,tempoAt,tempoMap};
 root.FlowaveBluetoothCalibration={
  props:{active:{type:Boolean,default:true},createOutput:Function},
  data(){return {open:false,running:false,busy:false,values:[],message:'',result:null,current:read(),target:null,request:0,calibrationBpm:120,period:500,choices:[]}},
  watch:{active(v){this.syncOutputLease();if(!v)this.close()}},
  mounted(){this.storageChanged=()=>this.outputChanged();root.addEventListener('flowave-output-calibration',this.storageChanged);this.visibilityChanged=()=>{this.syncOutputLease();if(document.hidden&&this.open){this.stop();this.message='校准已暂停，请重新开始。'}};document.addEventListener('visibilitychange',this.visibilityChanged);this.syncOutputLease()},
  beforeUnmount(){this.outputLeaseRelease?.();this.outputLeaseRelease=null;this.close();document.removeEventListener('visibilitychange',this.visibilityChanged);root.removeEventListener('flowave-output-calibration',this.storageChanged)},
  methods:{
   syncOutputLease(){const needed=this.active&&!document.hidden;if(needed&&!this.outputLeaseRelease)this.outputLeaseRelease=root.FlowaveOutputCalibration?.acquire('calibration-ui');else if(!needed&&this.outputLeaseRelease){const release=this.outputLeaseRelease;this.outputLeaseRelease=null;release()}this.current=read()},
   outputChanged(){this.current=read();const device=this.current.output;if(this.running&&this.calibrationDevice&&(!device.confirmed||device.transport!=='bluetooth'||device.id!==this.calibrationDevice.id)){this.stop();this.result=null;this.message='输出设备已变化，请重新校准。'}else if(this.running&&device.confirmed){if(device.transport!=='bluetooth'){this.stop();this.result=null;this.message='请切换到蓝牙耳机后重新校准。'}else this.calibrationDevice={...device}}else if(this.result?.valid&&this.calibrationDevice&&device.confirmed&&device.id!==this.calibrationDevice.id){this.result=null;this.message='输出设备已变化，请重新校准。'}},
   show(){this.target=root.Vue.markRaw(document.fullscreenElement||document.body);this.open=true;this.values=[];this.result=null;this.message='';this.returnFocus=document.activeElement;this.$nextTick(()=>this.$refs.start?.focus())},
   stop(){this.request=(this.request||0)+1;clearTimeout(this.timeout);this.output?.dispose();this.output=null;this.running=false;this.busy=false},
   close(){this.stop();this.open=false;this.returnFocus?.focus?.()},
   async start(){if(read().output.transport!=='bluetooth'){this.message='请先切换到蓝牙耳机输出。';return}this.stop();this.values=[];this.result=null;this.message='';this.calibrationDevice=null;this.busy=true;const request=this.request;
    try{const output=await this.createOutput();if(request!==this.request||!this.open){output.dispose();return}this.output=output;this.calibrationBpm=Math.max(40,Math.min(300,Number(output.bpm)||120));this.period=60000/this.calibrationBpm*4/(Number(output.denominator)||4);this.anchor=null;this.choices=[];const context=output.context,now=performance.now(),base=context.currentTime;let when=base+.6;this.pulses=[];
     for(let i=0;i<22;i++){this.pulses.push({time:now+(when-base)*1000,used:false});output.click(when,i%(output.meter||4)===0);when+=this.period/1000}
     this.running=true;this.outputChanged();if(!this.running)return;this.timeout=setTimeout(()=>{this.finish()},(when-base)*1000+950);this.$nextTick(()=>this.$refs.pad?.focus());
    }catch(error){if(request===this.request)this.message=error.message||'校准声音无法播放。'}finally{if(request===this.request)this.busy=false}
   },
   tap(event){if(!this.running||event.repeat)return;event.preventDefault();const now=performance.now(),candidates=this.pulses.filter(p=>!p.used&&p.time<=now+60&&now-p.time<=900);const pulse=this.anchor===null?candidates[0]:candidates.sort((a,b)=>Math.abs(now-a.time-this.anchor)-Math.abs(now-b.time-this.anchor))[0];if(!pulse||this.anchor!==null&&Math.abs(now-pulse.time-this.anchor)>Math.min(180,this.period*.45))return;pulse.used=true;const lag=now-pulse.time;if(this.anchor===null)this.anchor=lag;this.values.push(lag);if(this.values.length>=16)this.finish()},
   finish(){this.result=this.calibrationDevice?estimate(this.values):{valid:false,message:'未能确认当前蓝牙输出，请重新开始。'};this.message=this.result.valid?'':this.result.message;if(this.result.valid){this.choices=[];for(let n=-4;n<=4;n++){const offset=Math.round(this.result.offsetMs+n*this.period);if(offset>=0&&offset<=900)this.choices.push(offset)}this.baseResult={...this.result,range:[...this.result.range]}}this.stop()},
   chooseOffset(){const shift=this.result.offsetMs-this.baseResult.offsetMs;this.result.range=this.baseResult.range.map(v=>v+shift)},
   persist(value,device){try{save(value,device);this.current=read();return true}catch(error){this.message=error.message||'保存失败，请检查本地存储后重试。';return false}},
   apply(){if(!this.result?.valid||!this.calibrationDevice)return;if(!this.persist({enabled:true,offsetMs:this.result.offsetMs,range:this.result.range,method:'uniform-song-tap-v2',updated:Date.now()},this.calibrationDevice))return;this.close()},
   toggle(){this.persist({...this.current,enabled:!this.current.savedEnabled})},
   clear(){try{root.FlowaveOutputCalibration.clear();this.current=read()}catch{this.message='校准记录未能清除。'}},
   trap(event){if(event.key!=='Tab')return;const nodes=[...this.$refs.dialog.querySelectorAll('button:not(:disabled),input,select,[tabindex="0"]')];const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}},
  },
  template:`<div class="bt-calibration-entry"><button type="button" class="mini" :disabled="!createOutput||current.output.transport!=='bluetooth'" @click="show">蓝牙耳机校准</button><small v-if="current.output.name">{{current.output.name}} · {{!current.output.confirmed?'等待播放器输出':current.output.transport==='other'?'无需蓝牙补偿':current.enabled?'补偿已启用':'补偿未启用'}}</small><small v-else>{{['checking','not-started'].includes(current.output.reason)?'正在确认输出设备':'暂未确认输出设备，未启用补偿'}}</small><small v-if="current.legacy && current.output.transport==='bluetooth'">原校准未绑定耳机，请重新校准。</small><template v-if="current.configured"><label><input class="ui-toggle" type="checkbox" :checked="current.savedEnabled" @change="toggle">此耳机自动补偿 {{current.offsetMs}} ms</label><button type="button" class="mini" @click="clear">清除</button></template><Teleport v-if="open" :to="target"><div class="bt-calibration-overlay" @keydown.esc.stop.prevent="close" @keydown="trap"><section ref="dialog" class="bt-calibration-dialog" role="dialog" aria-modal="true" aria-labelledby="bt-calibration-title"><header><h2 id="bt-calibration-title">蓝牙耳机校准</h2><button type="button" class="mini" @click="close" aria-label="关闭校准">×</button></header><p>跟随均匀的滴答连续点击，从第一声开始。校准时歌曲会暂停。</p><button ref="pad" type="button" class="bt-calibration-pad" :disabled="!running" @pointerdown="tap" @keydown.space.stop="tap" @keydown.enter.stop="tap" @click.prevent>{{running?'听到声音后点击':'点击下方开始'}}<small>{{values.length}} / 16</small></button><p class="bt-calibration-note">{{calibrationBpm}} BPM · 跟随节奏点击，用于画面同步；换设备后请重新校准。</p><p v-if="message" role="status">{{message}}</p><p v-if="result?.valid">估计补偿 {{result.offsetMs}} ms · 常见区间 {{result.range[0]}}–{{result.range[1]}} ms</p><label v-if="result?.valid && choices.length>1">补偿档位 <select v-model.number="result.offsetMs" @change="chooseOffset"><option v-for="v in choices" :value="v">{{v}} ms</option></select><small>若差整拍，可换一档试听。</small></label><footer><button ref="start" type="button" class="mini" :disabled="busy||current.output.transport!=='bluetooth'" @click="start">{{running?'重新开始':result?'重新校准':'开始校准'}}</button><button v-if="running" type="button" class="mini" @click="finish">结束采集</button><button v-if="result?.valid" type="button" class="primary" @click="apply">应用补偿</button></footer></section></div></Teleport></div>`
 };
})(window);
