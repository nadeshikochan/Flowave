// Deterministic official code packages; never builds the player or models.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),folder=path.join(root,'electron-lxplayer/official-modules');
const definitions=require('../electron-lxplayer/official-module-definitions'),catalogFile=path.join(folder,'catalog.json');
const catalog=JSON.parse(fs.readFileSync(catalogFile,'utf8'));
for(const [id,definition] of Object.entries(definitions)){
 const manifest=JSON.parse(fs.readFileSync(path.join(folder,id,'manifest.json'),'utf8')),version=manifest.version;
 if(manifest.id!==id||manifest.hostApi!==1||!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid official module manifest');
 const source=id==='history'?path.join(folder,id):path.join(root,'electron-lxplayer/renderer');
 const files=Object.fromEntries([...definition.files,...definition.optionalFiles||[]].map(name=>[name,Buffer.from(fs.readFileSync(path.join(source,name),'utf8').replace(/\r\n?/g,'\n').replace(/\n*$/,'\n')).toString('base64')]));
 const bytes=Buffer.from(JSON.stringify({format:'flowave-official-module-v1',id,version,hostApi:1,files})+'\n');
 const sha256=crypto.createHash('sha256').update(bytes).digest('hex'),bundle=`${id}-${version}.fwm`;
 const item=catalog.packages[id]||{name:definition.name,latest:version,releases:[]},existing=item.releases.find(r=>r.version===version);
 if(existing&&existing.sha256!==sha256)throw Error(`${id} ${version}: published version is immutable; increment version before rebuilding`);
 if(!existing)item.releases.push({version,sha256,bundle,bytes:bytes.length});else existing.bytes=bytes.length;
 item.latest=version;catalog.packages[id]=item;fs.mkdirSync(path.join(folder,'packages'),{recursive:true});
 fs.writeFileSync(path.join(folder,'packages',bundle),bytes);console.log(`${id} ${version}: ${bytes.length} bytes`);
}
fs.writeFileSync(catalogFile,JSON.stringify(catalog,null,2)+'\n');
