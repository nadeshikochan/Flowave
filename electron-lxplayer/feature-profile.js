const fs=require('node:fs'),path=require('node:path');
// A template app.json is not evidence of a previous user. Once chosen, features
// and the package registry persist the new profile through subsequent launches.
function isExistingProfile(data){
  if(fs.existsSync(path.join(data,'config/features.json')))return true;
  try{const registry=JSON.parse(fs.readFileSync(path.join(require('./data-layout').dataLayout(data).packages,'registry.json'),'utf8'));if(registry.schema===1&&registry.profile==='basic')return false;}catch{}
  // A crash after saving the welcome marker can precede feature registration.
  // Read only this exact small payload, preserving the old evidence rule for
  // real profiles without parsing their potentially large renderer snapshot.
  const marker = '{"lx-first-use":"pending"}';
  const renderer = path.join(data, 'config/renderer_state.json');
  try {
    if (fs.statSync(renderer).size !== Buffer.byteLength(marker)
      || fs.readFileSync(renderer, 'utf8') !== marker) return true;
  } catch (error) {
    if (error.code !== 'ENOENT') return true;
  }
  if(['config/listening_history.json','config/listening-history-backups','config/listening-history-snapshots','library/listening','library/track_identities.json','library/track-analysis/results.sqlite3']
    .some(name=>fs.existsSync(path.join(data,name))))return true;
  try{const meta=JSON.parse(fs.readFileSync(path.join(data,'library/tracks.json'),'utf8'));return Array.isArray(meta.tracks)&&meta.tracks.length>0;}catch{return false;}
}
module.exports={isExistingProfile};
