(function(root){
 'use strict';

 const sounds=Object.freeze({click:'电子滴答',wood:'木鱼',mechanical:'机械节拍器',hihat:'踩镲'});
 // Locally synthesized one-shots: no samples, downloads or microphone access.
 function makeSound(context,sound,accent,drive=1){
  const rate=context.sampleRate,duration=sound==='hihat'?(accent?.09:.055):.055,buffer=context.createBuffer(1,Math.ceil(rate*duration),rate),data=buffer.getChannelData(0);let seed=123456789,previous=0,peak=0;
  const noise=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2147483648-1};
  for(let i=0;i<data.length;i++){const t=i/rate,attack=Math.min(1,t/.0006);let value;
   if(sound==='wood'){const f=accent?1000:760;value=(Math.sin(2*Math.PI*f*t)+.45*Math.sin(2*Math.PI*f*1.52*t))*Math.exp(-t/ .012)+.25*noise()*Math.exp(-t/.0015)}
   else if(sound==='mechanical'){const hit=(time)=>time<0?0:(.7*Math.sin(2*Math.PI*(accent?1800:1400)*time)+.4*noise())*Math.exp(-time/.004);value=hit(t)+.45*hit(t-.011)}
   else if(sound==='hihat'){const n=noise(),high=n-previous;previous=n;value=(high+.15*Math.sin(2*Math.PI*6107*t)+.12*Math.sin(2*Math.PI*8311*t))*Math.exp(-t/(accent?.02:.012))}
   else {const phase=2*Math.PI*(accent?1500:1050)*t;value=(Math.sin(phase)+.3*Math.sin(phase*3)+.12*Math.sin(phase*5))*Math.exp(-t/.009)}
   data[i]=value*attack*Math.min(1,(duration-t)/.003);peak=Math.max(peak,Math.abs(data[i]));
  }
  const target=(accent?.82:.64);if(peak)for(let i=0;i<data.length;i++){const normalized=data[i]/peak;data[i]=target*(drive>1?Math.tanh(normalized*drive)/Math.tanh(drive):normalized)}return buffer;
 }
 class Metronome {
  constructor({context,destination,readClock,onError}){
   this.context=context;this.readClock=readClock;this.onError=onError;this.nodes=new Set();this.bus=context.createGain();this.bus.connect(destination);this.source=null;this.last=null;this.next=0;this.disposed=false;this.buffers=new Map();this.sound='click';
   this.invalidate=event=>{this.resync();if(['practicecycle','playing'].includes(event?.type)&&!this.disposed){this.loopTolerance=.025;this.tick();this.loopTolerance=0}};
  }
  configure(beats,volume,sound='click'){
   this.setSound(sound);
   this.beats=beats.filter(b=>Array.isArray(b)&&Number.isFinite(b[0])&&b[0]>=0).slice().sort((a,b)=>a[0]-b[0]).filter((b,i,a)=>!i||b[0]>a[i-1][0]);
   this.setVolume(volume);this.resync();clearInterval(this.timer);this.tick();if(!this.disposed)this.timer=setInterval(()=>this.tick(),25);
  }
  setSound(value){const next=Object.hasOwn(sounds,value)?value:'click';if(this.sound!==next){this.sound=next;this.resync()}}
  getSound(sound,accent){const drive=1+Math.max(0,this.volume-100)/50,key=sound+':'+accent+':'+drive;if(!this.buffers.has(key))this.buffers.set(key,makeSound(this.context,sound,accent,drive));return this.buffers.get(key)}
  setVolume(value){const volume=Math.max(0,Math.min(200,Number(value)||0));if(Math.max(100,volume)!==Math.max(100,this.volume||0))this.buffers.clear();this.volume=volume;this.bus.gain.setTargetAtTime((Math.min(100,this.volume)/100)**1.25*2.5,this.context.currentTime,.008)}
  bind(source){
   if(this.source===source)return;for(const event of ['pause','seeking','seeked','ended','ratechange','waiting','playing','practicecycle'])this.source?.removeEventListener(event,this.invalidate);
   this.source=source;for(const event of ['pause','seeking','seeked','ended','ratechange','waiting','playing','practicecycle'])source?.addEventListener(event,this.invalidate);this.resync();
  }
  resync(){
   this.last=null;for(const record of this.nodes){try{record.osc.stop()}catch{}record.osc.disconnect();record.gain.disconnect()}this.nodes.clear();
  }
  locate(time){let lo=0,hi=this.beats.length;while(lo<hi){const mid=(lo+hi)>>>1;if(this.beats[mid][0]<time)lo=mid+1;else hi=mid}return lo}
  tick(){
   if(this.disposed)return;
   if(this.context.state==='closed'){this.onError?.('节拍器音频输出已关闭，请重新开启。');this.dispose();return}
   const clock=this.readClock();this.bind(clock.source);const now=this.context.currentTime,rate=Number(clock.rate)||1;
   if(!clock.playing||this.context.state!=='running'){this.resync();return}
   const delay=Math.max(0,Number(clock.delay)||0),time=Number(clock.time);
   if(!Number.isFinite(time)||rate<=0){this.resync();return}
   if(this.last&&(Math.abs(time-(this.last.time+Math.max(0,now-this.last.context-this.last.delay)*this.last.rate))>.06||rate!==this.last.rate||now-this.last.context>.25))this.resync();
   if(!this.last)this.next=this.locate(time-(this.loopTolerance||.008));
   this.last={time,context:now,rate,delay};
   const horizon=Math.min(time+Math.max(0,.12-delay)*rate,Number.isFinite(clock.loopEnd)?clock.loopEnd-.000001:Infinity);
   while(this.next<this.beats.length&&this.beats[this.next][0]<=horizon){const beat=this.beats[this.next++],when=now+delay+(beat[0]-time)/rate;if(when>=now-(this.loopTolerance||.008)&&this.volume>0)this.click(Math.max(now+.002,when),beat[1]===1,this.sound,beat[4]??1)}
  }
  click(when,accent,sound=this.sound,level=1){
   sound=Object.hasOwn(sounds,sound)?sound:'click';
   const osc=this.context.createBufferSource(),gain=this.context.createGain(),record={osc,gain};osc.buffer=this.getSound(sound,accent);osc.connect(gain);gain.connect(this.bus);this.nodes.add(record);
   gain.gain.value=Math.max(0,Math.min(1,Number(level)||0));
   osc.onended=()=>{this.nodes.delete(record);osc.disconnect();gain.disconnect()};osc.start(when);osc.stop(when+osc.buffer.duration);
  }
  dispose(){if(this.disposed)return;this.disposed=true;clearInterval(this.timer);this.bind(null);this.resync();this.bus.disconnect()}
 }
 Metronome.sounds=sounds;root.FlowaveMetronome=Metronome;
})(window);
