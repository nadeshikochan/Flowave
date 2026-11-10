const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const revision=value=>crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
class ResourceManager{
  constructor(root){this.root=root;this.operation=null;this.last={};this.sequence=0;}
  catalog(){return JSON.parse(fs.readFileSync(path.join(this.root,'resources/catalog.json'),'utf8'));}
  ready(kind,id,item){try{const folder=path.join(this.root,'data/components/resources',kind,id,revision(item));return JSON.parse(fs.readFileSync(path.join(folder,'.ready.json'),'utf8')).revision===revision(item);}catch{return false;}}
  snapshot(){
    let data;try{data=this.catalog();}catch{return {};}
    return Object.fromEntries(Object.entries(data.modules).map(([id,item])=>{
      const items=[...(item.profiles||[]).map(key=>({id:key,name:data.profiles[key].name,ready:this.ready('runtimes',key,data.profiles[key]),bytes:0})),...(item.groups||[]).map(key=>({id:key,name:data.groups[key].name,ready:this.ready('assets',key,data.groups[key]),bytes:data.groups[key].files.reduce((n,row)=>n+row.bytes,0)}))];
      const progress=this.operation?.id===id?this.operation.progress:this.last[id]||{};
      return [id,{ready:items.every(row=>row.ready),items,license:item.license,downloadBytes:items.filter(row=>!row.ready).reduce((n,row)=>n+row.bytes,0),...progress,running:this.operation?.id===id}];
    }));
  }
  start(id,sender){
    const data=this.catalog();if(!Object.hasOwn(data.modules,id)||id==='history')throw Error('此功能不需要或不支持准备计算资源。');
    if(this.operation)throw Error('已有资源准备任务，请等待完成或先取消。');
    const candidates=[path.join(this.root,'backend/api.exe'),path.join(this.root,'build/backend/api/api.exe')];
    const exe=candidates.find(file=>fs.existsSync(file));if(!exe)throw Error('资源安装器缺失，请使用完整ZIP便携版。');
    const op={id,generation:++this.sequence,progress:{phase:'prepare'},cancelled:false,child:null,closed:null};this.operation=op;
    const send=value=>{if(this.operation!==op)return;op.progress={...op.progress,...value};if(!sender.isDestroyed())sender.send('lx-resource-progress',{id,...op.progress,status:this.snapshot()});};
    const child=spawn(exe,['--install-resources',id],{cwd:this.root,windowsHide:true,env:{...process.env,KUMIKO_APP_HOME:this.root,KUMIKO_DATA_DIR:path.join(this.root,'data'),PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
    op.child=child;let pending='',stderr='',finished=false;
    op.closed=new Promise(resolve=>{
      const finish=(code,error)=>{
        if(finished)return;finished=true;
        const entry=this.snapshot()[id],ok=code===0&&entry?.ready;
        this.last[id]={phase:ok?'complete':op.cancelled?'cancelled':'error',message:ok?'所需资源已准备好。':op.cancelled?'准备已取消，已下载文件可在重试时复用。':String(error?.message||op.progress.message||stderr.slice(-1000)||'资源准备未完成，请重试。')};
        if(this.operation===op){this.operation=null;if(!sender.isDestroyed())sender.send('lx-resource-progress',{id,...this.last[id],status:this.snapshot()});}
        resolve();
      };
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{pending+=chunk;const rows=pending.split(/\r?\n/);pending=rows.pop().slice(-8192);for(const row of rows)try{const value=JSON.parse(row);if(value&&typeof value==='object')send(value);}catch{}});
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));
    });
    return {ok:true,status:this.snapshot()};
  }
  async cancel(id){
    const op=this.operation;if(!op||op.id!==id)return;
    op.cancelled=true;
    if(op.child?.pid){const killer=spawn('taskkill.exe',['/PID',String(op.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise(resolve=>{killer.on('error',resolve);killer.on('close',resolve);});}
    await op.closed;
  }
  async close(){if(this.operation)await this.cancel(this.operation.id);}
}
module.exports={ResourceManager,revision};
