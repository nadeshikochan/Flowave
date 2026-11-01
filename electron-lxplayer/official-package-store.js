// Official packages: code commits never own user data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const definitions=require('./official-module-definitions'),sha=data=>crypto.createHash('sha256').update(data).digest('hex'),clone=x=>JSON.parse(JSON.stringify(x));
const HOST_API=1,LIMIT=4*1024*1024;
function child(root,...parts){
 const target=path.resolve(root,...parts),relative=path.relative(path.resolve(root),target);
 if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('功能包路径越界。');
 for(let p=target;;p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw Error('功能包目录不能使用链接。');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===path.dirname(p))break;}
 return target;
}
function decode(buffer,catalog){
 if(!Buffer.isBuffer(buffer)||buffer.length>LIMIT)throw Error('功能包大小无效。');
 const digest=sha(buffer),entry=Object.entries(catalog.packages).find(([,p])=>p.releases.some(r=>r.sha256===digest));if(!entry)throw Error('此功能包未经官方清单核验。');
 const [id,item]=entry,release=item.releases.find(r=>r.sha256===digest),data=JSON.parse(buffer.toString('utf8')),definition=definitions[id];
 if(!definition||data.format!=='flowave-official-module-v1'||data.id!==id||data.version!==release.version||data.hostApi!==HOST_API||definition.files.some(name=>!Object.hasOwn(data.files||{},name))||Object.keys(data.files||{}).some(name=>![...definition.files,...definition.optionalFiles||[]].includes(name)))throw Error('功能包版本、接口或文件清单不兼容。');
 const files=Object.fromEntries(Object.entries(data.files).map(([name,value])=>{if(typeof value!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('功能包内容无效。');return [name,Buffer.from(value,'base64')];}));
 return {id,version:data.version,digest,files,buffer};
}
function atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.mkdirSync(path.dirname(file),{recursive:true});try{const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
function createOfficialPackageStore({directory,catalog,bundleSource,adoptLegacy=false}){
 const root=path.resolve(directory),registryFile=child(root,'registry.json'),ids=Object.keys(catalog.packages),active={},pending={},warnings={},problems={};
 let state={schema:1,revision:0,profile:adoptLegacy?'legacy':'basic',managed:adoptLegacy?[]:ids,modules:{}},error='',tail=Promise.resolve(),existed=false;
 function load(id,record){
  if(!record||!catalog.packages[id]?.releases.some(r=>r.sha256===record.digest&&r.version===record.version))throw Error('已安装功能包登记无效。');
  const folder=child(root,id,record.digest),archive=child(folder,'package.fwm');if(fs.statSync(archive).size>LIMIT)throw Error('功能包大小无效。');
  const pack=decode(fs.readFileSync(archive),catalog);if(pack.id!==id)throw Error('功能包身份不一致。');
  for(const [name,expected] of Object.entries(pack.files)){const file=child(folder,name);if(fs.statSync(file).size!==expected.length||!fs.readFileSync(file).equals(expected))throw Error('已安装功能包文件损坏，原数据保留。');}return pack;
 }
 function publish(pack){
  const folder=child(root,pack.id,pack.digest);if(fs.existsSync(folder)){load(pack.id,pack);return;}
  fs.mkdirSync(path.dirname(folder),{recursive:true});const stage=child(root,pack.id,pack.digest+'.'+crypto.randomUUID()+'.tmp');fs.mkdirSync(stage);
  for(const [name,bytes] of Object.entries({...pack.files,'package.fwm':pack.buffer})){const file=child(stage,name);fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  fs.renameSync(stage,folder);load(pack.id,pack);
 }
 try{const value=JSON.parse(fs.readFileSync(registryFile,'utf8'));existed=true;
  if(value.schema!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!value.modules||typeof value.modules!=='object'||Array.isArray(value.modules)||Object.keys(value.modules).some(id=>!definitions[id])||(value.managed&&(!Array.isArray(value.managed)||value.managed.some(id=>!definitions[id]))))throw Error('功能包注册表损坏，原文件已保留。');state=value;
 }catch(e){if(e.code!=='ENOENT'||fs.existsSync(registryFile))error=String(e.message||e);}
 if(!error)for(const id of ids)try{
  const record=state.modules[id];
  if(record)try{active[id]=load(id,record);}catch(failure){
   if(record.previous){active[id]=load(id,record.previous);pending[id]={pack:active[id],rollback:true};warnings[id]='新版本不完整，已保留上一版。';}
   else{const verified=decode(bundleSource(id,record.version),catalog);if(verified.id!==id||verified.digest!==record.digest)throw failure;active[id]=verified;pending[id]={pack:verified,repair:true};warnings[id]='功能包损坏，使用受核验副本；原数据保留。';}
  }else if(adoptLegacy&&state.profile!=='basic'&&(!existed||!(state.managed||['history']).includes(id))){const pack=decode(bundleSource(id,catalog.packages[id].latest),catalog);if(pack.id!==id)throw Error('功能包身份不一致。');active[id]=pack;pending[id]={pack};}
 }catch(e){problems[id]=e.message;}
 function snapshot(){return {revision:state.revision,error,warning:Object.values(warnings).join(" "),...Object.fromEntries(ids.map(id=>{const pack=active[id],installed=pending[id]?{version:pack.version,digest:pack.digest}:state.modules[id]||null,release=catalog.packages[id].releases.find(r=>r.version===catalog.packages[id].latest);return [id,{installed:installed?clone(installed):null,active:pack?{version:pack.version,digest:pack.digest}:null,latest:catalog.packages[id].latest,bytes:release?.bytes||null,source:release?.url?'github':'bundled',error:problems[id]||'',warning:warnings[id]||'',restartRequired:(installed?.digest||'')!==(pack?.digest||'')}];}))};}
 function mutate(action,buffer,revision,id){
  const job=tail.then(()=>{
   if(error)throw Error(error);if(!ids.includes(id))throw Error('未知功能包。');if(Object.keys(pending).length)throw Error('功能包恢复尚未完成。');if(revision!==state.revision)throw Error('功能包状态已变化，请刷新后重试。');
   const next=clone(state);
   if(action==='remove')delete next.modules[id];else{
    const pack=decode(buffer,catalog);if(pack.id!==id)throw Error('所选功能包与目标不一致。');const old=state.modules[id];if(old&&old.digest===pack.digest){load(id,old);return snapshot();}
    if(old){const a=old.version.split('.').map(Number),b=pack.version.split('.').map(Number),different=b.findIndex((n,i)=>n!==a[i]);if(different<0||b[different]<a[different])throw Error('不能覆盖或降级已安装版本。');}
    publish(pack);next.modules[id]={version:pack.version,digest:pack.digest,...(old?{previous:{version:old.version,digest:old.digest}}:{})};
   }
   next.revision++;next.managed=[...new Set([...(state.managed||['history']),id])];atomic(registryFile,next);state=next;delete problems[id];return snapshot();
  });tail=job.catch(()=>{});return job.then(clone);
 }
 return {
  bootstrapLegacy(){
   if(error)return;
   for(const [id,item] of Object.entries(pending))try{if(item.repair){const old=child(root,id,item.pack.digest);if(fs.existsSync(old))fs.renameSync(old,child(root,id,item.pack.digest+'.corrupt-'+crypto.randomUUID()));}publish(item.pack);const next=clone(state);next.modules[id]={version:item.pack.version,digest:item.pack.digest};next.revision++;next.managed=[...new Set([...(state.managed||['history']),id])];atomic(registryFile,next);state=next;delete pending[id];delete problems[id];}catch(e){problems[id]='兼容导入或恢复未完成：'+e.message;}
   if(!Object.keys(pending).length&&!Object.keys(problems).length&&(!fs.existsSync(registryFile)||JSON.stringify(state.managed)!==JSON.stringify(ids))){const next={...state,managed:ids};atomic(registryFile,next);state=next;}
  },
  collectUnused(){
   if(error||Object.keys(pending).length||Object.keys(problems).length)return;
   for(const id of ids){const keep=new Set([active[id]?.digest,state.modules[id]?.digest,state.modules[id]?.previous?.digest].filter(Boolean)),parent=child(root,id);if(!fs.existsSync(parent))continue;
    for(const name of fs.readdirSync(parent)){if(!/^[a-f0-9]{64}$/.test(name)||keep.has(name))continue;const folder=child(parent,name),allowed=new Set([...definitions[id].files,...definitions[id].optionalFiles||[],'package.fwm']),files=[],dirs=[];
     function visit(dir){for(const item of fs.readdirSync(dir)){const file=child(dir,item),stat=fs.lstatSync(file);if(stat.isDirectory()){visit(file);dirs.push(file);}else if(stat.isFile())files.push(file);else throw Error('未知文件类型。');}}
     visit(folder);if(files.some(file=>!allowed.has(path.relative(folder,file).replaceAll('\\','/'))))continue;for(const file of files)fs.unlinkSync(file);for(const dir of dirs)fs.rmdirSync(dir);fs.rmdirSync(folder);
    }
   }
  },
  snapshot,hasActive:(id='history')=>!!active[id],
  install:async(buffer,revision,id)=>mutate('install',buffer,revision,id||decode(buffer,catalog).id),
  installLatest:(revision,id='history')=>mutate('install',bundleSource(id,catalog.packages[id].latest),revision,id),
  remove:(revision,id='history')=>mutate('remove',null,revision,id),flush:()=>tail,
  readAsset(url){const parsed=new URL(url),parts=parsed.pathname.split('/').filter(Boolean),id=parts[1],pack=active[id];if(parsed.protocol!=='kumiko-app:'||parsed.hostname!=='renderer'||parts.length<4||parts[0]!=='_modules'||!pack||parts[2]!==pack.digest)return null;const name=parts.slice(3).join('/');if(!Object.hasOwn(pack.files,name))return null;const file=child(root,id,pack.digest,name),bytes=pending[id]?pack.files[name]:fs.statSync(file).size===pack.files[name].length?fs.readFileSync(file):null;if(!bytes?.equals(pack.files[name]))throw Error('运行中的功能包已变化，请重启修复。');return {data:bytes,contentType:name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8'};},
  template(id='history'){return active[id]?.files['view.html']?this.readAsset(`kumiko-app://renderer/_modules/${id}/${active[id].digest}/view.html`).data.toString('utf8'):'';},
 };
}
module.exports={createOfficialPackageStore,decode,sha,HOST_API,LIMIT};
