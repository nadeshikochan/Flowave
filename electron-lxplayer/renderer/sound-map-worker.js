/* Only small visible-neighborhood geometry runs here; no audio/model imports. */
importScripts('sound-map-model.js');
self.onmessage=event=>{
  const {request,payload}=event.data;
  try{self.postMessage({request,result:self.FlowaveSoundMapModel.localLayout(payload)});}
  catch(_){self.postMessage({request,error:'附近歌曲暂时无法展开。'});}
};
