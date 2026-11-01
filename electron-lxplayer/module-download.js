const {LIMIT,sha}=require('./official-package-store');
function allowed(url,redirect=false){
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('功能包下载地址不受信任。');
 if(u.hostname==='github.com'&&u.pathname.startsWith('/nadeshikochan/Flowave/releases/download/'))return u.href;
 if(redirect&&u.hostname==='release-assets.githubusercontent.com')return u.href;
 throw Error('功能包下载来源不受信任。');
}
async function downloadOfficialRelease(release,{fetch,signal,onProgress=()=>{}}){
 const control=new AbortController(),abort=()=>control.abort(),timer=setTimeout(abort,120000);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{
  let url=allowed(release.url),response;
  if(control.signal.aborted)throw Error('安装已取消，原版本保留。');
  for(let step=0;step<6;step++){
   try{response=await fetch(url,{signal:control.signal,redirect:'manual'});}
   catch(error){throw Error('无法连接 GitHub 插件下载服务，请检查网络或代理后重试。原版本保留。',{cause:error});}
   if(response.status>=300&&response.status<400){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('下载跳转缺少地址。');url=allowed(new URL(next,url).href,true);continue;}
   break;
  }
  if(!response?.ok){await response?.body?.cancel();throw Error(`插件下载失败（HTTP ${response?.status||'未知'}），请稍后重试。原版本保留。`);}
  const total=Number(response.headers.get('content-length'))||release.bytes||0;
  if(total>LIMIT||release.bytes>LIMIT)throw Error('功能包超过大小限制。');
  const reader=response.body.getReader(),chunks=[];let done=0;
  try{while(true){if(control.signal.aborted)throw Error('安装已取消或下载超时。');const result=await reader.read();if(result.done)break;done+=result.value.byteLength;if(done>LIMIT)throw Error('功能包超过大小限制。');chunks.push(Buffer.from(result.value));onProgress({phase:'download',done,total});}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=Buffer.concat(chunks);
  if((release.bytes&&bytes.length!==release.bytes)||sha(bytes)!==release.sha256)throw Error('功能包校验失败，原版本保留。');
  return bytes;
 }catch(error){
  if(control.signal.aborted)throw Error(signal?.aborted?'安装已取消，原版本保留。':'插件下载超时，请检查网络后重试。');
  throw error;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);control.abort();}
}
module.exports={downloadOfficialRelease};
