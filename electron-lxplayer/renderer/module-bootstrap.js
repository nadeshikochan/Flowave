// Fixed local official entries only. Disabled module scripts are never requested.
(async function(root){'use strict';
  function script(file){return new Promise((resolve,reject)=>{
    const node=document.createElement('script');node.src=file;node.async=false;
    const timer=setTimeout(()=>reject(Error('载入超时 '+file)),15000);
    node.onload=()=>{clearTimeout(timer);resolve();};node.onerror=()=>{clearTimeout(timer);reject(Error('无法载入 '+file));};document.head.appendChild(node);
  });}
  const groups=[
    ['recommendation',['sound-map-model.js','sound-map-scene.js','recommendation-inspector.js','sound-map.js']],
    ['analysis',['music-analysis.js']],
    ['practice',['stem-player.js','stem-pages.js','practice-training.js','practice-ui-loader.js']],
  ];
  const registered={
    recommendation:()=>!!root.FlowaveSoundMap && !!root.FlowaveRecommendationInspector,
    analysis:()=>!!root.FlowaveMusicInsights,
    practice:()=>!!root.FlowaveStemPlayer && !!root.FlowaveStemPages && !!root.FlowavePracticeTraining && !!root.FlowavePracticeUi,
  };
  try {
    for(const [id,files] of groups)if(root.FlowaveFeatureModules.enabled(id)){
      for(const file of files)await script(file);
      if(!registered[id]())throw Error('功能组件未能注册：'+id);
    }
    await script('app.js');
    if(!root.__kumikoApp)throw Error('基础界面未能注册');
  }catch(error){
    const host=document.getElementById('app');host.removeAttribute('v-cloak');host.replaceChildren();
    const message=document.createElement('p');message.textContent=error.message+'。请重新打开软件。';
    message.style.padding='32px';host.appendChild(message);console.error(error);
    const retry=document.createElement('button');retry.textContent='重新载入';retry.onclick=()=>location.reload();host.appendChild(retry);
  }
})(window);
