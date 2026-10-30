(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlowaveFolders = api;
})(typeof globalThis === "undefined" ? null : globalThis, () => {
  const clean = value => String(value || "").replace(/\\/g,"/").replace(/\/+$/, "");
  const key = value => clean(value).toLocaleLowerCase();
  const contains=(root,path)=>key(path)===key(root)||key(path).startsWith(key(root)+"/");
  function normalizeRoots(values) {
    const result=[];
    for(const raw of values||[]){const value=String(raw||"").trim();if(!value||result.some(r=>contains(r,value)))continue;
      const at=result.findIndex(r=>contains(value,r));for(let i=result.length-1;i>=0;i--)if(contains(value,result[i]))result.splice(i,1);
      result.splice(at<0?result.length:at,0,value);
    }return result;
  }
  // Only inspect the published paths, never probe offline drives from the renderer.
  function build(tracks, libraryRoot) {
    const roots=normalizeRoots(Array.isArray(libraryRoot)?libraryRoot:[libraryRoot]), nodes=new Map();
    const base=roots.length===1?clean(roots[0]):"";
    const make=(path,name,parent)=>{const node={path,key:key(path),name,parent,children:[],tracks:[],count:0};nodes.set(node.key,node);return node;};
    const root=make(base,"音乐文件夹",null),seen=new Set();
    if(roots.length>1)for(const raw of roots){const path=clean(raw);const node=make(path,path.split('/').pop()||path,root.key);root.children.push(node);}
    for(const track of tracks||[]){const path=clean(track?.path);if(!path||/^\w+:\/\//.test(path)||seen.has(key(path)))continue;
      const owner=roots.find(r=>contains(r,path));if(roots.length&&!owner)continue;seen.add(key(path));
      const ownerPath=clean(owner||""),parts=(ownerPath?path.slice(ownerPath.length+1):path).split('/').filter(Boolean);parts.pop();
      let node=roots.length>1?nodes.get(key(ownerPath)):root;root.count++;if(node!==root)node.count++;
      for(const part of parts){const nextPath=node.path?node.path+"/"+part:part;let next=nodes.get(key(nextPath));if(!next){next=make(nextPath,part,node.key);node.children.push(next);}next.count++;node=next;}
      node.tracks.push(track.path);
    }
    for(const node of nodes.values())node.children.sort((a,b)=>a.name.localeCompare(b.name,"zh-CN",{numeric:true,sensitivity:"base"}));
    return {root,nodes};
  }
  function breadcrumbs(tree,path) {
    const result=[];let node=tree.nodes.get(key(path))||tree.root;
    while(node){result.unshift(node);node=node.parent===null?null:tree.nodes.get(node.parent);}
    return result;
  }
  return {build,breadcrumbs,key,normalizeRoots,contains};
});
