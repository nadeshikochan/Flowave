"""Bounded session reranking. Only consumes validated vectors/tags and explicit client context."""
import threading
from collections import Counter
import numpy as np
from recommendation_neighbourhood import reference_floor, sparse_reference, soft_context_reference


class TagCache:
    def __init__(self):
        self.lock, self.views = threading.Lock(), {}

    def get(self, keys, profiles):
        signature = (tuple(keys), id(profiles))
        with self.lock:
            if signature in self.views:
                return self.views[signature][0]
        groups = []
        for kind, weight in (('instrument', 1.), ('genre', 1.), ('mood', .5), ('theme', .5)):
            labels = sorted({label for key in keys for label in profiles.get(key, {}).get(kind, {})})
            if not labels:
                continue
            columns = {label: j for j, label in enumerate(labels)}
            matrix = np.zeros((len(keys), len(labels)), dtype=np.float32)
            for i, key in enumerate(keys):
                for label, value in profiles.get(key, {}).get(kind, {}).items():
                    matrix[i, columns[label]] = value
            norms = np.linalg.norm(matrix, axis=1)
            present = norms > 0
            matrix[present] /= norms[present, None]
            groups.append((matrix, present, weight, kind))
        with self.lock:
            self.views[signature] = (groups, profiles)  # Retain object identity until eviction.
            while len(self.views) > 2:
                self.views.pop(next(iter(self.views)))
        return groups


TAG_CACHE = TagCache()


def adjustments(keys, paths, matrix, semantic, tags, context, recent, session, mode, semantic_audio_used=False, evidence=None):
    """No new admission gates: missing labels stay unknown and never count against a song."""
    positions = {key: i for i, key in enumerate(keys)}
    groups = (TagCache() if evidence is not None else TAG_CACHE).get(keys, tags or {})
    sem_indices = [i for i, key in enumerate(keys) if key in semantic]
    sem_matrix = np.stack([semantic[keys[i]] for i in sem_indices]) if sem_indices else None

    def refs(values, limit=8):
        return list(dict.fromkeys(k for k in values if k in positions))[-limit:]

    affinity_cache = {}
    def affinity(values, use_semantic=True):
        values = refs(values)
        signature = (tuple(values), use_semantic)
        if signature in affinity_cache:
            return affinity_cache[signature]
        result = np.full(len(keys), -1., dtype=np.float32)
        if not values:
            return result
        semantic_refs = [k for k in values if k in semantic] if use_semantic else []
        if len(semantic_refs) == len(values):
            result[sem_indices] = (sem_matrix @ np.stack([semantic[k] for k in semantic_refs]).T).max(axis=1)
            missing = [i for i, key in enumerate(keys) if key not in semantic]
            if missing:
                result[missing] = (matrix[missing] @ matrix[[positions[k] for k in values]].T).max(axis=1)
        else:
            result = (matrix @ matrix[[positions[k] for k in values]].T).max(axis=1)
        affinity_cache[signature] = result
        return result

    tag_cache = {}

    semantic_present=np.array([k in semantic for k in keys])
    def tag_affinity(values):
        signature = tuple(refs(values))
        if signature in tag_cache:
            return tag_cache[signature]
        selected = [positions[k] for k in signature]
        score, count = np.zeros(len(keys)), np.zeros(len(keys))
        for vectors, present, weight, kind in groups:
            valid = [i for i in selected if present[i]]
            if valid:
                # Compare with actual exemplars; never invent a mean between separated styles.
                active=present & (~semantic_present if semantic_audio_used and kind=='mood' else np.ones(len(keys),dtype=bool))
                score += (vectors @ vectors[valid].T).max(axis=1) * weight * active
                count += active * weight
        tag_cache[signature] = (np.divide(score, count, out=np.zeros(len(keys)), where=count > 0), count > 0)
        return tag_cache[signature]

    reference = refs(recent or context)
    tag_score, tag_known = tag_affinity(reference)
    tag_bonus = np.where(tag_known, .025 * (tag_score - .5), 0.)
    if mode == 'change':
        # Here references describe what is being left; they are not positive taste examples.
        tag_bonus = -tag_bonus
    direction = refs(session.get('direction', []), 4)
    strength = float(session.get('direction_strength', 0))
    strength = min(.22, max(0., strength)) if np.isfinite(strength) else 0.
    direction_score = affinity(direction)
    # The origin is a bounded soft reminder, never a permanent admission threshold.
    core_bonus = strength * .10 * np.maximum(0., direction_score - .75) / .25 if mode != 'change' else np.zeros(len(keys))
    negative_penalty = np.zeros(len(keys))
    if mode != 'change':
        for item in session.get('negatives', [])[-16:]:
            negative, positive = refs([item.get('key')]), refs(item.get('positive', []))
            if not negative or not positive:
                continue
            comparable = all(k in semantic for k in negative + positive)
            negative_affinity,positive_affinity=affinity(negative, comparable),affinity(positive, comparable)
            margin = negative_affinity-positive_affinity
            # Shared similarity alone is not a reason to reject all neighbours of X/D.
            penalty = .10 * np.clip((margin + .01) / .10, 0, 1)
            ntag, nk = tag_affinity(negative)
            ptag, pk = tag_affinity(positive)
            penalty += np.where(nk & pk, .015 * np.clip((ntag - ptag) / .5, 0, 1), 0)
            if evidence is not None:evidence.setdefault('negatives',[]).append(dict(key=item.get('key'),negative=negative_affinity,positive=positive_affinity,penalty=penalty,semantic=comparable))
            negative_penalty = np.maximum(negative_penalty, penalty)
    old_penalty = np.zeros(len(keys))
    for item in session.get('memories', [])[-10:]:
        power = float(item.get('strength', 0))
        if not np.isfinite(power):
            continue
        similarity = affinity(item.get('keys', []))
        penalty=.12 * min(1., max(0., power)) * np.clip((similarity - .78) / .20, 0, 1)
        if evidence is not None:evidence.setdefault('memories',[]).append(dict(keys=item.get('keys',[]),strength=power,similarity=similarity,penalty=penalty))
        old_penalty = np.maximum(old_penalty, penalty)
    delta = tag_bonus + core_bonus - negative_penalty - old_penalty
    return delta, dict(tag_similarity=tag_score, tag_known=tag_known, direction_similarity=direction_score,
                      negative_penalty=negative_penalty, old_direction_penalty=old_penalty,
                      tag_adjustment=tag_bonus, direction_adjustment=core_bonus)


def balanced_selection(pool, score, paths, unseen, session, limit, allow_repeats, use_semantic=False):
    """Quality-qualified old/new pools with total repeat probability and rolling count limits."""
    plays = session.get('plays', [])[-100:]
    counts = Counter(plays[-20:])
    last = {path: i for i, path in enumerate(plays)}
    repeat = np.array([not unseen[i] or path in last for i, path in enumerate(paths)])
    adjusted = score.astype(np.float64, copy=True)
    for i in pool:
        if repeat[i]:
            gap = len(plays) - 1 - last.get(paths[i], -100)
            adjusted[i] -= .025 * counts[paths[i]] + .045 * np.exp(-max(0, gap) / 12)
    fresh = [int(i) for i in pool if not repeat[i]]
    older = [int(i) for i in pool if repeat[i] and allow_repeats]
    # When fresh exits exist, a song already used twice in the short window cannot dominate again.
    if fresh:
        older = [i for i in older if counts[paths[i]] < 2]
    fresh.sort(key=lambda i: (-adjusted[i], i))
    older.sort(key=lambda i: (-adjusted[i], i))
    old_slots = min(len(older), max(1, limit // 5)) if fresh else min(len(older), limit)
    chosen = fresh[:limit - old_slots] + older[:old_slots]
    flags = session.get('repeat_flags', [])[-19:]
    used = sum(bool(flag) for flag in flags)
    # At most 5 repeat recommendations in any established 20-step window when fresh songs exist.
    remaining = max(0, 5 - used)
    cap = min(.18, .18 * remaining / 5) if fresh else 1.
    if fresh and len(flags) >= 19 and remaining == 0:
        cap = 0.
    if not fresh and not older:
        return [], [], dict(repeat_mass=0., repeat_budget_relaxed=False), repeat, adjusted
    if not fresh:
        chosen = older[:limit]
    if not older or cap == 0:
        chosen = fresh[:limit]
    # Match sampling scale to this model's actual spread; exact ties remain ties.
    bounds = (.003, .015) if use_semantic else (.001, .006)
    sampling_pool = [i for i in chosen if not repeat[i]] or chosen
    spread = float(np.ptp(np.percentile(adjusted[sampling_pool], [10, 90]))) if sampling_pool else 0.
    temperature = float(np.clip(spread/np.log(8), *bounds))
    weights = np.exp(np.clip((adjusted[chosen] - max(adjusted[chosen])) / temperature, -30, 0)) if chosen else np.array([])
    old_mask = np.array([repeat[i] for i in chosen], dtype=bool)
    old_total, new_total = weights[old_mask].sum(), weights[~old_mask].sum()
    if old_total and new_total:
        mass = min(cap, old_total / (old_total + new_total))
        weights[old_mask] *= mass / old_total
        weights[~old_mask] *= (1 - mass) / new_total
    elif weights.sum():
        weights /= weights.sum()
        mass = 1. if old_total else 0.
    else:
        mass = 0.
    return chosen, weights.tolist(), dict(repeat_mass=mass, repeat_budget_relaxed=not fresh and bool(older),
        recent_repeat_count=used, repeat_window=20, repeat_limit=5, repeat_only_candidates=len(older),
        sampling_temperature=temperature, score_spread=spread), repeat, adjusted

def continuity_fallback(keys, paths, matrix, current, context, history, protected, blocked, session, mode, unavailable=(), cause='exhausted', semantic=None, tags=None, adjacent_floor=None, adjacent_ceiling=None, semantic_context_floor=None, recovery_floor=.82, recovery_mert_floor=.94, excluded=(), old_mert_ceiling=.93, change_semantic_ceiling=.86, natural_semantic_floor=None, semantic_peaks=None):
    """Availability-first continuation. Degradation is explicit and never changes stored feedback."""
    positions = {key: i for i, key in enumerate(keys)}
    unavailable,blocked=set(unavailable),set(blocked)
    semantic=semantic or {}
    semantic_peaks=semantic_peaks or {}
    calibrated={}
    if adjacent_floor is not None and current not in positions:
        return [],dict(reason='missing_index',fallback='continuity_reserve',mode=mode)
    reasons=[cause]
    local=matrix@matrix[positions[current]] if current in positions else np.zeros(len(keys))
    if current in positions:local[positions[current]]=1.
    refs=list(dict.fromkeys(k for k in context if k in positions and (mode=='change' or paths[positions[k]] not in blocked)))[-(64 if mode=='change' else 8):]
    if not refs and current in positions and paths[positions[current]] not in blocked:refs=[current]
    sem_refs=[k for k in refs if k in semantic]
    old_refs=[k for k in excluded if k in positions]
    pool=[i for i,k in enumerate(keys) if k!=current and paths[i] not in unavailable and paths[i] not in blocked]
    gates=[dict(gate='排除当前、不可读与明确拒绝',count=len(pool))]
    def respects_old(i):
        for key in old_refs:
            if keys[i] in semantic and key in semantic:
                if float(semantic[keys[i]]@semantic[key])>change_semantic_ceiling:return False
            elif float(matrix[i]@matrix[positions[key]])>old_mert_ceiling:return False
        return True
    pool=[i for i in pool if respects_old(i)]
    gates.append(dict(gate='旧方向硬边界',count=len(pool)))
    if adjacent_ceiling is not None:
        pool=[i for i in pool if current in positions and local[i]<=adjacent_ceiling]
        if not pool:return [],dict(reason='no_verified_change',fallback='continuity_reserve',mode=mode,change_mert_ceiling=adjacent_ceiling)
    context_refs=[k for k in sem_refs if k!=current] if mode=='continue' and current in semantic else []
    if semantic_context_floor is not None and context_refs:
        for key in context_refs:
            detail=soft_context_reference(semantic_context_floor,
                natural_semantic_floor if natural_semantic_floor is not None else recovery_floor,
                semantic_peaks.get(key),float(semantic[current]@semantic[key]))
            if detail:calibrated[key]=detail
        context_refs=[] if calibrated else context_refs
        if context_refs:
            pool=[i for i in pool if keys[i] in semantic and max(float(semantic[keys[i]]@semantic[k]) for k in context_refs)>=semantic_context_floor]
            gates.append(dict(gate='近期正向上下文',count=len(pool)))
    if natural_semantic_floor is not None and current in semantic:
        detail=sparse_reference(natural_semantic_floor,semantic_peaks.get(current))
        if detail:calibrated[current]=detail
        natural_semantic_floor=reference_floor(natural_semantic_floor,semantic_peaks.get(current))
        pool=[i for i in pool if keys[i] in semantic and float(semantic[current]@semantic[keys[i]])>=natural_semantic_floor]
        gates.append(dict(gate='实际相邻MuQ正常扩展下限',count=len(pool)))
    context_bridges=[key for key,detail in calibrated.items() if detail.get('role')=='soft_context']
    if mode=='recover':
        missing_refs=[k for k in refs if k not in semantic]
        def supports_reference(i):
            if keys[i] in semantic and sem_refs:
                if max(float(semantic[keys[i]]@semantic[k]) for k in sem_refs)>=recovery_floor:return True
                compare=missing_refs
            else:compare=refs
            return bool(compare) and max(float(matrix[i]@matrix[positions[k]]) for k in compare)>=recovery_mert_floor
        pool=[i for i in pool if supports_reference(i)]
        if not pool:return [],dict(reason='no_recovery_reference_match',fallback='continuity_reserve',mode=mode)
    if adjacent_floor is not None and pool:
        # Select the closest tier only after all context/negative/boundary checks.
        best=max(float(local[i]) for i in pool)
        steps=max(0,int(np.ceil((adjacent_floor-best-1e-7)/.01)))
        adjacent_floor=max(0.,round(adjacent_floor-.01*steps,8))
        pool=[i for i in pool if local[i]>=adjacent_floor]
        gates.append(dict(gate='最近合格MERT档',count=len(pool)))
    if not pool:
        if adjacent_floor is not None and current in positions and paths[positions[current]] not in unavailable and paths[positions[current]] not in blocked:
            return [dict(path=paths[positions[current]],sim=1.,probability=1.,weight=1.,is_repeat=True,
                local_semantic_similarity=1. if current in semantic else None)],dict(
                reason='context_preserving_replay',fallback='continuity_reserve',mode=mode,model='context_replay',
                context_floor_applied=bool(context_refs),adjacent_mert_floor=adjacent_floor,
                degradation=[cause,'adjacent_replay_only']+(['relaxed_short_cooldown'] if paths[positions[current]] in protected else []),
                repeat_mass=1.,repeat_budget_relaxed=True,recent_repeat_count=sum(bool(f) for f in session.get('repeat_flags',[])[-19:]),
                repeat_window=20,repeat_limit=5,repeat_only_candidates=1,
                gate_counts=gates,natural_semantic_floor=natural_semantic_floor,
                old_direction_mert_ceiling=old_mert_ceiling,old_direction_muq_ceiling=change_semantic_ceiling,
                **({'context_bridge_keys':context_bridges} if context_bridges else {}),
                **({'semantic_neighbourhood':calibrated} if calibrated else {}))
        return [],dict(reason='no_playable_resources',fallback='continuity_reserve',degradation=reasons,mode=mode)
    preferred=[i for i in pool if paths[i] not in set(protected)]
    if preferred:pool=preferred
    elif protected:reasons.append('relaxed_short_cooldown')
    gates.append(dict(gate='短冷却（耗尽可明确退让）',count=len(pool)))
    semantic_refs=sem_refs
    if not semantic_refs and mode=='continue' and current in semantic:semantic_refs=[current]
    use_semantic = bool(semantic_refs and any(keys[i] in semantic for i in pool)
                        and (mode != 'continue' or current in semantic or current not in positions))
    similarity = (matrix @ matrix[[positions[k] for k in refs]].T).max(axis=1) if refs else np.zeros(len(keys))
    semantic_similarity = np.full(len(keys), -1.)
    if use_semantic:
        pool = [i for i in pool if keys[i] in semantic]
        if mode=='change':
            # Every departing reference constrains the new direction; missing MuQ keeps its MERT boundary.
            missing_refs=[positions[k] for k in refs if k not in semantic]
            if missing_refs:pool=[i for i in pool if float((matrix[missing_refs]@matrix[i]).max())<=old_mert_ceiling]
            if not pool:return [],dict(reason='no_verified_change',fallback='continuity_reserve',mode=mode,change_mert_ceiling=adjacent_ceiling)
        ids = [i for i, k in enumerate(keys) if k in semantic]
        candidates = np.stack([semantic[keys[i]] for i in ids])
        references = candidates @ np.stack([semantic[k] for k in semantic_refs]).T
        if mode == 'change':
            semantic_similarity[ids] = references.max(axis=1)
        else:
            weights = np.power(.7, np.arange(len(semantic_refs)-1, -1, -1)); weights /= weights.sum()
            semantic_similarity[ids] = references @ weights
            if mode == 'continue' and current in semantic:
                semantic_similarity[ids] = .85*(candidates @ semantic[current])+.15*semantic_similarity[ids]
        similarity = semantic_similarity.copy()
    elif mode == 'continue' and current in positions:
        similarity = .85*local+.15*similarity
    if mode == 'change':
        different = [i for i in pool if similarity[i] <= (.86 if use_semantic else adjacent_ceiling if adjacent_ceiling is not None else .93)]
        if different:
            pool = different
        else:
            return [], dict(reason='no_verified_change',fallback='continuity_reserve',mode=mode,change_mert_ceiling=adjacent_ceiling)
    # Seek another moderate direction rather than a farthest-point outlier in emergency change.
    audio_score = -np.abs(similarity-(.705 if use_semantic else .89)) if mode == 'change' else similarity.copy()
    score = audio_score.copy()
    delta,signals=adjustments(keys,paths,matrix,semantic or {},tags or {},refs,[],session,mode,semantic_audio_used=use_semantic)
    score+=delta
    # Even emergency playback compares quality before novelty. Good older songs can save continuity.
    tolerance = .025 if use_semantic else .010
    baseline = max(audio_score[i] for i in pool)
    qualified = [i for i in pool if score[i] >= baseline-tolerance]
    if qualified:
        pool = qualified
    else:
        reasons.append('preference_relaxed')
        best = max(score[i] for i in pool)
        pool = [i for i in pool if score[i] >= best-tolerance]
    gates.append(dict(gate='质量与情境评分',count=len(pool)))
    heard = set(history) | set(session.get('plays', []))
    if adjacent_floor is not None and current in positions:heard.add(paths[positions[current]])
    unseen = np.array([path not in heard for path in paths])
    before_repeat=score.copy()
    pool, weights, repeat_details, repeat_mask, adjusted = balanced_selection(
        np.asarray(pool,dtype=int),score,paths,unseen,{**session,'plays':session.get('plays') or list(history)},20,True,use_semantic)
    model = 'muq_continuity_reserve' if use_semantic else 'mert_continuity_reserve'
    rows = [dict(path=paths[i],sim=float(local[i]),suitability=float(adjusted[i]),weight=float(w),probability=float(w),
                 audio_score=float(audio_score[i]),recent_reward=0.,repeat_penalty=float(before_repeat[i]-adjusted[i]),
                 audio_primary=float(audio_score[i]),mert_adjustment=0.,bridge_penalty=0.,
                 local_semantic_similarity=float(semantic[current]@semantic[keys[i]]) if current in semantic and keys[i] in semantic else None,
                 semantic_similarity=float(semantic_similarity[i]) if use_semantic else None,
                 continuity_reward=1.,is_repeat=bool(repeat_mask[i]),model=model,
                 admission_stage='continuity_reserve',admission_floor=None) for i,w in zip(pool,weights)]
    for row,i in zip(rows,pool):
        row.update({name:bool(values[i]) if name=='tag_known' else float(values[i]) for name,values in signals.items()})
    return rows, dict(reason='ready',fallback='continuity_reserve',degradation=reasons,mode=mode,
        gate_counts=gates,natural_semantic_floor=natural_semantic_floor,
        old_direction_mert_ceiling=old_mert_ceiling,old_direction_muq_ceiling=change_semantic_ceiling,
        eligible=len(pool),returned=len(rows),context_keys=refs,model=model,adjacent_mert_floor=adjacent_floor,change_mert_ceiling=adjacent_ceiling,
        context_floor_applied=bool(context_refs and semantic_context_floor is not None),**repeat_details,
        **({'context_bridge_keys':context_bridges} if context_bridges else {}),
        **({'semantic_neighbourhood':calibrated} if calibrated else {}))
