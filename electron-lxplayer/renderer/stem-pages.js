(function(root){
  'use strict';
  const SECONDS=20, AHEAD=4;
  class StemPages {
    constructor(context,base,detail){
      Object.assign(this,{context,base,detail,seconds:SECONDS,duration:detail.samples/detail.sample_rate});
      this.names=Object.keys(detail.stems);this.cache=new Map();this.pending=new Map();
      this.controller=new AbortController();this.closed=false;
    }
    cancel(){this.controller.abort();this.controller=new AbortController();this.pending.clear();}
    close(){this.closed=true;this.cancel();this.cache.clear();}
    async get(page){
      if(this.closed)throw new DOMException('伴奏已释放。','AbortError');
      if(this.cache.has(page)){const value=this.cache.get(page);this.cache.delete(page);this.cache.set(page,value);return value}
      if(this.pending.has(page))return this.pending.get(page);
      const signal=this.controller.signal;
      const task=this.load(page,signal).then(value=>{
        signal.throwIfAborted();if(this.closed)throw new DOMException('伴奏已释放。','AbortError');
        this.cache.set(page,value);while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value);return value;
      }).finally(()=>{if(this.pending.get(page)===task)this.pending.delete(page)});
      this.pending.set(page,task);return task;
    }
    async load(page,signal){
      const buffers={},rate=this.context.sampleRate;
      const frames=Math.min(SECONDS*rate,Math.ceil(this.duration*rate)-page*SECONDS*rate);
      if(!(frames>0))throw new Error('音轨分段范围无效。');
      let index=0;
      const worker=async()=>{while(index<this.names.length){
        signal.throwIfAborted();const name=this.names[index++];
        const url=this.base+'/stems/page/'+encodeURIComponent(this.detail.id)+'/'+encodeURIComponent(this.detail.generation)+'/'+encodeURIComponent(name)+'?page='+page+'&sample_rate='+rate;
        const response=await fetch(url,{signal,headers:window.FlowaveBackendAccess?.headers(url)});
        if(!response.ok)throw new Error('伴奏分段无法读取，请切回原曲后重新载入。');
        const raw=await response.arrayBuffer();signal.throwIfAborted();
        if(raw.byteLength!==frames*8)throw new Error('音轨分段时轴不一致，已停止伴奏。');
        const pcm=new DataView(raw),buffer=this.context.createBuffer(2,frames,rate);
        for(let channel=0;channel<2;channel++){
          const out=buffer.getChannelData(channel);
          for(let i=0;i<frames;i++){const sample=pcm.getFloat32((i*2+channel)*4,true);if(!Number.isFinite(sample))throw new Error('音轨包含无效采样。');out[i]=sample}
        }
        buffers[name]=buffer;
      }};
      // Drain both readers on failure; never publish a partial page.
      const outcomes=await Promise.allSettled([worker(),worker()]);
      const failed=outcomes.find(v=>v.status==='rejected');if(failed)throw failed.reason;
      signal.throwIfAborted();return buffers;
    }
  }
  class PagedStemPlayer extends root.FlowaveStemPlayer.StemPlayer {
    constructor(...args){super(...args);this.pages=this.buffers.pages;this.streamGeneration=0;}
    stopNodes(){
      this.streamGeneration++;this.pages?.cancel();super.stopNodes();
    }
    dispose(){super.dispose();this.pages.close();}
    nextSlice(at){
      const region=this.practiceRegion;if(region&&at>=region.end-1e-7)at=region.start;
      if(at>=this.duration-1e-7)return null;
      const page=Math.floor(at/SECONDS);
      return {page,at,end:Math.min((page+1)*SECONDS,this.duration,region?.end??this.duration)};
    }
    async schedule(){
      const generation=++this.streamGeneration;
      const valid=()=>generation===this.streamGeneration&&!this.disposed&&!this.paused;
      this.error=null;this.stretchWaiting=true;this.started=Infinity;this.event('waiting');
      try {
        // Preload the complete first scheduling horizon before starting the clock.
        let at=this.offset,covered=0;const visited=new Set();
        while(covered<AHEAD*this.rate){const slice=this.nextSlice(at);if(!slice)break;
          if(visited.has(slice.page))break;visited.add(slice.page);
          await this.pages.get(slice.page);if(!valid())return;
          covered+=slice.end-slice.at;at=slice.end;
        }
        if(!valid())return;
        const begin=Math.ceil((this.context.currentTime+.12)*this.context.sampleRate/128)*128/this.context.sampleRate;
        this.stretchWaiting=false;this.setupGraph(begin);this.lastProgress=this.context.currentTime;
        this.queueTime=begin;this.queuePosition=this.offset;
        let pumping=false;
        const pump=async()=>{
          if(pumping||!valid())return;pumping=true;
          try {
            while(valid()&&this.queueTime<this.context.currentTime+AHEAD){
              const slice=this.nextSlice(this.queuePosition);if(!slice)break;
              const buffers=await this.pages.get(slice.page);if(!valid())return;
              if(this.queueTime<this.context.currentTime+.003)throw new Error('伴奏读取未能及时完成，已暂停以保持音轨同步。请重新播放或切回原曲。');
              const length=slice.end-slice.at;
              for(const name of this.pages.names){
                const node=this.context.createBufferSource();node.buffer=buffers[name];
                node.playbackRate.value=this.rate;node.connect(this.gains[name]);
                node.onended=()=>{node.disconnect();const i=this.sources.indexOf(node);if(i>=0)this.sources.splice(i,1)};
                node.start(this.queueTime,slice.at-slice.page*SECONDS,length);this.sources.push(node);
              }
              this.queueTime+=length/this.rate;this.queuePosition=slice.end;
            }
          } catch(error){if(valid()){this.pause();this.error={message:error.message};this.event('error')}}
          finally{pumping=false}
        };
        await pump();if(!valid())return;
        this.timer=setInterval(()=>{
          if(!valid())return;
          const region=this.practiceRegion;
          if(region&&!this.stretchWaiting){
            const raw=this.offset+Math.max(0,this.context.currentTime-this.started)*this.rate;
            const cycle=raw>=region.end?1+Math.floor((raw-region.end)/(region.end-region.start)):0;
            if(cycle!==this.practiceCycle){this.practiceCycle=cycle;this.event('practicecycle');if(!valid())return}
          } else if(this.currentTime>=this.duration){
            this.stopNodes();this.offset=this.loop?0:this.duration;
            if(this.loop)this.schedule();else{this.paused=true;this.ended=true;this.event('ended')}
            this.event('timeupdate');return;
          }
          this.progress();void pump();
        },50);
        if(this.rate===1)this.event('playing');
      } catch(error){if(valid()){this.pause();this.error={message:error.message};this.event('error')}}
    }
  }
  root.FlowaveStemPages=StemPages;root.FlowavePagedStemPlayer=PagedStemPlayer;
})(window);
