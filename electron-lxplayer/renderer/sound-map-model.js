(function(root) {
  'use strict';
  const distance = s => Math.sqrt(Math.max(0, 2 - 2 * Math.max(-1, Math.min(1, s))));
  const norm = p => Math.hypot(...p);
  const unit = p => { const n = norm(p); return n > 1e-9 ? p.map(x => x / n) : [1, 0, 0]; };
  const subtract = (a,b) => a.map((v,i)=>v-b[i]);
  function localLayout({ids, similarities:s, anchor, compare, positions}) {
    const a=ids.indexOf(anchor),b=ids.indexOf(compare);
    if(a<0)throw Error('missing_anchor');
    const radii=s[a].map(distance),length=b>=0?radii[b]:0;
    radii[a]=0;
    const dual=b>=0&&length>1e-5;
    const coords=ids.map((_,i)=>{
      if(i===a)return dual?[-length/2,0,0]:[0,0,0];
      if(dual&&i===b)return[length/2,0,0];
      const delta=subtract(positions[i]||[0,0,0],positions[a]||[0,0,0]);
      const direction=norm(delta)>1e-8?unit(delta):unit([Math.sin(i*2.4),Math.cos(i*2.4),Math.sin(i*.7)]);
      return direction.map(v=>v*radii[i]);
    });
    const circles=ids.map((_,i)=>{
      if(!dual)return null;
      const rb=distance(s[b][i]),x=(radii[i]**2-rb**2+length**2)/(2*length);
      return{x:x-length/2,r:Math.sqrt(Math.max(0,radii[i]**2-x**2))};
    });
    function constrain(i,p){
      if(i===a)return dual?[-length/2,0,0]:[0,0,0];
      if(dual&&i===b)return[length/2,0,0];
      if(dual){const c=circles[i],n=Math.hypot(p[1],p[2]);return[c.x,c.r*(n?p[1]/n:Math.cos(i)),c.r*(n?p[2]/n:Math.sin(i))];}
      return unit(p).map(x=>x*radii[i]);
    }
    for(let i=0;i<coords.length;i++)coords[i]=constrain(i,coords[i]);
    // Relax neighbor-to-neighbor stress, while keeping center distances exact.
    for(let step=0;step<90;step++){
      const forces=coords.map(()=>[0,0,0]);
      for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
        const delta=subtract(coords[j],coords[i]),actual=norm(delta),target=distance(s[i][j]);
        if(actual<1e-9)continue;
        const weight=Math.exp(-target*3),force=(actual-target)*weight*.055/actual;
        for(let k=0;k<3;k++){forces[i][k]+=delta[k]*force;forces[j][k]-=delta[k]*force;}
      }
      for(let i=0;i<ids.length;i++)coords[i]=constrain(i,coords[i].map((x,j)=>x+forces[i][j]));
    }
    return{positions:coords,dual,coincident:b>=0&&!dual};
  }
  function frontier(graph, expanded, rootId=0) {
    const out=[];
    function visit(id){const g=graph.groups[id];if(!g)return;if(g.children.length&&expanded.has(id))g.children.forEach(visit);else out.push(g);}
    visit(rootId);return out;
  }
  function pairs(ids, similarities, all=false) {
    const result=[],near=similarities.map((row,i)=>new Set(row.map((value,j)=>({value,j})).filter(x=>x.j!==i).sort((a,b)=>b.value-a.value||a.j-b.j).slice(0,3).map(x=>x.j)));
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
      const strong=near[i].has(j)&&near[j].has(i);
      if(all||strong)result.push({source:ids[i],target:ids[j],similarity:similarities[i][j],strong});
    }
    return result;
  }
  function directionColor(section){
    const palette=['#b66778','#548fa9','#9a7ab5','#7f985a','#bc8a49','#599a8b'];
    if(section<=palette.length)return palette[Math.max(0,section-1)];
    const hue=((section-1)*.61803398875)%1,light=.55,a=.38*Math.min(light,1-light);
    const channel=n=>{const k=(n+hue*12)%12;return Math.round(255*(light-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};
    return '#'+channel(0)+channel(8)+channel(4);
  }
  function routePresentation(rows, actual=true, selectedOccurrence='') {
    let section=0,started=false;
    const steps=rows.map(row=>{
      const intent=effectiveIntent(row),real=actual&&!row.planned,changed=real&&(intent?intent==='change':row.directionChanged===true);
      const start=real&&(!started||changed);
      if(start){section++;started=true;}
      const trigger=row.decision?.trigger;
      const operation=!real?'planned':changed?'change':intent==='recover'?'recover'
        :intent==='continue'||['natural','next_button'].includes(trigger)||['next','ended_fallback'].includes(row.source)?'natural':'unknown';
      return {...row,section,routeStart:start,operation,color:directionColor(section)};
    });
    for(let i=0;i<steps.length;i++){
      const next=steps[i+1];
      steps[i].contextMismatch=!!steps[i].contextMismatch || !!(next?.decision?.trigger==='like_button' && next.previousAttemptId && next.previousAttemptId===steps[i].occurrence);
    }
    const first=steps.find(row=>actual&&!row.planned);
    const sectionRows=new Map();
    for(const row of steps){const list=sectionRows.get(row.section)||[];list.push(row);sectionRows.set(row.section,list);}
    for(const root of steps){
      root.routeRoot=false;
      if(!actual||root.planned||!root.routeStart)continue;
      const ids=new Set([root.id,root.resourceId,...(root.decision?.recordingMembers||[])].filter(Boolean));
      root.routeRoot=root===first||(sectionRows.get(root.section)||[]).some(row=>{
        if(row===root||row.planned||row.section!==root.section||row.routeStart)return false;
        const p=row.decision?.policyDetails;
        if(p&&(Object.hasOwn(p,'origin_key')||Object.hasOwn(p,'direction_keys'))){
          return ids.has(p.origin_key)||(p.direction_keys||[]).some(id=>ids.has(id));
        }
        // Old records lack core snapshots: use the saved positive references, then the played section.
        const refs=row.decision?.contextReferences;
        return refs?.length?refs.some(ref=>ids.has(ref.resourceId)):true;
      });
    }
    const chosen=steps.find(row=>row.occurrence===selectedOccurrence);
    const visibleSections=new Set(steps.filter(row=>actual&&!row.planned).map(row=>row.section));
    const regions=[...visibleSections].filter(id=>id>0&&id<=section).map(id=>({id,color:steps.find(row=>row.section===id)?.color,active:id===section,selected:id===chosen?.section,
      excludedIds:[...new Set(steps.filter(row=>row.section===id&&row.contextMismatch).map(row=>row.id))],
      ids:[...new Set(steps.filter(row=>actual&&!row.planned&&row.section===id&&!row.contextMismatch&&row.id).map(row=>row.id))],
      links:steps.flatMap((row,i)=>{const prev=steps[i-1];return actual&&prev&&!row.planned&&!prev.planned&&!row.omittedBefore
        &&!row.contextMismatch&&!prev.contextMismatch&&row.section===id&&prev.section===id&&row.id&&prev.id?[[prev.id,row.id]]:[];})}));
    return {steps,regions,section};
  }
  function effectiveIntent(row){
    const d=row?.decision,p=d?.policyDetails;
    if(['continue','recover','change'].includes(p?.effective_intent))return p.effective_intent;
    if(['continue','recover','change'].includes(d?.intent))return d.intent;
    if(row?.source==='dislike_next')return 'change';
    if(d?.trigger==='like_button')return 'recover';
    return ['natural','next_button'].includes(d?.trigger)?'continue':'';
  }
  const api={distance,localLayout,frontier,pairs,routePresentation,effectiveIntent};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.FlowaveSoundMapModel=api;
})(typeof self!=='undefined'?self:globalThis);
