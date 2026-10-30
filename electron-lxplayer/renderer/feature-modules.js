(function(root){'use strict';
const catalog = [
  {id:'recommendation',name:'歌曲推荐',description:'自然续播、找回感觉、换个感觉、复合种子和声音地图'},
  {id:'analysis',name:'歌曲分析',description:'乐器、风格、氛围、歌曲段落与曲库筛选'},
  {id:'practice',name:'演奏练习',description:'分轨、伴奏、循环练习与谱面'},
  {id:'history',name:'听歌记录',description:'长期听歌时长、次数和排行'},
];
const fallback = {schema:1,revision:0,enabled:Object.fromEntries(catalog.map(row=>[row.id,true]))};
let initial;
try { initial=root.lxEnv?.getFeatureSelectionSync?.(); } catch {}
initial=initial || {active:fallback,selected:fallback,error:''};
root.FlowaveFeatureModules = {catalog, initial,
  enabled(id){return initial.active?.enabled?.[id] === true;},
  viewModule(view){return ({seeds:'recommendation','sound-map':'recommendation',ranking:'recommendation',analysis:'analysis',insights:'analysis',practice:'practice',history:'history',recommendation:'recommendation'})[view] || '';},
  methods:{
    featureEnabled(id){return !id || this.featureSelection.active?.enabled?.[id] === true;},
    async selectFeature(id, enabled, event){
      if(this.featureSaving || !root.lxEnv?.selectFeature)return;
      this.featureSaving=true;this.featureMessage='';
      try {
        const result=await root.lxEnv.selectFeature({id,enabled,revision:this.featureSelection.selected.revision});
        if(!result?.ok)throw Error(result?.error || '功能选择保存失败');
        this.featureSelection=result.selection;
      } catch(e){this.featureMessage=e.message || '功能选择保存失败，原选择保留。';}
      finally{this.featureSaving=false;if(event?.target)event.target.checked=this.featureSelection.selected.enabled[id];}
    },
  },
};
})(window);
