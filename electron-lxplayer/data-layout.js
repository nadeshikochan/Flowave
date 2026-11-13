const fs=require('node:fs'),path=require('node:path');
const historyNames=['listening_history.json','listening-history-backups','listening-history-snapshots'];
function locatorFile(appHome, {mode, localAppData = process.env.LOCALAPPDATA} = {}) {
  return mode === 'installed'
    ? path.join(localAppData || path.join(require('node:os').homedir(), 'AppData/Local'), 'Flowave/data-location.txt')
    : path.join(appHome, 'workspace-location.txt');
}
function resolveDataDir(appHome, {mode, raw = '', localAppData = process.env.LOCALAPPDATA} = {}) {
  const installed = mode === 'installed';
  const fallback = installed
    ? path.join(localAppData || path.join(require('node:os').homedir(), 'AppData/Local'), 'Flowave/data')
    : path.join(appHome, 'data');
  const requested = String(raw || '').trim();
  let selected = requested;
  if (!selected) {
    const pointer = locatorFile(appHome, {mode, localAppData});
    if (fs.existsSync(pointer)) {
      selected = fs.readFileSync(pointer, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!selected) throw Error('数据目录记录为空，请保留原文件并恢复备份。');
      if (!path.isAbsolute(selected)) {
        if (installed) throw Error('数据目录记录损坏，请保留原文件并恢复备份。');
        selected = path.resolve(appHome, selected);
      }
      if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) throw Error('数据目录不可用，请连接原磁盘后重试。');
    } else if (installed && !fs.existsSync(fallback)) {
      throw Error('尚未选择数据目录，请重新运行安装包选择软件数据存储位置。');
    }
  }
  if (!selected) return path.resolve(fallback);
  if (!path.isAbsolute(selected)) throw Error('数据目录必须是完整路径。');
  const candidate = path.resolve(selected);
  const relative = path.relative(path.resolve(appHome), candidate);
  const contained = !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  if (installed) {
    if (contained) throw Error('安装版数据目录必须位于程序安装目录之外。');
    return candidate;
  }
  return candidate;
}
function dataLayout(data){
  const config=path.join(data,'config'),modern=path.join(data,'library','listening');
  // Legacy evidence (including backups) wins. No migration or timestamp-based
  // merge; this also preserves writes made by an older build after a rollback.
  const history=historyNames.some(name=>fs.existsSync(path.join(config,name)))?config:modern;
  const legacyPackages=path.join(data,'components','official-modules'),packages=fs.existsSync(legacyPackages)?legacyPackages:path.join(data,'packages','official');
  return {history,packages};
}
function locations(data,appHome,layout=dataLayout(data)){
 let policy={groups:[]};
 try{policy=JSON.parse(fs.readFileSync(path.join(appHome,'resources/storage-layout.json'),'utf8'));}catch{}
 let mert=path.join(appHome,'models','MERT-v1-330M');
 let indexRuntime=path.join(appHome,'backend','index-worker');
 const imported=path.join(data,'components/resources/legacy');
 const importedMert=path.join(imported,'models/MERT-v1-330M');
 if(fs.existsSync(importedMert))mert=importedMert;
 if(fs.existsSync(path.join(imported,'python-index/Scripts/python.exe')))indexRuntime=path.join(imported,'python-index');
 let customMert=false;
 try {
   const config=JSON.parse(fs.readFileSync(path.join(data,'config','app.json'),'utf8').replace(/^\uFEFF/,''));
   const selected=String(config.model?.local_dir || '').trim();
   customMert=!!selected && selected.replace(/\\/g,'/')!=='models/MERT-v1-330M';
   if(customMert)mert=path.resolve(appHome,selected);
 } catch {}
 if(fs.existsSync(path.join(appHome,'resources/catalog.json'))){
   const {ResourceManager,revision}=require('./resource-manager');
   const manager=new ResourceManager(appHome,{dataDir:data});
   const root=path.join(data,'components/resources');
   if(!fs.existsSync(indexRuntime))indexRuntime=path.join(root,'runtimes/recommendation');
   if(!customMert&&!fs.existsSync(mert))mert=path.join(root,'assets/mert');
   try{
     const catalog=manager.catalog();
     const model=catalog.groups.mert,profile=catalog.profiles.recommendation;
     if(!customMert&&model&&manager.ready('assets','mert',model))
       mert=path.join(root,'assets/mert',revision(model).slice(0,16),'tree/models/MERT-v1-330M');
     if(profile&&manager.ready('runtimes','recommendation',profile))
       indexRuntime=path.join(root,'runtimes/recommendation',revision(profile).slice(0,16));
   }catch{}
 }
 return [
  {id:'history',name:'听歌记录与备份',path:layout.history,note:'保留时长、次数和推荐学习；移除功能包不会删除。',important:true},
  {id:'index',name:'曲库索引与歌曲身份',path:path.join(data,'library'),note:'此目录同时包含记录和分析成果。卸载按类别处理，手动整理时请核对具体文件。',important:true},
  {id:'analysis',name:'歌曲分析结果',path:path.join(data,'library','track-analysis'),note:'标签、段落、向量及任务恢复数据。',important:true},
  {id:'stems',name:'分轨与演奏成果',path:path.join(data,'library','stems'),note:'已生成的伴奏分轨。',important:true},
  {id:'practice',name:'谱面分析结果',path:path.join(data,'library','practice-analysis'),note:'谱面、原始音高与历史版本。',important:true},
  {id:'traces',name:'听歌轨迹',path:path.join(data,'library','listening-traces'),note:'路线事件、诊断及迁移回退材料。',important:true},
  {id:'models',name:'模型资产',path:fs.existsSync(path.join(appHome,'resources/catalog.json'))||fs.existsSync(path.join(data,'components/resources'))?path.join(data,'components/resources'):path.join(appHome,'models'),note:'模型和独立计算环境保留在受管资源目录，移除插件不会删除。',important:true},
  {id:'mert-model',name:'MERT 模型实际位置',path:mert,note:'按当前保存的模型目录显示；清除模型不会删除已建立的索引。',important:true},
  {id:'index-runtime',name:'推荐计算组件',path:indexRuntime,note:'用于新增音乐的特征处理，模型与运行环境保留在本机。'},
  {id:'packages',name:'功能包代码',path:layout.packages,note:'只存受管功能版本，与用户记录和模型分开。'},
  {id:'components',name:'计算运行组件',path:path.join(data,'components'),note:'分析等运行依赖；移除界面包时保留。'},
  {id:'settings',name:'设置与歌单',path:path.join(data,'config'),note:'主题、歌单、目录设置和用户偏好。',important:true},
  {id:'cache',name:'缓存与处理中间文件',path:path.join(data,'cache'),note:'含在途任务恢复材料；请退出软件后再整理。'},
 ].map(location=>{
   const relative=path.relative(data,location.path).split(path.sep).join('/');
   const external=relative==='..'||relative.startsWith('../')||path.isAbsolute(relative);
   const group=policy.groups.find(item=>item.directories.some(folder=>relative===folder||relative.startsWith(folder+'/'))||item.files.includes(relative));
   return {...location,external,storageGroup:external?'外部位置':group?.label||'包含多类数据'};
 });
}
module.exports={dataLayout,locations,resolveDataDir,locatorFile};
