const fs=require('node:fs'),path=require('node:path');
const historyNames=['listening_history.json','listening-history-backups','listening-history-snapshots'];
function dataLayout(data){
  const config=path.join(data,'config'),modern=path.join(data,'library','listening');
  // Legacy evidence (including backups) wins. No migration or timestamp-based
  // merge; this also preserves writes made by an older build after a rollback.
  const history=historyNames.some(name=>fs.existsSync(path.join(config,name)))?config:modern;
  const legacyPackages=path.join(data,'components','official-modules'),packages=fs.existsSync(legacyPackages)?legacyPackages:path.join(data,'packages','official');
  return {history,packages};
}
function locations(data,appHome,layout=dataLayout(data)){
 let mert=path.join(appHome,'models','MERT-v1-330M');
 try{const config=JSON.parse(fs.readFileSync(path.join(data,'config','app.json'),'utf8').replace(/^\uFEFF/,''));if(typeof config.model?.local_dir==='string'&&config.model.local_dir.trim())mert=path.resolve(appHome,config.model.local_dir.trim());}catch{}
 return [
  {id:'history',name:'听歌记录与备份',path:layout.history,note:'保留时长、次数和推荐学习；移除功能包不会删除。',important:true},
  {id:'index',name:'曲库索引与歌曲身份',path:path.join(data,'library'),note:'保留声音索引、稳定身份及复合种子；删除后可能需要重建。',important:true},
  {id:'analysis',name:'歌曲分析结果',path:path.join(data,'library','track-analysis'),note:'标签、段落、向量及任务恢复数据。',important:true},
  {id:'stems',name:'分轨与演奏成果',path:path.join(data,'library','stems'),note:'已生成的伴奏分轨。',important:true},
  {id:'practice',name:'谱面分析结果',path:path.join(data,'library','practice-analysis'),note:'谱面、原始音高与历史版本。',important:true},
  {id:'traces',name:'听歌轨迹',path:path.join(data,'library','listening-traces'),note:'路线事件、诊断及迁移回退材料。',important:true},
  {id:'models',name:'模型资产',path:path.join(appHome,'models'),note:'沿用现有模型位置；自定义MERT位置可在推荐模型设置中打开。',important:true},
  {id:'mert-model',name:'MERT 模型实际位置',path:mert,note:'按当前保存的模型目录显示；清除模型不会删除已建立的索引。',important:true},
  {id:'index-runtime',name:'推荐计算组件',path:path.join(appHome,'backend','index-worker'),note:'用于新增音乐的特征处理，安装位置沿原组件约定。'},
  {id:'packages',name:'功能包代码',path:layout.packages,note:'只存受管功能版本，与用户记录和模型分开。'},
  {id:'components',name:'计算运行组件',path:path.join(data,'components'),note:'分析等运行依赖；移除界面包时保留。'},
  {id:'settings',name:'设置与歌单',path:path.join(data,'config'),note:'主题、歌单、目录设置和用户偏好。',important:true},
  {id:'cache',name:'缓存与处理中间文件',path:path.join(data,'cache'),note:'含在途任务恢复材料；请退出软件后再整理。'},
 ];
}
module.exports={dataLayout,locations};
