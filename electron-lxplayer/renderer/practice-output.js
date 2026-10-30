(function(root){
 'use strict';
 const key='lx-output-calibrations-v2';
 let output={id:'',name:'',transport:'unknown',confirmed:false,reason:'checking',sampledAt:0},minimumTime=0,expiry,cachedProfiles;
 const consumers=new Set();let epoch=0,unsubscribe=null,leaseId='';
 const notify=()=>root.dispatchEvent(new Event('flowave-output-calibration'));
 function profiles(){if(cachedProfiles)return cachedProfiles;try{const data=JSON.parse(localStorage.getItem(key)||'{}');return cachedProfiles=data.profiles&&typeof data.profiles==='object'?data.profiles:{}}catch{return cachedProfiles={}}}
 function eligible(device=output){return device.confirmed===true&&device.transport==='bluetooth'&&!!device.id&&Date.now()-device.sampledAt<3500}
 function read(){
  const all=profiles(),p=Object.hasOwn(all,output.id)?all[output.id]:null;let legacy=false;try{legacy=!p&&Number(JSON.parse(localStorage.getItem('lx-output-calibration')||'{}').offsetMs)>0}catch{}
  return {enabled:eligible()&&p?.enabled===true,savedEnabled:p?.enabled===true,offsetMs:Math.max(0,Math.min(900,Number(p?.offsetMs)||0)),range:Array.isArray(p?.range)?p.range:null,configured:!!p,eligible:eligible(),legacy,output:{...output}};
 }
 function save(value,device=output){
  const all={...profiles()};if(!device.id||device.transport!=='bluetooth'||!Object.hasOwn(all,device.id)&&device.confirmed!==true)throw new Error('尚未确认蓝牙耳机输出，请重新校准。');
  all[device.id]={enabled:value.enabled===true,offsetMs:Math.max(0,Math.min(900,Number(value.offsetMs)||0)),range:value.range||null,method:value.method||'uniform-song-tap-v2',name:device.name,updated:Date.now()};
  localStorage.setItem(key,JSON.stringify({version:2,profiles:all}));cachedProfiles=all;notify();
 }
 function clear(){const all={...profiles()};delete all[output.id];localStorage.setItem(key,JSON.stringify({version:2,profiles:all}));cachedProfiles=all;notify()}
 function delaySeconds({playing,rate=1}={}){if(!playing||!eligible())return 0;const all=profiles(),p=Object.hasOwn(all,output.id)?all[output.id]:null;if(p?.enabled!==true)return 0;const speed=Number(rate);return Math.max(0,Math.min(900,Number(p.offsetMs)||0))/1000*(Number.isFinite(speed)&&speed>0?speed:1)}
 function accept(value){
  if(!consumers.size)return;
  if(!value||Number(value.sampledAt)<minimumTime||Number(value.sampledAt)<output.sampledAt)return;
  const next={id:String(value.id||''),name:String(value.name||''),transport:['bluetooth','other'].includes(value.transport)?value.transport:'unknown',confirmed:value.confirmed===true,reason:value.reason||'',sampledAt:Number(value.sampledAt)||Date.now()};
  const changed=JSON.stringify([output.id,output.transport,output.confirmed,output.reason])!==JSON.stringify([next.id,next.transport,next.confirmed,next.reason]);output=next;
  clearTimeout(expiry);expiry=setTimeout(()=>{output={...output,confirmed:false,reason:'probe-stale'};notify()},3500);if(changed)notify();
 }
 async function refresh(){if(!consumers.size||!root.lxEnv?.getAudioOutput)return {...output};const generation=epoch;try{const value=await root.lxEnv.getAudioOutput();if(generation===epoch)accept(value)}catch{if(generation===epoch)accept({id:'',transport:'unknown',confirmed:false,reason:'unavailable',sampledAt:Date.now()})}return {...output}}
 function change(){if(!consumers.size)return;minimumTime=Date.now();output={id:'',name:'',transport:'unknown',confirmed:false,reason:'checking',sampledAt:minimumTime};notify();refresh()}
 function acquire(consumer){
  const token=Symbol(consumer);consumers.add(token);
  if(consumers.size===1){
   leaseId='calibration-'+(root.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));
   const generation=++epoch;minimumTime=Date.now();output={id:'',name:'',transport:'unknown',confirmed:false,reason:'checking',sampledAt:minimumTime};
   unsubscribe=root.lxEnv?.onAudioOutputChanged?.(accept);navigator.mediaDevices?.addEventListener('devicechange',change);
   const request=root.lxEnv?.acquireAudioOutput?root.lxEnv.acquireAudioOutput(leaseId):root.lxEnv?.getAudioOutput?.();
   Promise.resolve(request).then(value=>{if(generation===epoch)accept(value)}).catch(()=>{if(generation===epoch)accept({id:'',transport:'unknown',confirmed:false,reason:'unavailable',sampledAt:Date.now()})});
  }
  let released=false;return ()=>{if(released)return;released=true;consumers.delete(token);if(consumers.size)return;
   ++epoch;clearTimeout(expiry);unsubscribe?.();unsubscribe=null;navigator.mediaDevices?.removeEventListener('devicechange',change);
   const previousLease=leaseId;leaseId='';root.lxEnv?.releaseAudioOutput?.(previousLease)?.catch?.(()=>{});
   output={id:'',name:'',transport:'unknown',confirmed:false,reason:'not-needed',sampledAt:Date.now()};notify();
  };
 }
 root.FlowaveOutputCalibration={read,save,clear,refresh,delaySeconds,acquire,hasEnabledProfile:()=>Object.values(profiles()).some(profile=>profile?.enabled===true)};
 const storageChanged=event=>{if(event.key===key||event.key===null){cachedProfiles=null;notify()}};root.addEventListener('storage',storageChanged);
 root.addEventListener('beforeunload',()=>{++epoch;consumers.clear();clearTimeout(expiry);unsubscribe?.();if(leaseId)root.lxEnv?.releaseAudioOutput?.(leaseId)?.catch?.(()=>{});leaseId='';root.removeEventListener('storage',storageChanged);navigator.mediaDevices?.removeEventListener('devicechange',change)},{once:true});
})(window);
