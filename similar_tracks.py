"""Deterministic single-song MERT neighbours, independent of session policy and MuQ availability."""
import numpy as np
from recommendation_engine import prepare


def rank(index, current, semantic=None, prepared=None, limit=100):
    # `semantic` remains accepted for caller compatibility; it never changes this ranking.
    keys, paths, matrix, positions = prepared if prepared is not None else prepare(index)
    if current not in positions:
        return dict(all_ranked=[], missing=True)
    query=positions[current]
    scores=matrix@matrix[query]
    ids=np.array([i for i in range(len(keys)) if i!=query],dtype=int)
    floor=float(scores[ids].max()-.025) if len(ids) else None
    eligible=ids[scores[ids]>=floor] if floor is not None else ids
    limit=max(1,min(200,int(limit)))
    order=eligible[np.lexsort((eligible,-scores[eligible]))][:limit]
    rows=[dict(path=paths[i],resource_id=keys[i],sim=float(scores[i]),
        mert_similarity=float(scores[i]),model='mert') for i in order]
    return dict(all_ranked=rows,missing=False,model='mert',fallback_reason=None,
        ranking_policy='mert-nearest-v1',query_resource_id=current,query_path=paths[query],
        ranked_count=len(eligible),compared_count=len(ids),relative_score_gap=.025,score_floor=floor,
        mert_neighbourhood_floor=floor,mert_candidate_count=len(eligible),analysis_missing=0,limit=limit)
