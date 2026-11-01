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
const failures={};
root.FlowaveFeatureModules = {catalog, initial,failures,
  enabled(id){return initial.active?.enabled?.[id] === true && !failures[id];},
  viewModule(view){return ({seeds:'recommendation','sound-map':'recommendation',ranking:'recommendation',analysis:'analysis',insights:'analysis',practice:'practice',history:'history',recommendation:'recommendation'})[view] || '';},
  methods:{
    featureEnabled(id){return !id || this.featureSelection.active?.enabled?.[id] === true && !failures[id];},
    featureSelected(id){return this.featureSelection.selected.enabled[id] && (!this.featureSelection.packages||!!this.featureSelection.packages[id]?.installed);},
    packageState(id){return this.featureSelection.packages?.[id]||null;},
    packageSize(bytes){if(!bytes)return '';return bytes<1024*1024?`${Math.ceil(bytes/1024)} KB`:`${(bytes/1024/1024).toFixed(2)} MB`;},
    async loadDataLocations(){try{this.featureDataLocations=await root.lxEnv?.getDataLocations?.()||[];}catch{this.featureMessage='数据位置暂时无法读取。';}},
    async openFeatureData(id){try{const result=await root.lxEnv?.openDataLocation?.(id);if(!result?.ok)this.featureMessage=result?.error||'目录无法打开。';}catch{this.featureMessage='目录无法打开。';}},
    async cancelModuleInstall(id){await root.lxEnv?.manageOfficialModule?.({action:'cancel',id});},
    async manageHistoryPackage(action){return this.manageFeaturePackage('history',action);},
    async manageFeaturePackage(id,action){
      if(this.featureSaving||!root.lxEnv?.manageOfficialModule)return;
      this.featureSaving=true;this.featureMessage='';this.featurePackageProgress={id,phase:'prepare'};
      try{
        const result=await root.lxEnv.manageOfficialModule({id,action,revision:this.featureSelection.packages.revision});
        if(result?.selection)this.featureSelection=result.selection;
        if(!result?.ok)throw Error(result?.error||'功能包操作失败');
      }catch(error){this.featureMessage=error.message||'功能包操作失败，原版本与记录保留。';}
      finally{this.featureSaving=false;this.featurePackageProgress={};}
    },
    async selectFeature(id, enabled, event){
      if(this.featureSaving || !root.lxEnv?.selectFeature)return;
      this.featureSaving=true;this.featureMessage='';
      try {
        const result=await root.lxEnv.selectFeature({id,enabled,revision:this.featureSelection.selected.revision});
        if(!result?.ok)throw Error(result?.error || '功能选择保存失败');
        this.featureSelection=result.selection;
      } catch(e){this.featureMessage=e.message || '功能选择保存失败，原选择保留。';}
      finally{this.featureSaving=false;if(event?.target)event.target.checked=this.featureSelected(id);}
    },
  },
};
})(window);
