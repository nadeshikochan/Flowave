(async function(root){'use strict';
 function script(file){return new Promise((resolve,reject)=>{const node=document.createElement('script');node.src=file;node.async=false;const timer=setTimeout(()=>reject(Error('载入超时 '+file)),15000);node.onload=()=>{clearTimeout(timer);resolve();};node.onerror=()=>{clearTimeout(timer);reject(Error('无法载入 '+file));};document.head.appendChild(node);});}
 const groups=[['history',['module.js']],['recommendation',['sound-map-model.js','sound-map-scene.js','recommendation-inspector.js','sound-map.js']],['analysis',['music-analysis.js']],['practice',['stem-player.js','stem-pages.js','practice-training.js','practice-ui-loader.js']]];
 const globals={history:['FlowaveHistoryModule'],recommendation:['FlowaveSoundMap','FlowaveRecommendationInspector','FlowaveSoundMapModel','FlowaveSoundMapScene'],analysis:['FlowaveMusicInsights'],practice:['FlowaveStemPlayer','FlowaveStemPages','FlowavePracticeTraining','FlowavePracticeUi']};
 for(const [id,files] of groups)if(root.FlowaveFeatureModules.enabled(id))try{
  const pack=root.FlowaveFeatureModules.initial?.packages?.[id]?.active;
  if(!pack||!/^[a-f0-9]{64}$/.test(pack.digest))throw Error('功能包未安装或不可用。');
  for(const file of files)await script(`/_modules/${id}/${pack.digest}/${file}`);
  if(!globals[id].every(name=>!!root[name])||(id==='history'&&root.FlowaveHistoryModule.hostApi!==1))throw Error('功能组件未能注册：'+id);
  if(id==='history'){const template=root.lxEnv?.getModuleTemplateSync?.(id),slot=document.getElementById('flowave-history-slot');if(!template||!slot)throw Error('听歌记录界面校验失败。');slot.outerHTML=template;}
 }catch(error){for(const name of globals[id])root[name]=null;(root.FlowaveFeatureModules.failures ||= {})[id]=error.message;}
 try{await script('app.js');if(!root.__kumikoApp || root.__flowaveMounted!==true || root.__flowaveStartupError)throw Error('主界面初始化未完成：'+(root.__flowaveStartupError||'启动钩子未完成'));}
 catch(error){root.__flowaveStartupError=String(error.message||error);root.__flowaveMounted=false;const host=document.getElementById('app');try{host.__vue_app__?.unmount();}catch(cleanupError){console.error('初始化清理未完成',cleanupError);}host.removeAttribute('v-cloak');host.replaceChildren();const message=document.createElement('p');message.textContent=error.message+'。请重新打开软件。';message.style.padding='32px';host.appendChild(message);console.error(error);const retry=document.createElement('button');retry.textContent='重新载入';retry.onclick=()=>location.reload();host.appendChild(retry);}
})(window);
