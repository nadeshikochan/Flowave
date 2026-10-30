(function(root){
 'use strict';
 const NS='http://www.w3.org/2000/svg', storage='lx-practice-information-display';
 const defaults={bars:true,beats:true,chords:true,melody:true,key:true,bpm:true,meter:true,notation:'staff',chordFormat:'name',perLine:4,chordColors:true};
 const letters='CDEFGAB', naturals=[0,2,4,5,7,9,11];
 const notePC=s=>{const m=/^([A-G])([#b]*)$/.exec(s||'');if(!m)return null;const letter=letters.indexOf(m[1]);return {letter,pc:(naturals[letter]+[...m[2]].reduce((a,c)=>a+(c==='#'?1:-1),0)+24)%12}};
 function keyOf(label){const [tonic,mode]=(label||'').split(':'),p=notePC(tonic);return p&&['major','minor'].includes(mode)?{...p,tonic,mode}:null}
 function degree(name,key){const p=notePC(name);if(!p||!key)return null;const n=(p.letter-key.letter+7)%7,scale=key.mode==='minor'?[0,2,3,5,7,8,10]:naturals;let d=(p.pc-key.pc-scale[n]+24)%12;if(d>6)d-=12;return (d>=0?'♯'.repeat(d):'♭'.repeat(-d))+(n+1)}
 function chordText(label,key,format){
  if(['N','X'].includes(label))return label==='N'?'—':'未知';
  const m=/^([A-G][#b]*)(?::([^/]+))?(?:\/(.+))?$/.exec(label);if(!m)return label;
  let suffix=m[2]||'maj',bass='';
  if(m[3]){const i=/^([b#]*)([1-9]\d*)$/.exec(m[3]);let p=m[3];if(i){const r=notePC(m[1]),n=(Number(i[2])-1)%7,li=(r.letter+n)%7,pc=(r.pc+naturals[n]+[...i[1]].reduce((a,c)=>a+(c==='#'?1:-1),0)+24)%12;let d=(pc-naturals[li]+12)%12;if(d>6)d-=12;p=letters[li]+(d>=0?'#'.repeat(d):'b'.repeat(-d))}bass='/'+(format==='degree'&&key?(degree(p,key)||p):p)}
  let quality=suffix==='maj'?'':suffix==='min'?'m':suffix.replace(/^min/,'m');if(format==='degree'&&key&&/^\d+$/.test(quality))quality=[...quality].map(v=>'⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(v)]).join('');
  return (format==='degree'&&key?degree(m[1],key):m[1])+quality+bass;
 }
 function buildBars(data){
  const beats=data.beats||[],downs=beats.map((b,i)=>b[1]===1?i:-1).filter(i=>i>=0),bars=[];let number=0;
  if(!downs.length)return [];
  if(beats[downs[0]][0]>0)bars.push({start:0,end:beats[downs[0]][0],number:null,valid:false});
  for(let j=0;j<downs.length;j++){const from=downs[j],to=downs[j+1]??beats.length,group=beats.slice(from,to),first=group[0],end=beats[to]?.[0]??data.duration;
   if(end<=first[0])continue;
   // A truncated prediction still has usable timing and melody. Engrave its
   // observed beats as an incomplete measure; never invent missing beats or
   // stretch those notes to the nominal meter. Keep true sequence errors invalid.
   const sequential=group.length<=first[2]&&group.every((b,i)=>b[1]===i+1&&b[2]===first[2]&&b[3]===first[3]&&(i===0||b[0]>group[i-1][0]));
   const valid=to<beats.length&&sequential;
   bars.push({start:first[0],end,number:valid?++number:null,valid,partial:valid&&group.length<first[2],meter:[first[2],first[3]],beats:group});
  }return bars;
 }


 const degreeColors=['#cf5f69','#b77b32','#9b8a28','#4c936b','#5184c5','#9571bb','#b8689c'];
 function chordColor(label,key){const rootNote=/^([A-G][#b]*)(?::|\/|$)/.exec(label||'');if(!rootNote||!key)return null;const d=degree(rootNote[1],key);return degreeColors[Number(d?.match(/[1-7]$/)?.[0])-1]||null}
 // Compare ledger-line cost over the entire song, weighted by sounding duration.
 // A small isolated low note must not change the clef of the following row.
 function melodyClef(notes){
  let treble=0,bass=0;
  for(const n of notes||[]){if(!Number.isFinite(n[2])||!(n[1]>n[0]))continue;
   const midi=Math.round(n[2]),pc=((midi%12)+12)%12;
   const diatonic=Math.floor(midi/12)*7+[0,0,1,1,2,3,3,4,4,5,5,6][pc];
   const weight=n[1]-n[0],cost=(lo,hi)=>Math.max(0,lo-diatonic-1,diatonic-hi-1);
   treble+=weight*cost(37,45);bass+=weight*cost(25,33);
  }
  return bass+0.01<treble?'bass':'treble';
 }
 // A separate display grid preserves the original predictions and source timestamps.
 function engrave(svg,bars,payload,keyAt,prefs){
  const V=root.Vex.Flow,host=document.createElement('div'),renderer=new V.Renderer(host,V.Renderer.Backends.SVG);
  const ctx=renderer.getContext(),anchors=[],all=[],bounds=[];
  const color=getComputedStyle(svg).getPropertyValue('--text').trim()||'#333';ctx.setFillStyle(color);ctx.setStrokeStyle(color);
  const spell=(p,key)=>root.FlowavePracticeNoteLayout.spellPitch(p,key);
  const clef=melodyClef(payload.notes);
  const at=(b,u,subdivision)=>{const pts=b.beats.map(x=>x[0]).concat(b.end),i=Math.min(pts.length-2,Math.floor(u/subdivision));return pts[i]+(pts[i+1]-pts[i])*(u/subdivision-i)};
  const prepared=bars.map((b,bi)=>{
   const k=keyAt(b.start),sig=k?k.tonic+(k.mode==='minor'?'m':''):'C',stave=new V.Stave(20,82,300);
   stave.setBegBarType(V.Barline.type.NONE).setEndBarType(V.Barline.type.NONE);
   stave.setClefLines(clef);if(!bi)stave.addClef(clef);
   const previous=bi?keyAt(b.start-.000001):null;
   if(!bi||previous?.tonic!==k?.tonic||previous?.mode!==k?.mode)stave.addKeySignature(sig,previous?previous.tonic+(previous.mode==='minor'?'m':''):undefined);
   const tempo=root.FlowavePracticeTiming?.tempoMap(payload).find(s=>s.start>=b.start&&s.start<b.end);
   if(prefs.bpm&&tempo)stave.setTempo({duration:'q',bpm:tempo.bpm},-15);
   if((!bi||bars[bi-1].meter?.join('/')!==b.meter?.join('/'))&&b.valid)stave.addTimeSignature(b.meter.join('/'));
   if(!b.valid)return {b,stave,min:160,events:[]};
   const {cells,subdivision}=root.FlowavePracticeNoteLayout.quantizeBar(b,payload.notes);const count=cells.length;if(!count)return {b,stave,min:160,events:[],unreadable:true};
   const notes=[],events=[];let u=0;
   while(u<count){const item=cells[u];let end=u+1;while(end<count&&cells[end]?.id===item?.id)end++;
    while(u<end){const remaining=end-u,beatRoom=subdivision-u%subdivision;
     const quarterUnits=subdivision*b.meter[1]/4;
     const len=[4,3,2,1.5,1,.75,.5,.375,.25,.1875,.125,.09375,.0625].map(n=>n*quarterUnits).find(n=>Number.isInteger(n)&&n<=remaining&&(u%subdivision===0||n<=beatRoom));
     const ticks=len/quarterUnits;
     const rhythm=[[4,'w',false],[3,'h',true],[2,'h',false],[1.5,'q',true],[1,'q',false],[.75,'8',true],[.5,'8',false],[.375,'16',true],[.25,'16',false],[.1875,'32',true],[.125,'32',false],[.09375,'64',true],[.0625,'64',false]].find(v=>Math.abs(v[0]-ticks)<1e-6);
     if(!rhythm)throw new Error('当前拍号暂不支持记谱');
     const rest=clef==='bass'?(rhythm[1]==='w'?'f/3':'d/3'):(rhythm[1]==='w'?'d/5':'b/4');
     const note=new V.StaveNote({clef,keys:[item?spell(item.n[2],keyAt(Math.max(b.start,item.n[0]))):rest],duration:rhythm[1]+(rhythm[2]?'d':'')+(item?'':'r'),auto_stem:true,align_center:!item&&u===0&&len===count});if(rhythm[2])V.Dot.buildAndAttach([note]);
     notes.push(note);events.push({note,item,start:at(b,u,subdivision),end:at(b,u+len,subdivision)});u+=len;
    }
   }
   // Reset accidental state at each in-bar key change. A signature is placed
   // before the next notated event; held pitches keep their original MIDI value.
   const tickables=[],chunks=[];let signature=sig,chunk=[];
   for(const event of events){const local=keyAt(event.start),next=local?local.tonic+(local.mode==='minor'?'m':''):'C';
    if(next!==signature){if(chunk.length)chunks.push({signature,notes:chunk});chunk=[];tickables.push(new V.KeySigNote(next,signature).setStave(stave));signature=next}
    tickables.push(event.note);chunk.push(event.note);
   }
   if(chunk.length)chunks.push({signature,notes:chunk});
   for(const part of chunks){const accidentalVoice=new V.Voice({num_beats:b.meter[0],beat_value:b.meter[1]}).setStrict(false).addTickables(part.notes);V.Accidental.applyAccidentals([accidentalVoice],part.signature)}
   const voice=new V.Voice({num_beats:b.beats.length,beat_value:b.meter[1]}).addTickables(tickables);
   const ticks=b.beats.map(()=>new V.GhostNote({duration:String(b.meter[1])}));
   const grid=new V.Voice({num_beats:b.beats.length,beat_value:b.meter[1]}).addTickables(ticks);
   const beams=V.Beam.generateBeams(notes,{groups:[new V.Fraction(b.meter[1]===8&&b.meter[0]%3===0?3:1,b.meter[1])]});
   const formatter=new V.Formatter().joinVoices([voice,grid]);formatter.preCalculateMinTotalWidth([voice,grid]);
   return {b,stave,voice,grid,ticks,events,beams,formatter,min:Math.max(130,formatter.getMinTotalWidth()+stave.getNoteStartX()-stave.getX()+38)};
  });
  const minimum=prepared.reduce((sum,p)=>sum+p.min,0),total=Math.max(1160,minimum),scale=1160/total;renderer.resize(total+40,260);let left=20;
  for(const p of prepared){const {b,stave,voice,grid,events,formatter}=p,w=p.min+(total-minimum)/prepared.length;stave.setX(left).setWidth(w).setContext(ctx).draw();
   bounds.push({left:left*scale+20,right:(left+w)*scale+20});
   if(!voice){ctx.save();ctx.setFont('Arial',12,'');ctx.fillText(p.unreadable?'旋律待核':'拍点待核',stave.getNoteStartX()+8,150);ctx.restore();anchors.push([b.start,stave.getNoteStartX()],[b.end,left+w-5]);left+=w;continue}
   grid.setStave(stave);formatter.formatToStave([voice,grid],stave);voice.draw(ctx,stave);grid.draw(ctx,stave);p.beams.forEach(v=>v.setContext(ctx).draw());
   p.ticks.forEach((tick,i)=>anchors.push([b.beats[i][0],tick.getAbsoluteX()]));
   for(const e of events){if(!e.note.isCenterAligned())anchors.push([e.start,e.note.getAbsoluteX()]);if(e.item){const el=host.querySelector('[id="'+e.note.getAttribute('id')+'"]')||host.querySelector('#vf-'+e.note.getAttribute('id'));if(el){el.classList.add('ps-engraved-note');el.dataset.noteStart=e.item.n[0];el.dataset.noteEnd=e.item.n[1]}}all.push(e)}
   anchors.push([b.end,left+w-5]);left+=w;
  }
  for(let i=0;i<all.length;i++){const e=all[i];if(!e.item)continue;const next=all[i+1];if(next?.item?.id===e.item.id&&Math.abs(next.start-e.end)<.001)new V.StaveTie({first_note:e.note,last_note:next.note,first_indices:[0],last_indices:[0]}).setContext(ctx).draw();
   if(i===0&&e.item.n[0]<bars[0].start-.01)new V.StaveTie({last_note:e.note,last_indices:[0]}).setContext(ctx).draw();
   if(i===all.length-1&&e.item.n[1]>bars.at(-1).end+.01)new V.StaveTie({first_note:e.note,first_indices:[0]}).setContext(ctx).draw();
  }
  const layer=document.createElementNS(NS,'g');layer.classList.add('ps-engraving');layer.setAttribute('transform',`translate(20 ${82*(1-scale)}) scale(${scale})`);layer.append(...host.querySelector('svg').childNodes);svg.append(layer);
  const points=anchors.sort((a,b)=>a[0]-b[0]).filter((p,i,a)=>!i||p[0]!==a[i-1][0]).map(p=>[p[0],p[1]*scale+20]);
  const x=time=>{const i=points.findIndex((p,j)=>j<points.length-1&&time>=p[0]&&time<points[j+1][0]);if(i<0)return time>=points.at(-1)[0]?points.at(-1)[1]:points[0][1];const a=points[i],b=points[i+1];return a[1]+(b[1]-a[1])*(time-a[0])/(b[0]-a[0])};
  return {x,bounds,staffTop:82+30*scale,staffBottom:82+70*scale};
 }
 root.FlowavePracticeNotation={buildBars,chordText,keyOf,chordColor,melodyClef};
 root.FlowavePracticeScore={
  components:{...(root.FlowaveBluetoothCalibration?{'bluetooth-calibration':root.FlowaveBluetoothCalibration}:{}),...(root.FlowaveTrainingControls?{'training-controls':root.FlowaveTrainingControls}:{})},
  props:{configureTraining:Function,songKey:String,segments:Array,duration:Number,createCalibrationOutput:Function,previewMetronome:Function,setMetronomeSound:Function,configureMetronome:Function,setMetronomeVolume:Function,active:Boolean,path:String,analysis:Object,loading:Boolean,error:String,readClock:Function,currentTime:Number,playing:Boolean},
  emits:['seek'],
  data(){let prefs={...defaults};try{const p=JSON.parse(localStorage.getItem(storage)||'{}');for(const k of Object.keys(defaults))if(typeof p[k]===typeof defaults[k])prefs[k]=p[k]}catch{}if(![2,4,8].includes(prefs.perLine))prefs.perLine=4;if(!['staff','names','numbers'].includes(prefs.notation))prefs.notation='staff';if(!['name','degree'].includes(prefs.chordFormat))prefs.chordFormat='name';let metronome={volume:50,sound:'click'};try{const saved=JSON.parse(localStorage.getItem('lx-practice-metronome')||'{}');if(Number.isFinite(saved.volume))metronome.volume=Math.max(0,Math.min(200,saved.volume));if(['click','wood','mechanical','hihat'].includes(saved.sound))metronome.sound=saved.sound}catch{}return {subdivision:1,strong:100,weak:75,bars:[],metronomeRequest:0,metronomeOn:false,metronomeSound:metronome.sound,metronomeVolume:metronome.volume,metronomeError:'',prefs,follow:true,page:0,keyLabel:'—',bpmLabel:'—',meterLabel:'—',focus:false,fullscreenError:'',settingsOpen:false,displayTime:0};},
  computed:{available(){return this.analysis?.status==='ready'&&!!this.analysis.analysis},payload(){return this.available?this.analysis.analysis:null},statusText(){return this.error||this.analysis?.message||({missing:'这首歌还没有保存的演奏分析。分轨伴奏仍可使用。',outdated:'歌曲已变化，原演奏分析暂不可用。',unsupported:'请选择音乐库中的本地歌曲。'})[this.analysis?.status]||'演奏分析暂不可用。'},layerOptions(){return {bars:'小节线',beats:'拍线',chords:'和弦条',melody:'主旋律',key:'调性',bpm:'BPM',meter:'拍号'}}},
  watch:{songKey(){this.restoreSong();this.resetScene()},analysis(){this.stopMetronome();this.resetScene()},path(){this.stopMetronome();this.follow=true;this.page=0;this.resetScene()},active(v){if(v)this.refreshFrame();else {this.stopMetronome();this.stopFrame();this.leaveFullscreen()}},playing(){this.refreshFrame()},currentTime(){this.refreshFrame()}},
  mounted(){this.restoreSong();this.scene='';this.calibration=root.FlowavePracticeTiming?.read();this.raf=0;this.resize=new ResizeObserver(()=>this.refreshFrame());this.resize.observe(this.$el);this.visibility=()=>{this.stopFrame();if(!document.hidden)this.refreshFrame()};document.addEventListener('visibilitychange',this.visibility);this.fullscreenChanged=()=>{this.focus=document.fullscreenElement===this.$el;this.fullscreenError='';this.refreshFrame()};document.addEventListener('fullscreenchange',this.fullscreenChanged);this.calibrationStarted=()=>this.stopMetronome();root.addEventListener('flowave-calibration-start',this.calibrationStarted);this.calibrationChanged=()=>{this.calibration=root.FlowavePracticeTiming?.read();this.refreshFrame()};root.addEventListener('flowave-output-calibration',this.calibrationChanged);this.escape=e=>{if(e.key==='Escape'){this.leaveFullscreen();this.settingsOpen=false}};document.addEventListener('keydown',this.escape);this.resetScene();this.themeObserver=new MutationObserver(()=>{this.scene='';this.rowScenes=[];if(this.active)this.refreshFrame(true)});this.themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']})},
  beforeUnmount(){this.themeObserver?.disconnect();root.removeEventListener('flowave-calibration-start',this.calibrationStarted);root.removeEventListener('flowave-output-calibration',this.calibrationChanged);this.stopMetronome();this.leaveFullscreen();document.removeEventListener('fullscreenchange',this.fullscreenChanged);this.stopFrame();this.resize?.disconnect();document.removeEventListener('visibilitychange',this.visibility);document.removeEventListener('keydown',this.escape)},
  methods:{
   restoreSong(){if(!this.songKey)return;this.prefs={...defaults};try{const global=JSON.parse(localStorage.getItem(storage)||'{}');for(const k of Object.keys(defaults))if(typeof global[k]===typeof defaults[k])this.prefs[k]=global[k]}catch{}try{const v=JSON.parse(localStorage.getItem(storage+':'+this.songKey)||'{}');for(const k of Object.keys(defaults))if(typeof v.prefs?.[k]===typeof defaults[k])this.prefs[k]=v.prefs[k];if(![2,4,8].includes(this.prefs.perLine))this.prefs.perLine=4;this.subdivision=[1,2,3,4].includes(v.subdivision)?v.subdivision:1;this.strong=Math.max(0,Math.min(100,v.strong??100));this.weak=Math.max(0,Math.min(100,v.weak??75));if(Number.isFinite(v.volume))this.metronomeVolume=Math.max(0,Math.min(200,v.volume));if(['click','wood','mechanical','hihat'].includes(v.sound))this.metronomeSound=v.sound}catch{}},
   saveSong(){if(!this.songKey)return;try{localStorage.setItem(storage+':'+this.songKey,JSON.stringify({prefs:this.prefs,subdivision:this.subdivision,strong:this.strong,weak:this.weak,volume:this.metronomeVolume,sound:this.metronomeSound}))}catch{}},
   metronomeBeats(){const result=[];for(const b of this.bars||[]){if(!b.valid)continue;const step=this.subdivision===1?1:b.meter[1]/(4*this.subdivision);for(let at=0;at<b.beats.length-1e-6;at+=step){const i=Math.floor(at),f=at-i,a=b.beats[i][0],end=b.beats[i+1]?.[0]??b.end;result.push([a+(end-a)*f,at===0?1:0,b.meter[0],b.meter[1],(at===0?this.strong:this.weak*(Math.abs(at-Math.round(at))<.0001?1:.65))/100])}}return result},
   async patternChanged(){this.saveSong();if(this.metronomeOn){this.stopMetronome();await this.toggleMetronome()}},
   stopMetronome(){++this.metronomeRequest;this.metronomeOn=false;this.configureMetronome?.({enabled:false})?.catch?.(()=>{})},
   async toggleMetronome(){
    if(this.metronomeOn){this.stopMetronome();return}this.metronomeError='';
    const beats=this.metronomeBeats();
    if(!beats.length||!this.configureMetronome)return;
    const request=++this.metronomeRequest;this.metronomeOn=true;
    try{await this.configureMetronome({enabled:true,beats,volume:this.metronomeVolume,sound:this.metronomeSound,onError:message=>{if(request===this.metronomeRequest){this.metronomeOn=false;this.metronomeError=message}}});if(request===this.metronomeRequest&&this.metronomeOn){this.setMetronomeVolume?.(this.metronomeVolume);this.setMetronomeSound?.(this.metronomeSound)}}
    catch(error){if(request===this.metronomeRequest){this.metronomeOn=false;this.metronomeError=error.message||'节拍器未能开启。'}}
   },
   saveMetronome(){this.saveSong();try{localStorage.setItem('lx-practice-metronome',JSON.stringify({sound:this.metronomeSound,volume:this.metronomeVolume}))}catch{}},
   metronomeVolumeChanged(){this.saveMetronome();this.setMetronomeVolume?.(this.metronomeVolume)},
   metronomeSoundChanged(){this.saveMetronome();this.setMetronomeSound?.(this.metronomeSound)},
   async previewMetronomeSound(){this.metronomeError='';try{await this.previewMetronome?.({sound:this.metronomeSound,volume:this.metronomeVolume})}catch(error){this.metronomeError=error.message||'试音未能播放。'}},
   stopFrame(){cancelAnimationFrame(this.raf||0);this.raf=0},
   resetScene(){this.stopFrame();this.bars=root.Vue.markRaw(this.payload?buildBars(this.payload):[]);this.scene='';this.rowScenes=[];this.$nextTick(()=>this.refreshFrame(true))},
   clock(){const c=this.readClock?.();return c&&c.path===this.path?c:{path:this.path,time:this.currentTime||0,playing:false}},
   refreshFrame(force=false){if(!this.active||document.hidden||!this.available){this.stopFrame();return}const c=this.clock(),adjustment=this.calibration,raw=Number(c.time)||0,offset=c.playing&&adjustment?.enabled?adjustment.offsetMs/1000*(Number(c.rate)||1):0;this.paint(Math.max(0,raw-offset),force);if((c.playing||this.playing)&&!this.raf)this.raf=requestAnimationFrame(()=>{this.raf=0;this.refreshFrame()})},
   changed(){this.saveSong();try{localStorage.setItem(storage,JSON.stringify(this.prefs))}catch{}this.scene='';this.refreshFrame(true)},
   defaults(){this.prefs={...defaults};this.changed()},
   keyAt(t){return keyOf(this.payload?.keys?.find(k=>k[0]<=t&&k[1]>t)?.[2])},
   browse(delta){
    const bars=this.bars||[],perLine=this.prefs.perLine,time=Number(this.clock().time)||0;
    const visible=this.follow&&this.maps?.some(map=>map&&time>=map.start&&time<map.end);
    const current=visible?bars.findIndex(bar=>bar.start<=time&&time<bar.end):-1;
    const base=current>=0?Math.floor(current/perLine)*perLine:Math.floor(this.page/perLine)*perLine;
    const last=Math.max(0,Math.ceil(bars.length/perLine)-1)*perLine;
    this.follow=false;this.page=Math.max(0,Math.min(last,base+Math.sign(delta)*perLine));this.refreshFrame();
   },
   resumeFollow(){this.follow=true;this.refreshFrame(true)},
   async focusToggle(){try{if(document.fullscreenElement===this.$el)await document.exitFullscreen();else await this.$el.requestFullscreen();}catch{this.fullscreenError='无法进入全屏，请重试。'}},
   leaveFullscreen(){if(document.fullscreenElement===this.$el)document.exitFullscreen().catch(()=>{})},
   paint(t,force){
    this.displayTime=t;if(!this.payload||!this.$refs.lines)return;
    const bars=this.bars||[],found=bars.findIndex(b=>b.start<=t&&b.end>t),index=found>=0?found:t>=(bars.at(-1)?.end||0)?Math.max(0,bars.length-1):0,group=Math.floor(index/this.prefs.perLine);
    // The current line stays in its physical row. Only the finished row is recycled.
    const groups=this.follow?(group%2===0?[group,group+1]:[group+1,group]):[Math.floor(this.page/this.prefs.perLine),Math.floor(this.page/this.prefs.perLine)+1];
    const key=this.keyAt(t);this.keyLabel=key?key.tonic+(key.mode==='major'?' 大调':' 小调'):'—';
    const bar=bars[index];this.meterLabel=bar?.valid?bar.meter.join('/'):'—';
    const tempo=root.FlowavePracticeTiming?.tempoAt(this.payload,t);this.bpmLabel=tempo?String(Math.round(tempo.bpm*(Number(this.clock().rate)||1))):'—';
    const fingerprint=JSON.stringify([groups,this.prefs]);
    if(force||fingerprint!==this.scene){this.scene=fingerprint;this.maps ||= [];this.rowScenes ||= [];const svgs=this.$refs.lines.querySelectorAll('svg');for(let row=0;row<2;row++){const stamp=JSON.stringify([groups[row],this.prefs]);if(force||this.rowScenes[row]!==stamp){this.renderLine(svgs[row],groups[row]*this.prefs.perLine,t,row);this.rowScenes[row]=stamp}}}
    const svgs=this.$refs.lines.querySelectorAll('svg');for(let row=0;row<2;row++){const svg=svgs[row],map=this.maps?.[row],head=svg.querySelector('.ps-cursor');if(!head||!map)continue;const visible=t>=map.start&&t<map.end;head.style.display=visible?'':'none';if(visible){const x=map.x(t);head.setAttribute('x1',x);head.setAttribute('x2',x)}for(const n of svg.querySelectorAll('[data-note-start]'))n.classList.toggle('ps-note-current',+n.dataset.noteStart<=t&&+n.dataset.noteEnd>t);}
   },
   renderLine(svg,startIndex,t,row){
    svg.replaceChildren();const bars=(this.bars||[]).slice(startIndex,startIndex+this.prefs.perLine),h=this.prefs.melody?260:104;svg.setAttribute('viewBox',`0 0 1200 ${h}`);
    const add=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;svg.append(e);return e};
    if(!bars.length){add('text',{x:20,y:50,class:'ps-sub'},this.bars?.length?'曲终':'拍点不足，暂不生成小节谱面。');this.maps[row]=null;return}
    const start=bars[0].start,end=bars.at(-1).end,w=1080/bars.length;
    let x=time=>{let i=bars.findIndex(b=>b.start<=time&&b.end>time);if(i<0)return time>=end?1180:100;const b=bars[i],points=(b.beats||[]).map(v=>v[0]).concat(b.end);if(points.length<2)return 100+i*w+(time-b.start)/(b.end-b.start)*w;let n=points.findIndex((v,j)=>j<points.length-1&&v<=time&&points[j+1]>time);if(n<0)n=0;return 100+i*w+(n+(time-points[n])/(points[n+1]-points[n]))/(points.length-1)*w};
    this.maps[row]={start,end,x};
    let staffTop=112,staffBottom=152;let bounds=bars.map((b,i)=>({left:100+i*w,right:100+(i+1)*w}));const staff=this.prefs.melody&&this.prefs.notation==='staff';if(staff){const layout=engrave(svg,bars,this.payload,t=>this.keyAt(t),this.prefs);x=layout.x;bounds=layout.bounds;staffTop=layout.staffTop;staffBottom=layout.staffBottom;this.maps[row]={start,end,x}}
    for(let i=0;i<bars.length;i++){const b=bars[i],left=bounds[i].left;
     if(this.prefs.bars&&staff)add('line',{x1:bounds[i].right,x2:bounds[i].right,y1:staffTop,y2:staffBottom,class:'ps-measure'});
     if(this.prefs.bars&&i>0)add('line',{x1:left,x2:left,y1:22,y2:staff?78:h-18,class:'ps-bar'});
     add('text',{x:left+5,y:16,class:'ps-sub','font-size':12},b.valid?String(b.number):'待核');
     if(this.prefs.beats)for(const beat of b.beats||[]){if(beat[1]===1)continue;const at=x(beat[0]);add('line',{x1:at,x2:at,y1:26,y2:staff?78:h-20,class:'ps-grid'})}
    }

    if(this.prefs.chords)for(const [a,b,label] of this.payload.chords||[]){if(b<=start||a>=end)continue;const cuts=[Math.max(a,start),...(this.payload.keys||[]).map(k=>k[0]).filter(v=>v>a&&v<b&&v>start&&v<end),Math.min(b,end)].sort((a,b)=>a-b);for(let i=0;i<cuts.length-1;i++){const left=x(cuts[i]),right=x(cuts[i+1]);add('rect',{x:left+1,y:33,width:Math.max(1,right-left-2),height:34,rx:2,class:'ps-chord',style:this.prefs.chordColors&&chordColor(label,this.keyAt((cuts[i]+cuts[i+1])/2))?'--chord-color:'+chordColor(label,this.keyAt((cuts[i]+cuts[i+1])/2)):''});const text=chordText(label,this.keyAt((cuts[i]+cuts[i+1])/2),this.prefs.chordFormat);const node=add('text',{x:left+7,y:56,'font-size':15},right-left>text.length*8+12?text:'');const title=document.createElementNS(NS,'title');title.textContent=text;node.append(title)}}
    if(this.prefs.melody&&this.prefs.notation!=='staff')for(const [a,b,p] of this.payload.notes||[]){if(b<=start||a>=end)continue;const midi=Math.round(p),flat=this.keyAt(a)?.tonic.includes('b'),spell=(flat?['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B']:['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'])[midi%12],oct=Math.floor(midi/12)-1,li=letters.indexOf(spell[0]),y=168-((oct-4)*7+li)*6,at=x(Math.max(a,start)),tail=x(Math.min(b,end));const group=add('g',{'data-note-start':a,'data-note-end':b,class:'ps-note'});const child=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text)e.textContent=text;group.append(e);return e};
     const k=this.keyAt(a),text=this.prefs.notation==='names'?spell+oct:k?(degree(spell,k)||'?')+(oct>4?'̇':oct<4?'̣':''):'—';child('text',{x:at,y:130,'font-size':16},text);child('line',{x1:at,x2:Math.max(at+2,tail-2),y1:144,y2:144,class:'ps-length'});
     const title=document.createElementNS(NS,'title');title.textContent=`${spell}${oct} · ${a.toFixed(2)}–${b.toFixed(2)}秒`;group.append(title);
    }
    add('line',{x1:100,x2:100,y1:2,y2:h-5,class:'ps-cursor'});
   },
   seek(event,row){const map=this.maps?.[row];if(!map)return;const r=event.currentTarget.getBoundingClientRect(),px=(event.clientX-r.left)/r.width*1200;if(px<20||px>1195)return;let lo=map.start,hi=map.end;for(let n=0;n<32;n++){const mid=(lo+hi)/2;if(map.x(mid)<px)lo=mid;else hi=mid}this.$emit('seek',(lo+hi)/2)},
  },
  template:`<section class="practice-information" :class="{'ps-focus':focus}" aria-label="演奏信息">
   <div class="ps-toolbar"><div class="ps-facts"><span v-if="prefs.key">{{keyLabel}}</span><span v-if="prefs.bpm">{{bpmLabel}} <small title="按四分音符计速">♩ BPM</small></span><span v-if="prefs.meter">{{meterLabel}}</span></div><button type="button" class="mini ps-metronome" :aria-pressed="metronomeOn" :disabled="!configureMetronome||!(bars||[]).some(b=>b.valid)" @click="toggleMetronome">节拍器</button><button type="button" class="mini" :aria-pressed="follow" @click="resumeFollow">跟随播放</button><button type="button" class="mini" @click="browse(-1)" aria-label="浏览前一行">‹</button><button type="button" class="mini" @click="browse(1)" aria-label="浏览后一行">›</button><label>每行 <select v-model.number="prefs.perLine" @change="changed"><option :value="2">2 小节</option><option :value="4">4 小节</option><option :value="8">8 小节</option></select></label><button type="button" class="mini" :aria-pressed="focus" @click="focusToggle">{{focus?'退出全屏':'谱子全屏'}}</button><button type="button" class="mini" :aria-expanded="settingsOpen" @click="settingsOpen=!settingsOpen">显示设置</button></div>
   <training-controls ref="training" v-if="configureTraining" :active="active" :path="path" :song-key="songKey" :duration="payload?.duration||duration" :segments="segments" :read-clock="readClock" :configure="configureTraining" @seek="$emit('seek',$event)"></training-controls>
   <p v-if="metronomeError" class="practice-error" role="alert">{{metronomeError}}</p><p v-if="fullscreenError" role="alert">{{fullscreenError}}</p><div v-if="settingsOpen" class="ps-settings"><bluetooth-calibration :active="active && settingsOpen" :create-output="createCalibrationOutput"></bluetooth-calibration><label>节拍细分 <select v-model.number="subdivision" @change="patternChanged" aria-label="节拍细分"><option :value="1">原拍点</option><option :value="2">八分音符</option><option :value="3">三连音</option><option :value="4">十六分音符</option></select></label><label>重拍 <input type="range" min="0" max="100" v-model.number="strong" @change="patternChanged" aria-label="重拍强度"><output>{{strong}}%</output></label><label>弱拍 <input type="range" min="0" max="100" v-model.number="weak" @change="patternChanged" aria-label="弱拍强度"><output>{{weak}}%</output></label><label>节拍器音色 <select v-model="metronomeSound" @change="metronomeSoundChanged" aria-label="节拍器音色"><option value="click">电子滴答</option><option value="wood">木鱼</option><option value="mechanical">机械节拍器</option><option value="hihat">踩镲</option></select></label><button type="button" class="mini" :disabled="!previewMetronome||metronomeVolume===0" @click="previewMetronomeSound">试音</button><label>节拍器音量 <input type="range" min="0" max="200" step="1" v-model.number="metronomeVolume" @input="metronomeVolumeChanged" aria-label="节拍器音量"><output>{{metronomeVolume}}%</output></label><label><input type="checkbox" v-model="prefs.chordColors" @change="changed">和弦级数配色</label><span v-if="prefs.chordColors" class="ps-color-legend"><span v-for="(color,i) in ['#cf5f69','#b77b32','#9b8a28','#4c936b','#5184c5','#9571bb','#b8689c']" :style="{'--degree-color':color}">{{i+1}}</span></span><p v-if="payload?.warning" class="ps-warning">{{payload.warning}}</p><label v-for="(name,key) in layerOptions" :key="key"><input type="checkbox" v-model="prefs[key]" @change="changed">{{name}}</label><label>旋律 <select v-model="prefs.notation" @change="changed" aria-label="旋律读法"><option value="staff">五线谱</option><option value="names">音名时值</option><option value="numbers">简谱唱名时值</option></select></label><label>和弦 <select v-model="prefs.chordFormat" @change="changed"><option value="name">和弦名</option><option value="degree">数字级数</option></select></label><button type="button" class="mini" @click="defaults">恢复默认显示</button></div>
   <p v-if="loading" class="practice-note" role="status">正在读取演奏信息…</p><p v-else-if="!available" class="practice-note" role="status">{{statusText}}</p>
   <template v-else><div class="ps-lines" ref="lines"><svg v-for="row in 2" :key="row" @click="seek($event,row-1)" role="img" :aria-label="'第'+row+'行演奏谱面'"></svg></div></template>
  </section>`
 };
})(window);
