// Deterministic offline official module; no app installer/model or user data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..','electron-lxplayer','official-modules'),source=path.join(root,'history');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));
if(manifest.id!=='history'||manifest.hostApi!==1||!/^\d+\.\d+\.\d+$/.test(manifest.version)
 ||manifest.files.join(',')!=='module.js,view.html')throw Error('Unsupported official module manifest');
const files=Object.fromEntries(manifest.files.map(name=>[name,Buffer.from(fs.readFileSync(path.join(source,name),'utf8').replace(/\r\n?/g,'\n')).toString('base64')]));
const bytes=Buffer.from(JSON.stringify({format:'flowave-official-module-v1',id:manifest.id,version:manifest.version,hostApi:1,files})+'\n');
const digest=crypto.createHash('sha256').update(bytes).digest('hex'),name=`history-${manifest.version}.fwm`,catalogPath=path.join(root,'catalog.json');
let catalog={hostApi:1,packages:{history:{name:'听歌记录',latest:manifest.version,releases:[]}}};
if(fs.existsSync(catalogPath))catalog=JSON.parse(fs.readFileSync(catalogPath,'utf8'));
const item=catalog.packages.history,existing=item.releases.find(row=>row.version===manifest.version);
if(existing&&existing.sha256!==digest)throw Error('Published module version is immutable; increment version');
if(!existing)item.releases.push({version:manifest.version,sha256:digest,bundle:name});item.latest=manifest.version;
fs.mkdirSync(path.join(root,'packages'),{recursive:true});fs.writeFileSync(path.join(root,'packages',name),bytes);
fs.writeFileSync(catalogPath,JSON.stringify(catalog,null,2)+'\n');
console.log(`Official history ${manifest.version}: ${bytes.length} bytes; ${digest}`);
