// Official built-in modules. Selection is persisted now and applied on next
// process start; no runtime audio/task teardown is disguised as hot unloading.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const IDS = Object.freeze(['analysis', 'history', 'practice', 'recommendation']);
const defaults = (enabled=true) => ({schema: 1, revision: 0, enabled: Object.fromEntries(IDS.map(id => [id, enabled]))});
function validate(value) {
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !value.enabled || IDS.some(id => typeof value.enabled[id] !== 'boolean')
      || Object.keys(value.enabled).some(id => !IDS.includes(id))) throw Error('功能选择文件无效，原文件已保留。');
  return {schema: 1, revision: value.revision, enabled: Object.fromEntries(IDS.map(id => [id, value.enabled[id]]))};
}
function signature(value) {
  return crypto.createHash('sha256').update(JSON.stringify([value.revision, ...IDS.map(id => value.enabled[id])])).digest('hex');
}
function createFeatureSelection(file, {available=()=>true,initialEnabled=true} = {}) {
  let selected, error = '',missing=false;
  try { selected = validate(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
  catch (e) {
    if (e.code === 'ENOENT') {selected = defaults(initialEnabled);missing=true;}
    else { error = String(e.message || e); selected = defaults(); selected.enabled = Object.fromEntries(IDS.map(id => [id, false])); }
  }
  const requested = JSON.parse(JSON.stringify(selected));
  const active = JSON.parse(JSON.stringify(selected));
  for(const id of IDS)if(!available(id))active.enabled[id]=false;
  let pending = Promise.resolve();
  async function persist(next){
    await fsp.mkdir(path.dirname(file), {recursive:true});
    const temp=`${file}.${crypto.randomUUID()}.tmp`;let handle;
    try{handle=await fsp.open(temp,'wx');await handle.writeFile(JSON.stringify(next));await handle.sync();await handle.close();handle=null;await fsp.rename(temp,file);missing=false;}
    finally{if(handle)await handle.close().catch(()=>{});await fsp.unlink(temp).catch(()=>{});}
  }
  const snapshot = () => ({active, selected, signature: signature(active), restartRequired: IDS.some(id => requested.enabled[id] !== selected.enabled[id]), error});
  return {
    get active() { return JSON.parse(JSON.stringify(active)); },
    get signature() { return signature(active); },
    snapshot: () => JSON.parse(JSON.stringify(snapshot())),
    initialize(){const job=pending.then(async()=>{if(missing&&!error)try{await persist(selected);}catch(e){error='功能选择初始化保存失败，当前启动选择保留：'+e.message;throw e;}});pending=job.catch(()=>{});return job;},
    select(id, enabled, revision) {
      const operation = pending.then(async () => {
        if (error) throw Error(error);
        if (!IDS.includes(id) || typeof enabled !== 'boolean') throw Error('未知功能或无效选择。');
        if (revision !== selected.revision) throw Error('功能选择已变化，请刷新后重试。');
        if (selected.enabled[id] === enabled) return snapshot();
        const next = validate({...selected, revision: selected.revision + 1, enabled: {...selected.enabled, [id]: enabled}});
        await persist(next);selected=next;
        return snapshot();
      });
      pending = operation.catch(() => {});
      return operation.then(value => JSON.parse(JSON.stringify(value)));
    },
    flush: () => pending,
  };
}
module.exports = {IDS, defaults, validate, signature, createFeatureSelection};
