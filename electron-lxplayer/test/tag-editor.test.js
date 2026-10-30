const test = require('node:test');
const assert = require('node:assert/strict');
const {createTagEditor} = require('../song-info/tag-editor');

test('current audio waits for a song switch; successful metadata outcome retains transaction and refresh status', async () => {
  const calls=[], events=[]; let finish;
  const editor=createTagEditor({request:async(action,payload)=>{
    calls.push(action);
    if(action==='prepare')return{ok:true,confirmationId:'token'};
    if(action==='commit')return new Promise(resolve=>finish=()=>resolve({ok:true,status:'committed',resourceId:'same-id',transactionId:'tx'}));
  },onChanged:async()=>{},onResult:result=>events.push(result)});
  editor.setPlayback('C:/Music/current.mp3',1);
  await editor.prepare({trackPath:'C:/Music/current.mp3',resourceId:'same-id',updates:{title:'Correct Title'}});
  assert.equal((await editor.commit('token')).status,'queued');
  assert.deepEqual(calls,['prepare']);
  editor.setPlayback('C:/Music/next.mp3',2);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['prepare','commit']);
  let released=false;
  const wait=editor.waitForTarget('C:/Music/current.mp3').then(result=>released=result.released);
  assert.equal(released,false);finish();await wait;await editor.drain();
  assert.equal(released,true);assert.equal(events[0].transactionId,'tx');assert.equal(events[0].resourceId,'same-id');
  editor.close();
});

test('failed writes report the controlled backend reason and shutdown cancels queued edits',async()=>{
  const events=[];let commits=0;
  const editor=createTagEditor({request:async action=>{
    if(action==='prepare')return{ok:true,confirmationId:'token'};
    if(action==='commit'){commits++;throw new Error('歌曲已被其他程序修改，请重新打开后保存');}
  },onResult:r=>events.push(r)});
  await editor.prepare({trackPath:'C:/Music/song.mp3'});
  const failed=await editor.commit('token');
  assert.equal(failed.ok,false);assert.match(failed.message,/其他程序修改/);
  await editor.drain();editor.setPlayback('C:/Music/song.mp3',1);
  await editor.prepare({trackPath:'C:/Music/song.mp3'});await editor.commit('token');editor.close();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commits,1);assert.equal(events.at(-1).status,'cancelled');
});
const testPending = test('pending reconciliation and normalized playback paths retain request identity', async () => {
  const events=[];
  const editor=createTagEditor({request:async action=>action==='prepare'
    ? {ok:true,confirmationId:'pending-token'}
    : {ok:true,status:'committed-pending-reconcile',transactionId:'pending-tx'},
    onChanged:async()=>{throw new Error('refresh failed');},onResult:r=>events.push(r)});
  editor.setPlayback('C:/Music/sub/../song.mp3',1);
  await editor.prepare({trackPath:'C:/Music/song.mp3'});
  const queued=await editor.commit('pending-token');
  assert.equal(queued.status,'queued');
  editor.setPlayback('',2);await editor.drain();
  assert.equal(events[0].requestId,queued.requestId);
  assert.equal(events[0].status,'committed-pending-reconcile');
  assert.equal(events[0].refreshFailed,true);
  editor.close();
});
