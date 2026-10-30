"""Conservative display eligibility, separate from inference and persisted evidence.

Model-specific floors are product display heuristics, not calibrated probabilities.
All readers use this projection so weak tags never leak into facets or map counts.
"""
import math

# (absolute model score floor, fraction of the strongest suggestion in that group)
DISPLAY_LIMITS={
    'instrument':(.15,.35),
    'genre':(.15,.30),
    'mood':(.12,.60),
    'theme':(.12,.50),
}

def visible_groups(groups):
    result={}
    for kind,tags in (groups or {}).items():
        if kind not in DISPLAY_LIMITS:
            result[kind]=[];continue
        valid=[]
        for tag in tags if isinstance(tags,list) else []:
            if not isinstance(tag,dict):continue
            try:score=float(tag['score'])
            except (TypeError,ValueError,KeyError):continue
            if math.isfinite(score) and score>0:valid.append((tag,score))
        floor,relative=DISPLAY_LIMITS[kind]
        cutoff=max(floor,max((s for _,s in valid),default=0)*relative)
        result[kind]=[dict(tag) for tag,score in valid if score>=cutoff]
    return result

def visible_payload(payload):
    # Do not mutate DB objects or discard raw segment scores / energy evidence.
    result={**payload,'tags':visible_groups(payload.get('tags'))}
    if 'segments' in payload:
        result['segments']=[{**s,'tags':visible_groups(s.get('tags'))} for s in payload['segments']]
    return result
