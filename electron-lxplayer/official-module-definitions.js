// Host-owned allowlist. A downloaded manifest cannot expand the host API or paths.
const definitions={
  history:{name:'听歌记录',entries:['module.js'],files:['module.js','view.html']},
  recommendation:{name:'歌曲推荐',entries:['sound-map-model.js','sound-map-scene.js','recommendation-inspector.js','sound-map.js'],files:['sound-map-model.js','sound-map-scene.js','recommendation-inspector.js','sound-map.js','sound-map-worker.js']},
  analysis:{name:'歌曲分析',entries:['music-analysis.js'],files:['music-analysis.js']},
  practice:{name:'演奏练习',entries:['stem-player.js','stem-pages.js','practice-training.js','practice-ui-loader.js'],files:['stem-player.js','stem-pages.js','practice-training.js','practice-ui-loader.js','practice-note-layout.js','practice-score.js','practice.js','vendor/vexflow-4.2.5.js'],optionalFiles:['vendor/vexflow-LICENSE.txt']},
};
module.exports=Object.freeze(definitions);
