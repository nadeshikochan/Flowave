(function(root){
  'use strict';
  const base=document.currentScript?.src||location.href,files=new Map();let loading=null;
  // Fixed local resources, original paths and dependency order. This loader never starts models.
  const dependencies=[
    ['vendor/vexflow-4.2.5.js',()=>!!root.Vex?.Flow],
    ['practice-note-layout.js',()=>!!root.FlowavePracticeNoteLayout],
    ['practice-score.js',()=>!!root.FlowavePracticeScore],
    ['practice.js',()=>!!root.FlowavePractice],
  ];
  function script(file,ready){
    if(ready())return Promise.resolve();if(files.has(file))return files.get(file);
    const pending=new Promise((resolve,reject)=>{
      const node=document.createElement('script');
      const finish=error=>{node.onload=null;node.onerror=null;if(error){node.remove();reject(error);}else resolve();};
      node.src=new URL(file,base).href;node.async=false;
      node.onload=()=>finish(ready()?null:new Error('演奏界面依赖未就绪，请重试。'));
      node.onerror=()=>finish(new Error('演奏界面载入失败，请重试。'));
      document.head.append(node);
    }).catch(error=>{files.delete(file);throw error;});
    files.set(file,pending);return pending;
  }
  async function bounded(pending){
    let timer;
    // A removed <script> may still execute. Timeout leaves its one in-flight
    // resource cached; retry waits for that same request instead of inserting a duplicate.
    try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('演奏界面载入超时，请重试。')),15000);})]);}
    finally{clearTimeout(timer);}
  }
  function ensure(){
    if(loading)return loading;
    loading=(async()=>{for(const [file,ready] of dependencies)await bounded(script(file,ready));return root.FlowavePractice;})()
      .catch(error=>{loading=null;throw error;});
    return loading;
  }
  root.FlowavePracticeUi={
    inheritAttrs:false,props:{active:Boolean},
    data:()=>({implementation:null,loading:false,error:'',loadGeneration:0}),
    watch:{active:{immediate:true,handler(value){if(value)this.load();else ++this.loadGeneration;}}},
    beforeUnmount(){++this.loadGeneration;},
    methods:{async load(){
      if(this.implementation)return;
      const generation=++this.loadGeneration;this.loading=true;this.error='';
      try{const component=await ensure();if(generation===this.loadGeneration&&this.active)this.implementation=root.Vue.markRaw(component);}
      catch(error){if(generation===this.loadGeneration&&this.active)this.error=error.message||'演奏界面载入失败，请重试。';}
      finally{if(generation===this.loadGeneration)this.loading=false;}
    }},
    render(){
      if(this.implementation)return root.Vue.h(this.implementation,{...this.$attrs,active:this.active},this.$slots);
      if(!this.active)return null;
      return root.Vue.h('section',{class:'practice-page',role:'status'},[
        root.Vue.h('p',this.error||'正在载入演奏界面…'),
        this.error?root.Vue.h('button',{type:'button',class:'mini',onClick:()=>this.load()},'重试'):null,
      ]);
    },
  };
  root.FlowavePracticeUiLoader={ensure};
})(window);
