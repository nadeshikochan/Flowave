const test = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync } = require('node:zlib');
const axios = require('axios');
const { decodeKugouWordLyrics } = require('../lyrics/kugou-word-lyrics');
const { wordTimingQuality } = require('../lyrics/word-timing-quality');
const { createLddcStrategyLyricProvider } = require('../lyrics/lddc-strategy-provider');
const { normalizeLyricCandidate, rankLyricCandidates } = require('../lyrics/candidate-model');
const { LyricLookupService } = require('../lyrics/lookup-service');
const { buildUnifiedLyric, parseLyricChannel, exportEnhancedLrc } = require('../lyrics/unified-lyric');
const providers = require('../online/providers');

const evidence = { title:'Song', artists:['Singer'], album:'Album', durationSeconds:180 };
const words = () => buildUnifiedLyric({main:parseLyricChannel('[00:01.000]<00:01.000>A<00:01.200>B<00:02.000>')});
const sentence = () => buildUnifiedLyric({main:parseLyricChannel('[00:01.000]AB')});
function krc(text) {
  const zip=deflateSync(Buffer.from(text)),mask=Buffer.from('404761775e3274475136312dced26e69','hex');
  return Buffer.concat([Buffer.from('krc1'),Buffer.from(zip.map((v,i)=>v^mask[i%16]))]).toString('base64');
}
function candidate(id, model, overrides={}) {
  return normalizeLyricCandidate({id,trackName:'Song',artists:['Singer'],album:'Album',durationSeconds:180,unifiedLyrics:model,...overrides},
    {id:'fixture',version:'1',allowStructuredLyrics:true});
}

test('KRC keeps actual relative timing, Unicode, offset and zero duration; rejects corrupt timing',()=>{
  const model=decodeKugouWordLyrics(krc('[offset:-100]\n[1000,2000]<0,250,0>今日<400,0,0>も<900,1100,0>歌う'));
  assert.deepEqual(model.lines[0].main.words.map(w=>[w.startMs,w.endMs,w.text]),[[900,1150,'今日'],[1300,1300,'も'],[1800,2900,'歌う']]);
  assert.equal(wordTimingQuality(model).complete,true);
  const saved=buildUnifiedLyric({main:parseLyricChannel(exportEnhancedLrc(model))});
  assert.deepEqual(saved.lines[0].main.words.map(w=>[w.startMs,w.endMs,w.text]),model.lines[0].main.words.map(w=>[w.startMs,w.endMs,w.text]));
  assert.throws(()=>decodeKugouWordLyrics(Buffer.from('not KRC').toString('base64')));
  assert.throws(()=>decodeKugouWordLyrics(krc('[0,100]<2000,100,0>bad')));
});

test('partial word timing does not count as a complete word result',()=>{
  const model=words();model.lines.push(...sentence().lines,...sentence().lines);
  assert.equal(wordTimingQuality(model).coverage,1/3);
  assert.equal(wordTimingQuality(model).complete,false);
  assert.equal(wordTimingQuality(sentence()).complete,false);
  const startsOnly=buildUnifiedLyric({main:parseLyricChannel('[00:01.000]<00:01.000>A<00:01.200>B')});
  assert.equal(wordTimingQuality(startsOnly).complete,false);
  assert.ok(startsOnly.lines[0].main.words.at(-1).flags.includes('end_inferred'));
  const partial=words();partial.lines[0].main.text='AB CDEFGHIJKLMNOP';
  assert.equal(wordTimingQuality(partial).complete,false);
  const mixed=decodeKugouWordLyrics(krc('[1000,1000]<0,1000,0>Word\n[3000,1000]Only a sentence'));
  assert.equal(mixed.lines.length,2);assert.equal(wordTimingQuality(mixed).coverage,0.5);
});

test('batch inspects local timing before the network and sends existing sidecar upgrades to review', async () => {
  let localModel = words();
  let remoteModel = words();
  const requests = [];
  const service = new LyricLookupService({
    stat: async () => ({ isFile: () => true }),
    getMeta: async () => ({ title: "Song", titleFromTag: true, artists: ["Singer"], album: "Album", duration: 180 }),
    inspectSidecar: async () => ({ version: { exists: true, sha256: "prior-sidecar" } }),
    registry: {
      async queryAll({ providerIds, localContext }) {
        const [provider] = providerIds;
        requests.push(provider);
        if (provider === "local-library") {
          assert.deepEqual(localContext.sources, ["external", "sidecar", "embedded"]);
          const local = normalizeLyricCandidate({
            id: "local", trackName: "Song", artists: ["Singer"], durationSeconds: 180,
            unifiedLyrics: localModel, sourceType: "embedded", identityLevel: "strong", identityScore: 100,
          }, { id: "local-library", localOnly: true });
          return { candidates: [local], sources: [] };
        }
        return { candidates: [candidate(provider, remoteModel)], sources: [] };
      },
    },
  });
  const request = { trackPath: "Song.flac", storageTarget: "sidecar", onlyMissing: true,
    lyricSources: ["lddc"], lyricCompleteness: "word" };
  assert.equal((await service.query(request)).skipped, "complete");
  assert.deepEqual(requests.splice(0), ["local-library"]);
  localModel = sentence();
  assert.equal((await service.query({ ...request, lyricCompleteness: "line" })).skipped, "complete");
  assert.deepEqual(requests.splice(0), ["local-library"]);
  const upgrade = await service.query(request);
  assert.deepEqual(requests.splice(0), ["local-library", "lddc-strategy"]);
  assert.equal(upgrade.targetVersion, "prior-sidecar");
  assert.equal(upgrade.candidates[0].recommendation, "medium");
  assert.equal(upgrade.candidates[0].differences[0].current, true);
  remoteModel = sentence();
  const lineOnly = await service.query(request);
  assert.deepEqual(lineOnly.candidates, []);
  assert.equal(lineOnly.matchOutcome, "timing-insufficient");
  assert.deepEqual(requests, ["local-library", "lddc-strategy", "music-tag-strategy"]);
});

test("the exact KTV target short-circuits search and protects suspect timed files for review", async () => {
  const body = Buffer.from(exportEnhancedLrc(words()));
  let existing = body;
  const service = new LyricLookupService({
    stat: async () => ({ isFile: () => true }),
    getMeta: async () => ({ title: "Song", titleFromTag: true, artists: ["Singer"], duration: 180 }),
    inspectSidecar: async (_track, options) => {
      assert.equal(options.includeBody, true);
      return { body: existing, version: { exists: true, sha256: "current" } };
    },
    registry: { async queryAll() { assert.fail("existing word file must not enter provider lookup"); } },
  });
  const request = { trackPath: "Song.flac", storageTarget: "sidecar", lyricCompleteness: "word" };
  assert.equal((await service.query(request)).skipped, "complete");
  existing = Buffer.from("[ti:Different Track]\n" + body.toString());
  assert.equal((await service.query(request)).skipped, "local-review");
  existing = Buffer.from("[offset:300000]\n" + body.toString());
  assert.equal((await service.query(request)).skipped, "local-review");
});

test("a source with no lyrics is distinguished from wrong identity and partial source failure", async () => {
  let remote = [];
  let failed = false;
  const service = new LyricLookupService({
    stat: async () => ({ isFile: () => true }),
    getMeta: async () => ({ title: "Song", titleFromTag: true, artists: ["Singer"], duration: 180 }),
    registry: {
      async queryAll({ providerIds: [id] }) {
        const candidates = id === "lddc-strategy" ? remote : [];
        return { candidates, sources: [{ id, status: id === "lddc-strategy" && failed ? "timeout" : candidates.length ? "ok" : "empty" }] };
      },
    },
  });
  const request = { trackPath: "Song.flac", storageTarget: "sidecar", lyricCompleteness: "word" };
  assert.equal((await service.query(request)).matchOutcome, "source-empty");
  remote = [candidate("wrong-version", words(), { trackName: "Song (Live)" })];
  assert.equal((await service.query(request)).matchOutcome, "identity-rejected");
  remote = [];
  failed = true;
  assert.equal((await service.query(request)).matchOutcome, "source-incomplete");
});

test('one failed platform is isolated; a line result does not hide a later word result',async()=>{
  const fetched=[];
  const provider=createLddcStrategyLyricProvider({
    searchMusic:async source=>{if(source==='tx')throw Error('source down');return {list:[1,2,3,4].map(i=>({source,songId:String(i),title:'Song',artist:'Singer',album:'Album',duration:180}))};},
    getLyric:async(source,id,track,{signal})=>{assert.equal(signal,undefined);fetched.push(source+id);return {lyricsModel:id==='1'?sentence():words()};},
  });
  const results=await provider.query({evidence});
  assert.equal(results.length,4);
  assert.deepEqual(fetched.sort(),['kg1','kg2','wy1','wy2']);
});

test('candidate budget is three per source, and cancellation discards late results',async()=>{
  let calls=0;
  const controller=new AbortController();
  const provider=createLddcStrategyLyricProvider({searchMusic:async source=>({list:[1,2,3,4,5].map(i=>({source,songId:String(i),title:'Song',artist:'Singer',duration:180}))}),getLyric:async()=>{calls++;return {lyricsModel:sentence()};}});
  assert.equal((await provider.query({evidence})).length,9);assert.equal(calls,9);
  const cancelProvider=createLddcStrategyLyricProvider({searchMusic:async source=>({list:[{source,songId:'1',title:'Song',artist:'Singer',duration:180}]}),getLyric:async(source,id,track,{signal})=>{assert.equal(signal,controller.signal);controller.abort();return {lyricsModel:words()};}});
  assert.deepEqual(await cancelProvider.query({evidence,signal:controller.signal}),[]);
});

test('safe word timing outranks a high-priority line source; conflicting identity still loses',()=>{
  const ranked=rankLyricCandidates(evidence,[candidate('line',sentence(),{providerPriority:100}),candidate('word',words()),candidate('wrong',words(),{artists:['Other']})]);
  assert.equal(ranked[0].candidate.sourceRecordId,'word');
  assert.equal(ranked.at(-1).identityLevel,'reject');
});

test('line-only online matches continue through local sources and retain the best word model',async()=>{
  const calls=[];
  const service=new LyricLookupService({stat:async()=>({isFile:()=>true}),getMeta:async()=>({title:'Song',artists:['Singer'],album:'Album',duration:180}),registry:{queryAll:async({providerIds})=>{
    const id=providerIds[0];calls.push(id);
    return {candidates:id==='lddc-strategy'?[candidate('line',sentence(),{providerPriority:100})]:id==='local-library'?[candidate('word',words())]:[],sources:[]};
  }}});
  const result=await service.query({trackPath:'D:/Fixture/Song.mp3',onlyMissing:false});
  assert.deepEqual(calls,['lddc-strategy','music-tag-strategy','local-library']);
  assert.equal(result.candidates[0].candidate.candidateId.includes('word'),true);
  assert.equal(result.candidates[0].candidate.lyrics.lines[0].main.words.length,2);
});

test('Kugou transport prefers KRC, passes cancellation, and falls back to LRC after corrupt containers',async t=>{
  const original=axios.get;t.after(()=>{axios.get=original;});
  const controller=new AbortController(),formats=[];
  let valid=true, secondVariant=false;
  axios.get=async(url,options)=>{
    assert.equal(options.signal,controller.signal);
    if(url.endsWith('/search'))return {data:{candidates:(secondVariant?['1','2']:['1']).map(id=>({id,accesskey:'fixture',duration:180000}))}};
    formats.push(options.params.fmt);
    return {data:{content:options.params.fmt==='krc'?(valid?krc(secondVariant&&options.params.id==='1'?'[1000,1000]<0,1000,0>A\n[3000,1000]Only sentence':'[1000,1000]<0,250,0>A<250,750,0>B'):'broken'):Buffer.from('[00:01.000]AB').toString('base64')}};
  };
  const track={artist:'Singer',title:'Song',duration:180,raw:{hash:'A'.repeat(32)}};
  const first=await providers.getLyric('kg','1',track,{signal:controller.signal});
  assert.equal(wordTimingQuality(first.lyricsModel).complete,true);assert.deepEqual(formats,['krc']);
  valid=false;formats.length=0;
  const fallback=await providers.getLyric('kg','1',track,{signal:controller.signal});
  assert.equal(wordTimingQuality(fallback.lyricsModel).coverage,0);assert.deepEqual(formats,['krc','lrc']);
  valid=true;secondVariant=true;formats.length=0;
  const improved=await providers.getLyric('kg','1',track,{signal:controller.signal});
  assert.equal(wordTimingQuality(improved.lyricsModel).complete,true);assert.deepEqual(formats,['krc','krc']);
});

test('Netease v1 retains true YRC timing and old endpoint remains a failure fallback',async t=>{
  const original=axios.get;t.after(()=>{axios.get=original;});
  const urls=[];let failure=false;
  axios.get=async url=>{urls.push(url);if(failure&&url.includes('/v1?'))throw Error('unsupported');return {data:failure?{lrc:{lyric:'[00:01.000]AB'}}:{yrc:{lyric:'[5000,1000](5000,250,0)A(5250,750,0)B'}}};};
  assert.equal(wordTimingQuality((await providers.getLyric('wy','123')).lyricsModel).complete,true);
  failure=true;urls.length=0;
  assert.equal(wordTimingQuality((await providers.getLyric('wy','123')).lyricsModel).coverage,0);
  assert.equal(urls.length,2);assert.ok(urls[0].includes('/v1?'));assert.ok(!urls[1].includes('/v1?'));
});
