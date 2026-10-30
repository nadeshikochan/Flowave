// The original history writer remains the sole owner. A recommendation-only
// renderer sees learning fields; it cannot zero or rewrite saved listening stats.
function recommendationView(history = {}) {
  const tracks = Object.fromEntries(Object.entries(history.tracks || {}).map(([key, row]) => [key, {
    path: row.path, resourceId: row.resourceId, songKey: row.songKey,
    title: row.title, artist: row.artist, album: row.album, duration: row.duration,
    recommendationBehavior: row.recommendationBehavior,
  }]));
  return {version:history.version,persistenceRevision:history.persistenceRevision,updatedAt:history.updatedAt,
    recommendationBehaviorSummary:history.recommendationBehaviorSummary,tracks,totalPlays:0,totalSeconds:0,days:{}};
}
function mergeRecommendationView(current, incoming) {
  if (Number(incoming?.persistenceRevision || 0) !== Number(current?.persistenceRevision || 0)) throw Error('推荐学习版本已过期，原记录已保留。');
  const tracks = {...current.tracks};
  const byId = new Map(Object.entries(tracks).filter(([,row])=>row.resourceId).map(([key,row])=>[row.resourceId,key]));
  for (const [key, row] of Object.entries(incoming.tracks || {})) {
    const oldKey = row.resourceId ? byId.get(row.resourceId) || key : key;
    const old = tracks[oldKey] || {};
    const next = {...old};
    for (const field of ['path','resourceId','songKey','title','artist','album','duration','recommendationBehavior'])
      if (Object.hasOwn(row, field)) next[field] = row[field];
    tracks[key] = next;
    if (oldKey !== key) delete tracks[oldKey];
    if (row.resourceId) byId.set(row.resourceId,key);
  }
  return {...current,updatedAt:incoming.updatedAt,tracks,recommendationBehaviorSummary:incoming.recommendationBehaviorSummary};
}
module.exports = {recommendationView,mergeRecommendationView};
