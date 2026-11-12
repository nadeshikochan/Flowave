"""Bounded explanations of completed decisions, using the same adjustment formulas as ranking."""
import numpy as np
from recommendation_signals import adjustments
from analysis_vocab import labels


def attach_evidence(rows, details, index, current, context, recent, session, semantic, tags, prepared, blocked, excluded):
    keys,paths,matrix,positions=prepared
    mode=details.get('effective_intent') or details.get('mode','continue')
    references=details.get('context_keys',context)
    details.update(evidence_version=1,origin_key=session.get('origin') or None,
        direction_keys=session.get('direction',[]),direction_strength=session.get('direction_strength',0),
        qualified_listens=session.get('qualified'),repair_active=session.get('repair_active'),
        route_keys=session.get('route',[]),recent_keys=recent,blocked_keys=[k for k in keys if paths[positions[k]] in set(blocked)],
        excluded_keys=excluded,negative_contexts=session.get('negatives',[]) if mode!='change' else [],
        direction_memories=session.get('memories',[]),context_keys=references)
    if not rows:return
    by_path={path:k for k,path in zip(keys,paths)}
    targets=[by_path[row['path']] for row in rows if row['path'] in by_path]
    needed=set([current,*references,*recent,*session.get('direction',[])])
    for n in session.get('negatives',[]):needed.update([n.get('key'),*n.get('positive',[])])
    for m in session.get('memories',[]):needed.update(m.get('keys',[]))
    needed.update(targets)
    subkeys=[k for k in keys if k in needed];subpaths=[index[k][0] for k in subkeys]
    submatrix=matrix[[positions[k] for k in subkeys]];subpos={k:i for i,k in enumerate(subkeys)}
    use_semantic=details.get('model') in {'muq+mert','muq_continuity_reserve'}
    effects={}
    adjustments(subkeys,subpaths,submatrix,semantic,tags,references,recent,session,mode,use_semantic,effects)
    # These are the actual ranking weights, not calibrated probabilities or inferred preferences.
    weights={}
    semrefs=[k for k in references if k in semantic]
    if use_semantic and mode=='continue' and not semrefs:
        semrefs=[current]
    if use_semantic and semrefs:
        decay=.7 if mode=='recover' or details.get('fallback')=='continuity_reserve' else .5
        ws=np.power(decay,np.arange(len(semrefs)-1,-1,-1));ws/=ws.sum()
        if mode!='change':
            weights.update({k:float(w*(.15 if mode=='continue' else 1)) for k,w in zip(semrefs,ws)})
            if mode=='continue':weights[current]=weights.get(current,0)+.85
    details['audio_reference_weights']=weights
    details['audio_reference_rule']='maximum_departure' if mode=='change' else 'weighted_semantic' if use_semantic else 'mert_policy'
    compare=list(dict.fromkeys([current,*references,*session.get('direction',[]),*recent]))
    for row in rows:
        target=by_path.get(row['path']);i=subpos.get(target)
        if i is None:continue
        comparisons=[]
        for key in compare:
            if key not in positions:continue
            comparisons.append(dict(key=key,mert=float(matrix[positions[key]]@matrix[positions[target]]),
                muq=float(semantic[key]@semantic[target]) if key in semantic and target in semantic else None))
        if mode=='change':comparisons.sort(key=lambda c:-(c['muq'] if use_semantic and c['muq'] is not None else c['mert']))
        ranking=details.get('model')!='context_replay'
        row_weights=dict(weights)
        if ranking and not use_semantic and mode in {'continue','recover'}:
            valid=[k for k in references if k in positions]
            if valid:
                best=max(valid,key=lambda k:float(matrix[positions[k]]@matrix[positions[target]]))
                row_weights={best:.15 if mode=='continue' else 1.}
                if mode=='continue':row_weights[current]=row_weights.get(current,0)+.85
        tag_comparisons=[]
        tag_references=list(dict.fromkeys(k for k in (recent or references) if k in positions))[-8:]
        for kind,weight in [('instrument',1.),('genre',1.),('mood',.5),('theme',.5)]:
            own=(tags.get(target) or {}).get(kind,{})
            if not own:continue
            available=[(k,(tags.get(k) or {}).get(kind,{})) for k in tag_references if (tags.get(k) or {}).get(kind)]
            if not available:continue
            def cosine(profile):
                norm=np.sqrt(sum(v*v for v in own.values())*sum(v*v for v in profile.values()))
                return sum(v*profile.get(k,0) for k,v in own.items())/norm if norm else 0.
            key,profile=max(available,key=lambda item:cosine(item[1]))
            def describe(profile):
                return [dict(label=labels(kind).get(k.split(':',1)[-1],k),score=v) for k,v in sorted(profile.items(),key=lambda item:-item[1])[:4]]
            tag_comparisons.append(dict(kind=kind,weight=weight,reference=key,similarity=cosine(profile),
                used=ranking and not (kind=='mood' and use_semantic and target in semantic),
                target=describe(own),reference_tags=describe(profile),target_count=len(own),reference_count=len(profile)))
        row['evidence']=dict(reference_comparisons=comparisons[:12] if mode=='change' else comparisons,reference_count=len(comparisons),ranking_applied=ranking,
            audio_reference_weights=row_weights,
            tag_comparisons=tag_comparisons,
            audio_rule='bridge' if row.get('bridge_similarity') is not None else details['audio_reference_rule'],
            negatives=[dict(key=n['key'],similarity=float(n['negative'][i]),positive_similarity=float(n['positive'][i]),
                penalty=float(n['penalty'][i]),model='muq' if n['semantic'] and target in semantic else 'mert') for n in effects.get('negatives',[])] if ranking else [],
            memories=[dict(index=j,strength=m['strength'],similarity=float(m['similarity'][i]),penalty=float(m['penalty'][i])) for j,m in enumerate(effects.get('memories',[]))] if ranking else [],
            mood_vote_excluded=use_semantic and target in semantic)
