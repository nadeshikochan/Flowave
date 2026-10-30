'use strict';
const {EventEmitter}=require('events'),{spawn}=require('child_process'),path=require('path');
const unknown=reason=>({id:'',name:'',transport:'unknown',route:'unknown',confirmed:false,reason,sampledAt:Date.now()});
class AudioOutputMonitor extends EventEmitter {
 constructor({owner=process.pid,platform=process.platform,script=path.join(__dirname,'tools/audio-output/watch.ps1'),spawnProcess=spawn}={}){
  super();Object.assign(this,{owner,platform,script,spawnProcess,child:null,buffer:'',closed:false,waiters:new Set(),leases:new Set(),generation:0,state:unknown('not-started')});
 }
 acquire(id){if(this.closed)return;this.leases.add(id);this.start()}
 release(id){this.leases.delete(id);if(!this.leases.size)this.stop()}
 start(){
  if(this.child||this.closed||!this.leases.size||this.platform!=='win32')return;
  clearTimeout(this.retry);this.retry=null;const generation=++this.generation;
  const script=this.script.replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
  const child=this.child=this.spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-Mta','-ExecutionPolicy','Bypass','-File',script,'-OwnerProcessId',String(this.owner)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  this.buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(this.child!==child)return;this.buffer+=chunk;if(this.buffer.length>65536){this.buffer='';this.publish(unknown('invalid-response'));return}let at;while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at).trim();this.buffer=this.buffer.slice(at+1);try{const v=JSON.parse(line);if(!v||typeof v.id!=='string'||!['bluetooth','other','unknown'].includes(v.transport))continue;this.publish({...v,id:v.id.slice(0,256),name:String(v.name||'').slice(0,256),confirmed:v.confirmed===true,sampledAt:Date.now()})}catch{}}});
  child.stderr.resume();const failed=()=>{if(this.child!==child||this.generation!==generation)return;this.child=null;this.publish(unknown('probe-unavailable'));clearTimeout(this.retry);if(!this.closed&&this.leases.size)this.retry=setTimeout(()=>{if(this.generation===generation&&this.leases.size)this.start()},10000)};
  child.on('error',failed);child.on('exit',failed);
  if(!this.watchdog)this.watchdog=setInterval(()=>{if(this.state.confirmed&&Date.now()-this.state.sampledAt>3500)this.publish(unknown('probe-stale'))},1000);
 }
 publish(value){this.state=value;this.emit('change',value);for(const resolve of [...this.waiters])resolve(value)}
 async get(){
  if(!this.leases.size)return unknown('not-needed');
  if(this.platform!=='win32')return unknown('unsupported-platform');this.start();
  if(this.closed)return unknown('closed');
  if(this.state.confirmed&&Date.now()-this.state.sampledAt<3500)return {...this.state};
  return new Promise(resolve=>{let timer;const finish=value=>{clearTimeout(timer);this.waiters.delete(finish);resolve(value)};this.waiters.add(finish);timer=setTimeout(()=>finish(unknown('probe-timeout')),5000)});
 }
 stop(reason='not-needed'){++this.generation;clearTimeout(this.retry);this.retry=null;clearInterval(this.watchdog);this.watchdog=null;const child=this.child;this.child=null;child?.kill();this.buffer='';this.publish(unknown(reason))}
 dispose(){this.closed=true;this.leases.clear();this.stop('closed');this.removeAllListeners()}
}
module.exports={AudioOutputMonitor};
