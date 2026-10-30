(function(root){
  'use strict';
  const palette=['#6199ad','#a587b5','#8fa76b','#b38667','#6c9b8b','#8f94c5','#ba7e8e','#75a8ac'];
  const colorCache=new Map();
  const rgb=color=>{if(colorCache.has(color))return colorCache.get(color);const m=/^#([0-9a-f]{6})$/i.exec(color);const value=m?[0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)/255):[.55,.6,.7];colorCache.set(color,value);return value;};
  class SoundMapScene{
    constructor(container,callbacks){
      this.host=container;this.callbacks=callbacks;this.yaw=-.35;this.pitch=.17;this.zoom=1;this.target=[0,0,0];this.range=2.4;this.active=false;this.frame=0;this.data={nodes:[],edges:[]};this.images=new Map();this.hits=[];this.pan={x:0,y:0};
      this.canvas=document.createElement('canvas');this.overlay=document.createElement('canvas');this.canvas.className='sound-map-gpu';this.overlay.className='sound-map-overlay';this.overlay.tabIndex=0;this.overlay.setAttribute('aria-label','三维歌曲地图，拖动旋转，滚轮缩放；也可以使用右侧歌曲列表');container.append(this.canvas,this.overlay);
      this.ctx=this.overlay.getContext('2d');this.gl=this.canvas.getContext('webgl',{alpha:true,antialias:true,powerPreference:'low-power'});
      if(this.gl)this.initGL();
      this.down=e=>{if(e.button!==0&&e.button!==1)return;e.preventDefault();this.transition=null;clearTimeout(this.clickTimer);let pivot=null,camera=null;if(e.button===0&&this.data.rotateAtPointer){const rect=this.overlay.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,hit=[...this.hits].reverse().find(p=>x>=p.x&&x<=p.x+p.w&&y>=p.y&&y<=p.y+p.h);if(hit)pivot=hit.node.position.slice();else{const scale=Math.min(rect.width,rect.height)*1.5*this.zoom/3.3;const offset=this.inverseRotate([(x-rect.width/2-this.pan.x)/scale,(y-rect.height/2-this.pan.y)/scale,0]);pivot=offset.map((v,k)=>this.target[k]+v*this.range);}camera=this.rotate(pivot.map((v,k)=>v-this.target[k]));}this.drag={pivot,camera,button:e.button,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY};this.overlay.setPointerCapture(e.pointerId);};
      this.move=e=>{if(!this.drag){const rect=this.overlay.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,hit=[...this.hits].reverse().find(p=>x>=p.x&&x<=p.x+p.w&&y>=p.y&&y<=p.y+p.h);this.overlay.title=hit?(hit.node.playing?'当前 · ':'')+(hit.node.title||'')+' · '+(hit.node.kind==='group'?hit.node.count+' 首':hit.node.artist||''):'';this.overlay.style.cursor=hit?'pointer':'grab';return;}if(this.drag.button===1){this.pan.x+=e.clientX-this.drag.x;this.pan.y+=e.clientY-this.drag.y;}else{this.yaw+=(e.clientX-this.drag.x)*.006;this.pitch=Math.max(-1.3,Math.min(1.3,this.pitch+(e.clientY-this.drag.y)*.006));}if(this.drag.pivot){const offset=this.inverseRotate(this.drag.camera);this.target=this.drag.pivot.map((v,k)=>v-offset[k]);}this.drag.x=e.clientX;this.drag.y=e.clientY;this.request();};
      this.up=e=>{const drag=this.drag;this.drag=null;if(!drag||drag.button!==0||Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)return;const rect=this.overlay.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const hit=[...this.hits].reverse().find(p=>x>=p.x&&x<=p.x+p.w&&y>=p.y&&y<=p.y+p.h);if(hit){clearTimeout(this.clickTimer);if(!(e.detail===2&&this.lastClick&&performance.now()-this.lastClick.time<650))this.lastClick={node:hit.node,time:performance.now()};this.clickTimer=setTimeout(()=>{if(this.active)this.callbacks.select(hit.node,e.shiftKey);},300);return;}let best=null,nearest=6;for(const edge of this.edgeHits||[]){const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y,t=Math.max(0,Math.min(1,((x-edge.a.x)*dx+(y-edge.a.y)*dy)/(dx*dx+dy*dy||1))),distance=Math.hypot(x-edge.a.x-t*dx,y-edge.a.y-t*dy);if(distance<nearest){nearest=distance;best=edge.edge;}}if(best)this.callbacks.edge?.(best);};
      this.double=e=>{e.preventDefault();clearTimeout(this.clickTimer);const recent=this.lastClick;if(recent&&performance.now()-recent.time<650)this.callbacks.play?.(recent.node);this.lastClick=null;};this.aux=e=>e.preventDefault();
      this.wheel=e=>{e.preventDefault();const rect=this.overlay.getBoundingClientRect(),unit=e.deltaMode===1?16:e.deltaMode===2?rect.height:1;this.zoomBy(Math.exp(Math.max(-2,Math.min(2,-e.deltaY*unit*.0012))),{x:e.clientX-rect.left,y:e.clientY-rect.top});};
      this.key=e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft')this.yaw-=.12;if(e.key==='ArrowRight')this.yaw+=.12;if(e.key==='ArrowUp')this.pitch-=.1;if(e.key==='ArrowDown')this.pitch+=.1;if(e.key==='+')this.zoomBy(1.2);if(e.key==='-')this.zoomBy(1/1.2);this.request();}};
      this.cancel=()=>this.drag=null;this.visibility=()=>this.request();
      this.lost=e=>{e.preventDefault();this.gl=null;this.request();};
      this.overlay.addEventListener('dblclick',this.double);this.overlay.addEventListener('auxclick',this.aux);this.overlay.addEventListener('pointerdown',this.down);this.overlay.addEventListener('pointermove',this.move);this.overlay.addEventListener('pointerup',this.up);this.overlay.addEventListener('pointercancel',this.cancel);this.overlay.addEventListener('wheel',this.wheel,{passive:false});this.overlay.addEventListener('keydown',this.key);this.canvas.addEventListener('webglcontextlost',this.lost);document.addEventListener('visibilitychange',this.visibility);
      this.resize=new ResizeObserver(()=>this.request());this.resize.observe(container);
      this.themeObserver=new MutationObserver(()=>this.request());this.themeObserver.observe(container.closest('[data-theme]')||document.documentElement,{attributes:true,attributeFilter:['data-theme','class','style']});window.addEventListener('resize',this.visibility);
    }
    initGL(){const gl=this.gl;const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('shader');return s;};
      try{const vs=shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec4 c;attribute float size;varying vec4 color;void main(){gl_Position=vec4(p,1.);gl_PointSize=size;color=c;}'),fs=shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec4 color;uniform bool points;void main(){if(points&&distance(gl_PointCoord,vec2(.5))>.5)discard;gl_FragColor=color;}');this.program=gl.createProgram();gl.attachShader(this.program,vs);gl.attachShader(this.program,fs);gl.linkProgram(this.program);gl.deleteShader(vs);gl.deleteShader(fs);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw Error('program');this.buffer=gl.createBuffer();gl.useProgram(this.program);this.attributes=['p','c','size'].map(n=>gl.getAttribLocation(this.program,n));this.pointsUniform=gl.getUniformLocation(this.program,'points');}
      catch(_){this.gl=null;}
    }
    setActive(active){this.active=active;if(!active){clearTimeout(this.clickTimer);this.lastClick=null;cancelAnimationFrame(this.frame);this.frame=0;this.drag=null;if(this.transition){this.target=this.transition.to;this.range=this.transition.toRange;this.transition=null;}}else this.request();}
    update(data,fit=false){this.data=data;if(fit){this.pan={x:0,y:0};const nodes=data.nodes.filter(n=>!n.background);if(nodes.length){const oldTarget=this.target.slice(),oldRange=this.range;this.target=[0,1,2].map(k=>nodes.reduce((s,n)=>s+n.position[k],0)/nodes.length);this.range=Math.max(.06,...nodes.map(n=>Math.hypot(...n.position.map((x,k)=>x-this.target[k]))+(n.radius||0)*.45));this.zoom=1;this.fitTarget=this.target.slice();if(this.drawCount&&!matchMedia('(prefers-reduced-motion: reduce)').matches){this.transition={from:oldTarget,fromRange:oldRange,to:this.target.slice(),toRange:this.range,start:performance.now()};this.target=oldTarget;this.range=oldRange;}}}this.request();}
    zoomBy(value,point){
      if(!Number.isFinite(value)||value<=0)return;
      this.transition=null;
      const next=Math.max(.3,Math.min(14,this.zoom*value)),ratio=next/this.zoom;
      if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y)){
        // Projection scales linearly with zoom at every depth; compensate pan
        // around the pointer, preserving the world point beneath it exactly.
        const rect=this.overlay.getBoundingClientRect();
        this.pan.x=point.x-rect.width/2-(point.x-rect.width/2-this.pan.x)*ratio;
        this.pan.y=point.y-rect.height/2-(point.y-rect.height/2-this.pan.y)*ratio;
      }
      this.zoom=next;this.callbacks.zoom?.(this.zoom);this.request();
    }
    reset(){this.transition=null;if(this.fitTarget)this.target=this.fitTarget.slice();this.pan={x:0,y:0};this.yaw=-.35;this.pitch=.17;this.zoom=1;this.request();}
    request(){if(this.active&&!document.hidden&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});}
    rotate(p){const cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch),z=-p[0]*sy+p[2]*cy;return[p[0]*cy+p[2]*sy,p[1]*cp-z*sp,p[1]*sp+z*cp];}
    inverseRotate(p){const cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch),z=-p[1]*sp+p[2]*cp;return[p[0]*cy-z*sy,p[1]*cp+p[2]*sp,p[0]*sy+z*cy];}
    project(position,w,h){const p=position.map((x,k)=>(x-this.target[k])/this.range),x=p[0]*Math.cos(this.yaw)+p[2]*Math.sin(this.yaw),z0=-p[0]*Math.sin(this.yaw)+p[2]*Math.cos(this.yaw),y=p[1]*Math.cos(this.pitch)-z0*Math.sin(this.pitch),z=p[1]*Math.sin(this.pitch)+z0*Math.cos(this.pitch),scale=Math.min(w,h)*1.5*this.zoom/(3.3-z);return{x:w*.5+x*scale+this.pan.x,y:h*.5+y*scale+this.pan.y,z,scale};}
    drawRegions(ctx,byId,w,h,accent){
      const regions=this.data.regions||[];
      if(!regions.length)return;
      if(!this.regionMask)this.regionMask=document.createElement('canvas');
      const mask=this.regionMask;
      if(mask.width!==Math.round(w)||mask.height!==Math.round(h)){mask.width=Math.round(w);mask.height=Math.round(h);}
      const mc=mask.getContext('2d');
      for(const region of [...regions].sort((a,b)=>Number(a.active)-Number(b.active))){
        const points=region.ids.map(id=>byId.get(id)).filter(n=>n&&n.x>-40&&n.x<w+40&&n.y>-40&&n.y<h+40);
        if(!points.length)continue;
        // Proximity components produce compact patches, independent of zig-zag playback order.
        const remaining=new Set(points),components=[];
        while(remaining.size){const first=remaining.values().next().value,part=[first];remaining.delete(first);
          for(let i=0;i<part.length;i++)for(const n of remaining)if(Math.hypot(n.x-part[i].x,n.y-part[i].y)<105&&part.every(p=>Math.hypot(n.x-p.x,n.y-p.y)<200)){part.push(n);remaining.delete(n);}
          components.push(part);
        }
        const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
        const hull=part=>{const sorted=[...part].sort((a,b)=>a.x-b.x||a.y-b.y),half=items=>{const out=[];for(const p of items){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};return sorted.length<3?sorted:half(sorted).slice(0,-1).concat(half([...sorted].reverse()).slice(0,-1));};
        mc.clearRect(0,0,w,h);mc.globalCompositeOperation='source-over';mc.fillStyle=mc.strokeStyle=region.color||accent;
        mc.lineWidth=52;mc.lineJoin=mc.lineCap='round';
        for(const part of components){const boundary=hull(part);mc.beginPath();mc.moveTo(boundary[0].x,boundary[0].y);for(const p of boundary.slice(1))mc.lineTo(p.x,p.y);if(boundary.length>2)mc.closePath();mc.fill();mc.stroke();if(boundary.length===1){mc.beginPath();mc.arc(boundary[0].x,boundary[0].y,26,0,Math.PI*2);mc.fill();}}
        // Contextual mismatches stay visible at their true coordinates, outside the fill.
        mc.globalCompositeOperation='destination-out';
        for(const id of region.excludedIds||[]){const n=byId.get(id);if(n){mc.beginPath();mc.arc(n.x,n.y,27,0,Math.PI*2);mc.fill();}}
        mc.globalCompositeOperation='source-over';ctx.globalAlpha=.13;ctx.drawImage(mask,0,0);ctx.globalAlpha=1;
      }
    }
    loadImage(source){if(!source)return null;if(this.images.has(source))return this.images.get(source);if(this.images.size>=160){const first=this.images.keys().next().value,previous=this.images.get(first);previous.onload=null;previous.onerror=null;previous.src='';this.images.delete(first);}const img=new Image();img.onload=()=>this.request();img.onerror=()=>{img.failed=true;};img.src=source;this.images.set(source,img);return img;}
    draw(){this.drawCount=(this.drawCount||0)+1;if(this.transition){const a=this.transition,t=Math.min(1,(performance.now()-a.start)/280),ease=t*t*(3-2*t);this.target=a.from.map((x,k)=>x+(a.to[k]-x)*ease);this.range=a.fromRange+(a.toRange-a.fromRange)*ease;if(t>=1)this.transition=null;else this.request();}const rect=this.host.getBoundingClientRect(),w=rect.width,h=rect.height;if(w<1||h<1)return;const dpr=Math.min(devicePixelRatio||1,2),ctx=this.ctx;for(const c of [this.canvas,this.overlay])if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);this.hits=[];
      const style=getComputedStyle(this.host),ink=style.getPropertyValue('--text').trim()||'#20232a',sub=style.getPropertyValue('--sub').trim()||'#727985',accent=style.getPropertyValue('--accent').trim()||'#d22d2d',bg=style.getPropertyValue('--bg').trim()||'#f3f4f6';
      const nodes=this.data.nodes.map(n=>({...n,...this.project(n.position,w,h)}));const byId=new Map(nodes.map(n=>[n.id,n]));const degree=new Map();let renderEdges=this.data.denseRelations?this.data.edges:[...this.data.edges].sort((a,b)=>(Number(!!b.route)-Number(!!a.route))||(Number(!!b.selected)-Number(!!a.selected))||((b.strength||0)-(a.strength||0))).filter(edge=>{if(edge.route||edge.selected)return true;const limit=byId.get(edge.source)?.selected||byId.get(edge.target)?.selected?8:2;if((degree.get(edge.source)||0)>=limit||(degree.get(edge.target)||0)>=limit)return false;degree.set(edge.source,(degree.get(edge.source)||0)+1);degree.set(edge.target,(degree.get(edge.target)||0)+1);return true;});const routeRepresentatives=new Set();renderEdges=[...renderEdges].reverse().filter(edge=>{
        if(!edge.route)return true;
        const key=JSON.stringify([edge.source,edge.target,edge.operation,!!edge.routeActive,!!edge.selected]);
        if(routeRepresentatives.has(key))return false;routeRepresentatives.add(key);return true;
      }).reverse();
      this.edgeHits=renderEdges.map(edge=>({edge,a:byId.get(edge.source),b:byId.get(edge.target)})).filter(e=>e.a&&e.b&&!e.edge.route);const vertex=(p,color,alpha,size)=>[p.x/w*2-1,1-p.y/h*2,Math.max(-.99,Math.min(.99,-p.z*.2)),...rgb(color),alpha,size*dpr];const lines=[],dots=[];this.drawRegions(ctx,byId,w,h,accent);
      const routeCounts=new Map(),routeSeen=new Map();
      const pairKey=e=>[e.source,e.target].sort().join('|');
      for(const edge of renderEdges)if(edge.route)routeCounts.set(pairKey(edge),(routeCounts.get(pairKey(edge))||0)+1);
      for(const edge of [...renderEdges].sort((a,b)=>Number(!!a.route)-Number(!!b.route)||Number(!!a.routeActive)-Number(!!b.routeActive))){
        const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b)continue;
        const out=p=>(p.x<-32?1:p.x>w+32?2:0)|(p.y<-32?4:p.y>h+32?8:0);if(out(a)&out(b))continue;
        const selected=edge.selected||a.selected||b.selected;
        const strength=Number.isFinite(edge.strength)?edge.strength:.5;
        const color=edge.route?(edge.color||accent):(edge.color||palette[a.group%palette.length]);
        if(!edge.route){
          const alpha=edge.selected?.95:selected?.2+.6*strength:edge.strong?.06+.12*strength:.015+.055*strength;
          lines.push(...vertex(a,color,alpha,1),...vertex(b,color,alpha,1));continue;
        }
        ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;
        ctx.globalAlpha=edge.selected?1:.64;
        ctx.lineWidth=edge.selected?2:edge.operation==='change'?1.8:1.15;
        ctx.setLineDash(edge.planned?[3,5]:edge.operation==='recover'?[6,4]:[]);
        const key=pairKey(edge),seen=routeSeen.get(key)||0;routeSeen.set(key,seen+1);
        if(edge.source===edge.target){ctx.beginPath();ctx.arc(a.x+13,a.y-10,13+seen*3,.15,Math.PI*1.9);ctx.stroke();ctx.restore();continue;}
        const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
        const offset=Math.max(-25,Math.min(25,(seen-((routeCounts.get(key)||1)-1)/2)*10));
        const cx=(a.x+b.x)/2-dy/length*offset,cy=(a.y+b.y)/2+dx/length*offset;
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(cx,cy,b.x,b.y);ctx.stroke();ctx.setLineDash([]);
        let prior=a;for(let sample=1;sample<=10;sample++){const v=sample/10,point={x:(1-v)**2*a.x+2*(1-v)*v*cx+v*v*b.x,y:(1-v)**2*a.y+2*(1-v)*v*cy+v*v*b.y};this.edgeHits.push({edge,a:prior,b:point});prior=point;}
        const t=.6,x=(1-t)**2*a.x+2*(1-t)*t*cx+t*t*b.x,y=(1-t)**2*a.y+2*(1-t)*t*cy+t*t*b.y;
        const angle=Math.atan2((1-t)*(cy-a.y)+t*(b.y-cy),(1-t)*(cx-a.x)+t*(b.x-cx));
        for(let j=0;j<(edge.operation==='change'?2:1);j++){
          const xx=x-j*6*Math.cos(angle),yy=y-j*6*Math.sin(angle);
          ctx.beginPath();ctx.moveTo(xx-5*Math.cos(angle-.5),yy-5*Math.sin(angle-.5));ctx.lineTo(xx,yy);ctx.lineTo(xx-5*Math.cos(angle+.5),yy-5*Math.sin(angle+.5));ctx.stroke();
        }
        ctx.restore();
      }
      for(const n of nodes)dots.push(...vertex(n,n.selected?accent:n.tagMatch===false?'#9ba1aa':n.tagMatch===true?accent:n.routeColor||palette[n.group%palette.length],n.tagMatch===false?.12:n.background?.2:n.kind==='group'?.85:n.routeColor?.9:.65,n.routeRoot?18:n.selected?11:n.background?2.5:n.kind==='group'?10:5));
      if(this.gl){const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(this.program);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);const paint=(data,type,points)=>{if(!data.length)return;gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data),gl.DYNAMIC_DRAW);for(let i=0;i<3;i++){gl.enableVertexAttribArray(this.attributes[i]);gl.vertexAttribPointer(this.attributes[i],[3,4,1][i],gl.FLOAT,false,32,[0,12,28][i]);}gl.uniform1i(this.pointsUniform,points?1:0);gl.drawArrays(type,0,data.length/8);};paint(lines,gl.LINES,false);gl.enable(gl.DEPTH_TEST);paint(dots,gl.POINTS,true);gl.disable(gl.DEPTH_TEST);}
      else{for(const edge of renderEdges){if(edge.route)continue;const a=byId.get(edge.source),b=byId.get(edge.target);if(!a||!b)continue;ctx.strokeStyle=edge.route?(edge.operation==='recover'?'#b98631':edge.operation==='change'?'#777bc4':accent):'#8c9baa40';ctx.globalAlpha=1;ctx.setLineDash(edge.planned||edge.operation==='recover'?[5,4]:[]);ctx.lineWidth=edge.operation==='change'?2:1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}ctx.setLineDash([]);for(const n of nodes){ctx.globalAlpha=n.background?.1:.7;ctx.fillStyle=n.selected?accent:n.routeColor||palette[n.group%palette.length];ctx.beginPath();ctx.arc(n.x,n.y,n.routeRoot?9:n.selected?5.5:n.kind==='group'?5:2.5,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;}
      // Reserve actual icon bounds first; captions never displace songs or cover another icon.
      const boxes=[],captions=[],visibleMetadata=[];
      const overlap=(a,b,pad=7)=>a.x<b.x+b.w+pad&&a.x+a.w+pad>b.x&&a.y<b.y+b.h+pad&&a.y+a.h+pad>b.y;
      const inside=r=>r.x>=10&&r.x+r.w<=w-10&&r.y>=70&&r.y+r.h<=h-60;
      const ordered=nodes.filter(n=>!n.background).sort((a,b)=>((b.selected?1000:0)+(b.playing?500:0)+(b.routeRoot?350:0)+(b.routeStart?180:0)+(b.kind==='group'?100:0))-((a.selected?1000:0)+(a.playing?500:0)+(a.routeRoot?350:0)+(a.routeStart?180:0)+(a.kind==='group'?100:0))||b.z-a.z);
      const budget=Math.max(4,Math.min(this.data.labelBudget||16,Math.floor(w*h/22000)));
      for(const n of ordered){
        if(n.x<10||n.x>w-10||n.y<70||n.y>h-60)continue;
        this.hits.push({node:n,x:n.x-9,y:n.y-9,w:18,h:18});if(this.data.hideArtwork&&n.id!==this.data.revealedNodeId)continue;
        const important=n.selected||n.playing,group=n.kind==='group',size=important||n.routeRoot?46:n.routeStart?40:group?40:28;
        const box={x:n.x-size/2,y:n.y-size/2,w:size,h:size};
        if(!inside(box)||boxes.some(a=>overlap(a,box,important?2:12))||boxes.length>=budget&&!important)continue;
        boxes.push({...box,node:n});if(n.coverNeeded&&n.trackId)visibleMetadata.push(n.trackId);
        ctx.globalAlpha=n.tagMatch===false?.25:1;
        const img=this.loadImage(n.cover);
        if(img?.complete&&img.naturalWidth&&!img.failed)ctx.drawImage(img,box.x,box.y,size,size);
        else{ctx.fillStyle=bg;ctx.fillRect(box.x,box.y,size,size);ctx.fillStyle=palette[n.group%palette.length];ctx.font='20px sans-serif';ctx.fillText('♪',box.x+size*.28,box.y+size*.72);}
        if(n.routeStart){ctx.strokeStyle=n.routeColor||accent;ctx.lineWidth=1.25;ctx.beginPath();ctx.roundRect(box.x-6,box.y-6,size+12,size+12,9);ctx.stroke();}
        if(n.contextMismatch){ctx.save();ctx.strokeStyle=sub;ctx.lineWidth=1.5;ctx.setLineDash([3,3]);ctx.strokeRect(box.x-4,box.y-4,size+8,size+8);ctx.setLineDash([]);ctx.font='600 14px sans-serif';ctx.fillStyle=sub;ctx.fillText('×',box.x+size+4,box.y+8);ctx.restore();}
        if(important){ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.strokeRect(box.x-3,box.y-3,size+6,size+6);}
        if(n.number!==undefined){ctx.font='600 11px sans-serif';ctx.lineWidth=4;ctx.strokeStyle=bg;ctx.strokeText(n.number,box.x,box.y-8);ctx.fillStyle=n.routeColor||accent;ctx.fillText(n.number,box.x,box.y-8);}
        this.hits.push({node:n,...box});ctx.globalAlpha=1;
      }
      for(const icon of boxes){
        const n=icon.node;const group=n.kind==='group',labelW=group?154:144,labelH=36;
        let box=null;
        for(const r of [{x:icon.x+icon.w+9,y:icon.y+3,w:labelW,h:labelH},{x:icon.x-labelW-9,y:icon.y+3,w:labelW,h:labelH},{x:icon.x,y:icon.y+icon.h+9,w:labelW,h:labelH}]){
          if(inside(r)&&!boxes.some(a=>a!==icon&&overlap(a,r))&&!captions.some(a=>overlap(a,r))){box=r;break;}
        }
        if(!box)continue;captions.push(box);
        const fit=text=>{let value=String(text||'');while(value.length&&ctx.measureText(value+'…').width>labelW)value=value.slice(0,-1);return value===String(text||'')?value:value+'…';};
        const text=(value,y,color,font)=>{ctx.font=font;const valueFit=fit(value);ctx.lineWidth=4;ctx.lineJoin='round';ctx.strokeStyle=bg;ctx.strokeText(valueFit,box.x,y);ctx.fillStyle=color;ctx.fillText(valueFit,box.x,y);};
        text(n.title,box.y+12,n.selected?accent:ink,'600 12px "Segoe UI","Microsoft YaHei",sans-serif');
        text(group?n.count+' 首':n.artist,box.y+29,sub,'11px "Segoe UI","Microsoft YaHei",sans-serif');
        this.hits.push({node:n,...box});
      }
      this.labelBoxes=captions;this.iconBoxes=boxes;
      this.callbacks.visible?.(visibleMetadata.slice(0,45));
    }
    destroy(){this.setActive(false);this.resize.disconnect();this.themeObserver.disconnect();window.removeEventListener('resize',this.visibility);document.removeEventListener('visibilitychange',this.visibility);clearTimeout(this.clickTimer);this.overlay.removeEventListener('dblclick',this.double);this.overlay.removeEventListener('auxclick',this.aux);this.overlay.removeEventListener('pointerdown',this.down);this.overlay.removeEventListener('pointermove',this.move);this.overlay.removeEventListener('pointerup',this.up);this.overlay.removeEventListener('pointercancel',this.cancel);this.overlay.removeEventListener('wheel',this.wheel);this.overlay.removeEventListener('keydown',this.key);this.canvas.removeEventListener('webglcontextlost',this.lost);for(const img of this.images.values()){img.onload=null;img.onerror=null;img.src='';}this.images.clear();if(this.gl){this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program);}this.regionMask=null;this.canvas.remove();this.overlay.remove();}
  }
  root.FlowaveSoundMapScene=SoundMapScene;
})(window);
