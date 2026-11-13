"""Session recommendation policy. Pure NumPy; no runtime state, files or models.

Normal admission is separate from ordering/probabilities. Missing analysis and
exhaustion use an explicit availability reserve for session playback.
"""
import numpy as np
import threading
from recommendation_signals import adjustments, balanced_selection, continuity_fallback
from recommendation_recordings import collapse as collapse_recordings
from recommendation_neighbourhood import semantic_reference_peaks, sparse_reference, soft_context_reference


DEFAULTS = dict(semantic_floor=.90, context_floor=.86, candidate_limit=80,
                recent_exclusion=2, allow_older_repeats=True, adjacent_mert_floor=.95)
CHANGE_MIN, CHANGE_MAX, DIRECTION_SIMILARITY = .55, .86, .90


def settings(config):
    supplied = config.get('recommendation') or {}
    result = {**DEFAULTS, **supplied}
    for key in ('semantic_floor', 'context_floor', 'adjacent_mert_floor'):
        try:
            value = float(result[key])
            result[key] = value if np.isfinite(value) and 0 <= value <= 1 else DEFAULTS[key]
        except (TypeError, ValueError):
            result[key] = DEFAULTS[key]
    result['context_floor'] = min(result['context_floor'], result['semantic_floor'])
    for key, low, high in (('candidate_limit', 10, 200), ('recent_exclusion', 1, 20)):
        try:
            result[key] = max(low, min(high, int(result[key])))
        except (TypeError, ValueError):
            result[key] = DEFAULTS[key]
    result['allow_older_repeats'] = result['allow_older_repeats'] is True
    return result


def prepare(index):
    keys, paths, vectors = [], [], []
    for key, (path, vector) in index.items():
        vector = np.asarray(vector, dtype=np.float32)
        norm = np.linalg.norm(vector)
        if vector.ndim != 1 or not np.isfinite(vector).all() or not np.isfinite(norm) or norm <= 0:
            continue
        keys.append(key); paths.append(path); vectors.append(vector/norm)
    positions = {key: i for i, key in enumerate(keys)}
    return keys, paths, np.stack(vectors) if vectors else np.empty((0, 0)), positions


class VectorCache:
    """At most two immutable local/all MERT views; no per-request normalization."""
    def __init__(self):
        self.lock, self.views = threading.Lock(), {}

    def get(self, index):
        key = tuple((k, path, id(vector)) for k, (path, vector) in index.items())
        with self.lock:
            if key in self.views:
                return self.views[key][0]
        view = prepare(index)
        with self.lock:
            self.views[key] = (view, tuple(index.items()))  # retain source objects; ids cannot be recycled
            while len(self.views) > 2:
                self.views.pop(next(iter(self.views)))
        return view


def adjacent_candidates(index, current, config, prepared=None):
    """Fast read-only safety data; no semantic cache, metadata guesses or feedback."""
    keys, paths, matrix, positions = prepared if prepared is not None else prepare(index)
    floor = settings(config)['adjacent_mert_floor']
    if current not in positions:
        return dict(rows=[],missing=True,floor=floor)
    q = positions[current]; scores = matrix @ matrix[q]
    ids = np.flatnonzero((scores >= floor) & (np.arange(len(keys)) != q))
    ids = ids[np.argsort(-scores[ids],kind='stable')]
    return dict(rows=[dict(path=paths[i],sim=float(scores[i])) for i in ids],missing=False,floor=floor)


def recommend_with_reserve(index, current, context, recent, history, protected, blocked, config, **kwargs):
    """Share numerical work within one request; both candidate limits keep their own selection/probabilities."""
    memo = {}
    rows, details = recommend(index,current,context,recent,history,protected,blocked,config,**kwargs,_memo=memo)
    reserve_config = {**config, 'recommendation': {**(config.get('recommendation') or {}), 'candidate_limit': 200}}
    reserve_rows, reserve_details = recommend(index,current,context,recent,history,protected,blocked,reserve_config,**kwargs,_memo=memo)
    return rows, details, reserve_rows, reserve_details


def recommend(index, current, context, recent, history, protected, blocked, config,
              semantic=None, mode='continue', correction=None, prepared=None, excluded=None, session=None, tags=None, unavailable=(), recording_groups=None, explain=False, _memo=None):
    """Evaluate the unchanged policy in descending adjacency tiers, with emergency fallback last."""
    base = settings(config)['adjacent_mert_floor']
    memo = {} if _memo is None else _memo
    view = prepared if prepared is not None else prepare(index)
    if session is not None and recording_groups:
        grouped=collapse_recordings(index,current,context,recent,history,protected,blocked,excluded,session,unavailable,recording_groups,view,semantic or {})
        if grouped:
            # Grouping must not hide the existing query-level protection against inconsistent MuQ copies.
            conflicts=[];uncertain=set()
            for query in dict.fromkeys([current,*context]):
                if query not in (semantic or {}) or query not in grouped['keymap'] or query not in view[3]:continue
                for peer in grouped['members'][grouped['keymap'][query]]:
                    if peer==query or peer not in semantic or peer not in view[3]:continue
                    agreement=float(semantic[query]@semantic[peer])
                    if agreement<settings(config)['context_floor']:
                        pair=sorted([query,peer])
                        if not any(c['keys']==pair for c in conflicts):
                            conflicts.append(dict(keys=pair,muq=agreement,mert=float(view[2][view[3][query]]@view[2][view[3][peer]]),source='verified_recording'))
                        uncertain.update(grouped['members'][grouped['keymap'][query]])
            rows,details=recommend(grouped['index'],grouped['current'],grouped['context'],grouped['recent'],grouped['history'],
                grouped['protected'],grouped['blocked'],config,{k:v for k,v in (semantic or {}).items() if k in grouped['index'] and k not in uncertain},
                mode,correction,grouped['prepared'],grouped['excluded'],grouped['session'],tags,grouped['unavailable'],explain=explain,_memo=memo)
            by_path={path:k for k,(path,_) in grouped['index'].items()}
            for row in rows:
                key=by_path[row['path']]
                row['recording_group_size']=len(grouped['members'][key])
                row['recording_members']=grouped['members'][key][:8]
            details.update(recording_group_count=len(grouped['index']),recording_duplicate_files=len(index)-len(grouped['index']))
            details['semantic_conflicts']=[*conflicts,*details.get('semantic_conflicts',[])]
            return rows,details
    keys, paths, matrix, positions = view
    mert_queries = memo.setdefault('mert_queries', {})
    def mert_scores(query):
        if query not in mert_queries:
            mert_queries[query] = matrix @ matrix[positions[query]]
        return mert_queries[query]
    if current in positions:
        memo.setdefault('local', mert_scores(current))
    semantic_conflicts=[]
    if session is not None and semantic:
        # Near-identical MERT recordings with strongly conflicting MuQ are uncertain,
        # not evidence for a new direction. Keep identities/results intact; only this query abstains.
        suspect=set()
        for query in dict.fromkeys([current,*context]):
            if query not in positions or query not in semantic:continue
            near=mert_scores(query)
            for i in np.flatnonzero(near>=.9999):
                peer=keys[i]
                if peer==query or peer not in semantic:continue
                agreement=float(semantic[query]@semantic[peer])
                if agreement<settings(config)['context_floor']:
                    pair=tuple(sorted((query,peer)))
                    if not any(tuple(x['keys'])==pair for x in semantic_conflicts):
                        semantic_conflicts.append(dict(keys=list(pair),mert=float(near[i]),muq=agreement))
                    suspect.update(pair)
        if suspect:
            semantic={k:v for k,v in semantic.items() if k not in suspect}
            # Do not immediately cycle through the disputed near-duplicate recordings.
            protected=list(dict.fromkeys([*protected,*(paths[positions[k]] for k in suspect if k!=current)]))
    natural = session is not None and mode == 'continue'
    if natural and 'semantic_peaks' not in memo:
        memo['semantic_peaks'] = semantic_reference_peaks(keys, semantic or {}, [current, *context])
    semantic_peaks = memo.get('semantic_peaks', {}) if natural else {}
    floors = [base]
    unavailable_set = set(unavailable)
    if natural and current in positions:
        scores = mert_scores(current)
        # Only bands gaining an actual candidate need evaluation; all intervening bands are identical.
        for i,k in enumerate(keys):
            if k == current or paths[i] in unavailable_set or scores[i] < 0:
                continue
            steps = max(0, int(np.ceil((base-float(scores[i])-1e-7)/.01)))
            floors.append(max(0., round(base-.01*steps, 8)))
    floors = sorted(set(floors), reverse=True)
    rows, details, evaluated = [], {}, []
    for floor in floors:
        evaluated.append(floor)
        effective = {**config, 'recommendation': {**(config.get('recommendation') or {}), 'adjacent_mert_floor': floor}}
        rows, details = _recommend_at_floor(index,current,context,recent,history,protected,blocked,effective,
            semantic,mode,correction,view,excluded,session,tags,unavailable,reserve_allowed=not natural,semantic_peaks=semantic_peaks,memo=memo)
        if rows:
            break
    if natural and not rows:
        # Only after normal contextual recommendations are exhausted use the explicit emergency policy.
        floor = base
        effective = {**config, 'recommendation': {**(config.get('recommendation') or {}), 'adjacent_mert_floor': floor}}
        rows, details = _recommend_at_floor(index,current,context,recent,history,protected,blocked,effective,
            semantic,mode,correction,view,excluded,session,tags,unavailable,semantic_peaks=semantic_peaks,memo=memo)
        floor=details.get('adjacent_mert_floor',base)
    if natural:
        details.update(adjacent_mert_base_floor=base, adjacent_mert_floor=floor,
            adjacent_mert_steps=max(0,int(np.ceil((base-floor-1e-7)/.01))), adjacent_mert_step=.01,
            adjacent_mert_evaluated_floors=evaluated)
    details.update(semantic_conflicts=semantic_conflicts,scoring_semantic_available=len(semantic or {}))
    if explain:
        from recommendation_evidence import attach_evidence
        attach_evidence(rows,details,index,current,context,recent,session or {},semantic or {},tags or {},view,blocked,excluded or [])
    if recording_groups is not None:
        details.update(recording_group_count=len(index),recording_duplicate_files=0)
        by_path={p:k for k,(p,_) in index.items()}
        for row in rows:row.update(recording_group_size=1,recording_members=[by_path[row['path']]])
    return rows, details


def _recommend_at_floor(index, current, context, recent, history, protected, blocked, config,
              semantic=None, mode='continue', correction=None, prepared=None, excluded=None, session=None, tags=None, unavailable=(), reserve_allowed=True, semantic_peaks=None, memo=None):
    # Only adjacency floor / candidate limit vary in this request. Cached arrays stay read-only.
    memo = {} if memo is None else memo
    def shared(name, compute):
        if name not in memo:
            memo[name] = compute()
        return memo[name]
    opts = settings(config)
    keys, paths, matrix, positions = prepared if prepared is not None else prepare(index)
    modern = session is not None
    session = session or {}
    semantic_peaks = semantic_peaks or {}
    normal_semantic_min = max(.78, opts['semantic_floor']-.08)
    context_mert_floor = max(.94, float((config.get('similarity') or {}).get('like_min', .975))-.035)
    sparse_current = sparse_reference(normal_semantic_min, semantic_peaks.get(current)) if modern and mode=='continue' else None
    current_semantic_floor = sparse_current['effective_floor'] if sparse_current else opts['semantic_floor']
    def semantic_admission_floor(delta=0.):
        return current_semantic_floor if sparse_current else (opts['semantic_floor'] if not delta else max(.78, opts['semantic_floor']-delta))
    def reserve(cause):
        if not reserve_allowed:
            return [], dict(reason=cause, mode=mode, fallback='contextual_pool_exhausted')
        missing_recovery = mode == 'recover' and not any(k in positions and index[k][0] not in set(blocked) for k in context)
        fallback_mode = 'change' if missing_recovery else mode
        references = [current] if missing_recovery else list(context)
        rows,details=continuity_fallback(keys, paths, matrix, current, references, list(history), protected, blocked, session, fallback_mode, unavailable, cause,semantic,tags,
            adjacent_floor=opts['adjacent_mert_floor'] if mode=='continue' else None,
            adjacent_ceiling=float((config.get('dislike') or {}).get('max_sim', .93)) if fallback_mode=='change' else None,
            semantic_context_floor=opts['context_floor'] if mode=='continue' else None,
            recovery_floor=max(.78,opts['semantic_floor']-.08),
            recovery_mert_floor=context_mert_floor,
            excluded=excluded or (),old_mert_ceiling=float((config.get('dislike') or {}).get('max_sim',.93)),change_semantic_ceiling=CHANGE_MAX,
            natural_semantic_floor=max(.78,opts['semantic_floor']-.08) if mode=='continue' and modern else None,
            semantic_peaks=semantic_peaks)
        if missing_recovery:
            details.update(mode=mode,effective_intent='change',recovery_reference_missing=True,reference_role='departure_only')
        else:
            details['reference_role']='prior_only' if current not in positions and mode=='continue' else 'positive_context' if mode=='recover' else 'departure_only' if mode=='change' else 'current_and_context'
        details.update(current_index_available=current in positions,current_semantic_available=current in (semantic or {}))
        details['repeat_setting_relaxed']=not opts['allow_older_repeats'] and any(row['is_repeat'] for row in rows)
        return rows,details
    if current not in positions:
        return reserve('missing_index') if modern else ([], dict(reason='missing_index', mode=mode))
    q = positions[current]
    local = shared('local', lambda: matrix @ matrix[q])
    adjacent_gate = local >= opts['adjacent_mert_floor'] if modern and mode=='continue' else np.ones(len(keys),dtype=bool)
    rejected_paths = set(blocked)
    context = list(dict.fromkeys(key for key in context if key in positions and (mode == 'change' or index[key][0] not in rejected_paths)))[-64:]
    recent = list(dict.fromkeys(key for key in recent if key in positions and index[key][0] not in rejected_paths))[-3:]
    if mode == 'recover' and not context:
        return reserve('missing_context') if modern else ([], dict(reason='missing_context', mode=mode))
    if mode == 'change' and current not in context:
        context = [*context, current][-64:]
    if not context:
        context = [current]
    semantic = semantic or {}
    sem_positions = [i for i, key in enumerate(keys) if key in semantic]
    sem_refs = [key for key in context if key in semantic]
    if modern and mode == 'continue' and current in semantic and not sem_refs:
        sem_refs = [current]
    # Natural continuity must check the actual current song, never replace it with an older semantic query.
    query_key = (current if current in semantic else None) if mode == 'continue' else (sem_refs[-1] if sem_refs else None)
    use_semantic = bool(query_key is not None and sem_refs)
    support = np.full(len(keys), -1., dtype=np.float32)
    intent = support.copy()
    score = local.copy()
    mert_adjustment=np.zeros(len(keys));bridge_penalty=np.zeros(len(keys))
    old_admissible = np.ones(len(keys), dtype=bool)
    if use_semantic:
        sem_matrix = shared('semantic_matrix', lambda: np.stack([semantic[keys[i]] for i in sem_positions]))
        support[sem_positions] = shared('semantic_support', lambda: sem_matrix @ semantic[query_key])
        ref_scores = shared('semantic_references', lambda: sem_matrix @ np.stack([semantic[key] for key in sem_refs]).T)
        intent[sem_positions] = np.max(ref_scores, axis=1)
        if mode == 'recover':
            # The rejected current song contributes no positive score or gate.
            weights = np.power(.7, np.arange(len(sem_refs)-1, -1, -1)); weights /= weights.sum()
            score[sem_positions] = ref_scores @ weights
            mert_reference = shared('mert_reference', lambda: np.max(matrix @ matrix[[positions[key] for key in context]].T, axis=1))
            mert_adjustment=.01*np.clip((mert_reference-.85)/.15, 0, 1)
            score += mert_adjustment
            eligible = intent >= opts['semantic_floor']
        elif mode == 'change':
            # Avoid both near duplicates and arbitrary farthest-point outliers.
            eligible = (intent >= CHANGE_MIN) & (intent <= CHANGE_MAX)
            score = intent.copy()
            missing_old = [k for k in context if k not in semantic]
            if missing_old:
                old_admissible &= (matrix @ matrix[[positions[k] for k in missing_old]].T).max(axis=1) <= float((config.get('dislike') or {}).get('max_sim', .93))
                eligible &= old_admissible
            mert_adjustment=.01*np.clip((local-.85)/.15, 0, 1)
            score += mert_adjustment
        else:
            eligible = support >= current_semantic_floor
            weights = np.power(.5, np.arange(len(sem_refs)-1, -1, -1)); weights /= weights.sum()
            score[sem_positions] = .85*support[sem_positions] + .15*(ref_scores @ weights)
            mert_adjustment=.01*np.clip((local-.85)/.15, 0, 1)
            score += mert_adjustment
        model = 'muq+mert'
    else:
        # Missing analysis is explicitly single-model, with no guessed MuQ scores.
        refs = matrix[[positions[key] for key in context]]
        intent = shared('mert_intent', lambda: np.max(matrix @ refs.T, axis=1))
        if mode == 'recover':
            low = float((config.get('similarity') or {}).get('like_min', .975))
            eligible = intent >= low
            score = intent.copy()
        elif mode == 'change':
            low = float((config.get('dislike') or {}).get('min_sim', .85))
            high = float((config.get('dislike') or {}).get('max_sim', .93))
            eligible = (intent >= low) & (intent <= high)
        else:
            low = float((config.get('similarity') or {}).get('like_min', .975))
            eligible = local >= low
            score = .85*local + .15*intent
        model = 'mert_only'
    # Old-segment boundary is invariant across strict/repeat/expanded stages.
    exclusions = list(dict.fromkeys(k for k in (excluded or []) if k in positions))
    boundary = np.ones(len(keys), dtype=bool)
    if exclusions:
        if use_semantic:
            refs = [k for k in exclusions if k in semantic]
            boundary[:] = False
            boundary[sem_positions] = True
            if refs:
                old_similarity = sem_matrix @ np.stack([semantic[k] for k in refs]).T
                boundary[sem_positions] = old_similarity.max(axis=1) <= CHANGE_MAX
            missing_refs = [k for k in exclusions if k not in semantic]
            if missing_refs:
                missing_scores = matrix @ matrix[[positions[k] for k in missing_refs]].T
                boundary &= missing_scores.max(axis=1) <= float((config.get('dislike') or {}).get('max_sim', .93))
            # Missing MuQ references still have a real MERT boundary, never an unrestricted pass.
        else:
            high = float((config.get('dislike') or {}).get('max_sim', .93))
            boundary = (matrix @ matrix[[positions[k] for k in exclusions]].T).max(axis=1) <= high
    if mode == 'change':
        # MuQ describes another aspect of the sound; it cannot waive the actual-current MERT ceiling.
        old_admissible &= local <= float((config.get('dislike') or {}).get('max_sim', .93))
        eligible &= old_admissible
    context_refs = [k for k in sem_refs if k != current] if modern and mode=='continue' and current in semantic else []
    context_mert_keys = [
        k for k in context if k != current and k not in semantic
    ] if modern and mode == 'continue' and use_semantic else []
    soft_context = {key:detail for key in context_refs if (detail:=soft_context_reference(
        opts['context_floor'],normal_semantic_min,semantic_peaks.get(key),float(semantic[current]@semantic[key])))}
    # An isolated historical exemplar has no independently supported absolute gate.
    # Keep its original audio weight/core reward; do not trap its accepted neighbour
    # behind a second hard gate that only points back to the same two recordings.
    # Context admission is an OR across positive exemplars. A verified sparse
    # bridge already supplies that support; an older unmatched exemplar must not
    # become an AND veto merely because the supported exemplar is kept soft.
    if soft_context:
        context_refs = []
        context_mert_keys = []
    if context_refs or context_mert_keys:
        # A locally similar encoding/step must not jump outside every recent positive exemplar.
        contextual = np.zeros(len(keys),dtype=bool)
        if context_refs:
            context_support = sem_matrix @ np.stack([semantic[k] for k in context_refs]).T
            contextual[sem_positions] = context_support.max(axis=1) >= opts['context_floor']
        if context_mert_keys:
            # Missing/abstained historical MuQ keeps its existing MERT support.
            # Actual-current MuQ admission is still applied independently.
            mert_support = matrix @ matrix[[positions[k] for k in context_mert_keys]].T
            contextual |= mert_support.max(axis=1) >= context_mert_floor
        boundary &= contextual
    eligible &= boundary & adjacent_gate
    hard = set(protected) | set(blocked) | set(unavailable) | {paths[q]}
    eligible &= np.array([path not in hard for path in paths])
    history_set = set(history) | (set(session.get('plays', [])) if modern else set())
    unseen = np.array([path not in history_set for path in paths])
    initial_eligible = int(eligible.sum())
    stages = [(eligible.copy(), 0., 'strict')]
    attempted_expansions = []
    if mode != 'change':
        # Evaluate all legal new-song tiers before falling back to any old song.
        for delta in ((.025, .05, .08) if use_semantic else (.01, .02, .035)):
            metric = support if use_semantic and mode == 'continue' else local if mode == 'continue' else intent
            floor = semantic_admission_floor(delta) if use_semantic and mode=='continue' else max(.78, opts['semantic_floor']-delta) if use_semantic else max(.94, low-delta)
            expanded = (metric >= floor) & boundary & adjacent_gate & np.array([path not in hard for path in paths])
            stages.append((expanded, delta, 'same_direction_expansion'))
    bridge_similarity = np.full(len(keys), -1., dtype=np.float32)
    bridge_refs = []
    if mode == 'recover' and not any(np.any(mask & unseen) for mask, _, _ in stages):
        # A bounded two-edge neighbourhood around the frozen pre-error references.
        # Intermediate songs can be heard/tried; they are connectivity evidence, not positive feedback.
        first = stages[-1][0] | ((intent >= max(.78, opts['semantic_floor']-.08)) if use_semantic else (intent >= max(.94, low-.035)))
        first &= boundary
        if not modern:
            first &= np.array([path not in rejected_paths for path in paths])
        first[q] = False  # Current correction is never a bridge; endpoints still obey blocked.
        frontier = np.flatnonzero(first)
        frontier = frontier[np.argsort(-intent[frontier], kind='stable')[:64]]
        if use_semantic:
            frontier = np.array([i for i in frontier if keys[i] in semantic], dtype=int)
            if len(frontier):
                bridge_similarity[sem_positions] = (sem_matrix @ np.stack([semantic[keys[i]] for i in frontier]).T).max(axis=1)
            floor = max(.78, opts['semantic_floor']-.08)
        else:
            if len(frontier):
                bridge_similarity = (matrix @ matrix[frontier].T).max(axis=1)
            floor = max(.94, low-.035)
        bridge_refs = [keys[i] for i in frontier]
        bridged = (bridge_similarity >= floor) & boundary & np.array([p not in hard for p in paths])
        stages.append((bridged, stages[-1][1], 'connected_neighbourhood'))
    signals = {}
    audio_base=score.copy()
    if modern:
        adjustment_delta, signals = shared('adjustments', lambda: adjustments(keys, paths, matrix, semantic, tags or {}, context, recent, session, mode,semantic_audio_used=use_semantic))
        score += adjustment_delta
    strict = np.zeros(len(keys), dtype=bool)
    fallback, expansion = 'strict', 0.
    for mask, delta, label in stages:
        if delta and delta not in attempted_expansions:
            attempted_expansions.append(delta)
        if np.any(mask & unseen):
            strict, eligible, fallback, expansion = mask & unseen, mask, label, delta
            break
    if not np.any(strict) and opts['allow_older_repeats']:
        # Latest occurrence, not similarity rank, decides which permitted old tier is revisited.
        # A short repeating cycle cannot win while a legal new outlet exists.
        for mask, delta, label in stages:
            if np.any(mask):
                eligible, expansion = mask, delta
                last = {path: i for i, path in enumerate(history)}
                oldest = min(last.get(paths[i], -1) for i in np.flatnonzero(mask))
                strict = mask & np.array([last.get(path, -1) <= oldest+2 for path in paths])
                fallback = 'older_repeat' if not delta else 'expanded_older_repeat'
                break
    if not modern and fallback == 'connected_neighbourhood':
        score = .65*intent + .35*bridge_similarity - .03
    pool = np.flatnonzero(strict)
    bridge_only = np.zeros(len(keys), dtype=bool)
    stage_details = {}
    if modern and mode != 'change':
        tolerance = .025 if use_semantic else .010
        for mask, _, label in stages:
            if label == 'connected_neighbourhood':
                bridge_only = mask & ~np.logical_or.reduce([s[0] for s in stages[:-1]])
                score[bridge_only] = .65*intent[bridge_only] + .35*bridge_similarity[bridge_only] - .03 + adjustment_delta[bridge_only]
                audio_base[bridge_only]=score[bridge_only]-adjustment_delta[bridge_only]
                mert_adjustment[bridge_only]=0.;bridge_penalty[bridge_only]=.03
        def quality_pool(mask):
            result = np.zeros(len(keys), dtype=bool)
            # Good old songs compete independently; novelty never qualifies a known mismatch.
            for group in (mask & unseen, mask & ~unseen if opts['allow_older_repeats'] else np.zeros(len(keys), dtype=bool)):
                if group.any():
                    baseline = float(np.max((score-adjustment_delta)[group]))
                    result |= group & (score >= baseline-tolerance)
            return result
        quality_stages = [quality_pool(mask) for mask, _, _ in stages]
        first = next((j for j, mask in enumerate(quality_stages) if mask.any()), None)
        played = session.get('plays', [])[-8:]
        cycle = len(played) >= 6 and len(set(played)) <= 4
        selected_stage, cycle_exit = first, False
        balanced = quality_stages[first].copy() if first is not None else np.zeros(len(keys), dtype=bool)
        if first is not None and not (balanced & unseen).any():
            for j in range(first+1, len(stages)):
                fresh = quality_stages[j] & unseen
                if fresh.any():
                    balanced |= fresh
                    selected_stage = j
                    break
        # Read-only bounded lookahead for an actual played short cycle, never for request count.
        def viable_fresh(mask, level):
            ids = np.flatnonzero(mask & unseen)
            ids = ids[np.argsort(-score[ids], kind='stable')[:16]]
            future = np.flatnonzero(boundary & unseen & np.array([p not in hard for p in paths]))
            delta = stages[level][1]
            if use_semantic:
                ids = np.array([i for i in ids if keys[i] in semantic], dtype=int)
                future = np.array([i for i in future if keys[i] in semantic], dtype=int)
                floor = semantic_admission_floor(delta)
                relation = np.stack([semantic[keys[i]] for i in ids]) if len(ids) else None
                targets = np.stack([semantic[keys[i]] for i in future]) if len(future) else None
            else:
                floor = max(.94, low-delta)
                relation, targets = matrix[ids], matrix[future]
            if not len(ids) or not len(future):
                return np.array([], dtype=int)
            links = relation @ targets.T >= floor
            if modern:links &= matrix[ids] @ matrix[future].T >= opts['adjacent_mert_floor']
            counts = links.sum(axis=1)-np.isin(ids, future)
            return ids[counts > 0]
        if first is not None and cycle and mode == 'continue' and (balanced & unseen).any():
            if not len(viable_fresh(balanced, selected_stage)):
                for j in range(selected_stage+1, len(stages)):
                    # Judge the new band independently of the high-score dead-end near song.
                    exits = viable_fresh(quality_pool(stages[j][0] & ~stages[first][0]), j)
                    if len(exits):
                        balanced &= ~unseen
                        balanced[exits] = True
                        selected_stage, cycle_exit = j, True
                        break
        pool = np.flatnonzero(balanced)
        if first is not None:
            expansion = stages[selected_stage][1]
            attempted_expansions = [delta for _, delta, _ in stages[:selected_stage+1] if delta]
            fallback = 'quality_balanced'
        stage_details = dict(selected_stage=stages[selected_stage][2] if first is not None else None,
            selected_stage_index=selected_stage, quality_tolerance=tolerance, cycle_detected=cycle, cycle_exit=cycle_exit,
            stage_counts=[dict(stage=label, expansion=delta, eligible=int(mask.sum()),
                qualified=int(qualified.sum()), fresh=int((qualified & unseen).sum()))
                for (mask, delta, label), qualified in zip(stages, quality_stages)])
        eligible = np.zeros(len(keys), dtype=bool)
        eligible[pool] = True
    diagnostic = dict(mode=mode, model=model, eligible=int(eligible.sum()), initial_eligible=initial_eligible,
        strict_count=int(np.sum(eligible & np.array([p not in history_set for p in paths]))),
        fallback=fallback, reason='ready' if len(pool) else 'exhausted',
        semantic_available=len(sem_positions), semantic_missing=len(keys)-len(sem_positions),
        semantic_query_key=query_key, semantic_context_count=len(sem_refs),
        change_mert_ceiling=float((config.get('dislike') or {}).get('max_sim', .93)) if mode=='change' else None,
        current_semantic_available=current in semantic,
        adjacent_mert_floor=opts['adjacent_mert_floor'] if modern and mode=='continue' else None,
        semantic_floor=opts['semantic_floor'], context_floor=opts['context_floor'],
        context_keys=context, excluded_keys=exclusions, expansion=expansion, attempted_expansions=attempted_expansions,
        bridge_refs=bridge_refs, bridge_hops=2 if fallback == 'connected_neighbourhood' or modern and np.any(bridge_only[pool]) else 1,
        boundary_max=CHANGE_MAX if use_semantic else float((config.get('dislike') or {}).get('max_sim',.93)),
        old_direction_mert_ceiling=float((config.get('dislike') or {}).get('max_sim',.93)),old_direction_muq_ceiling=CHANGE_MAX,
        recent_exclusion=opts['recent_exclusion'])
    if mode == 'change' and use_semantic:
        diagnostic.update(change_range=[CHANGE_MIN, CHANGE_MAX], direction_similarity=DIRECTION_SIMILARITY)
    if modern:
        diagnostic.update(stage_details, policy_revision=5, context_floor_applied=bool(context_refs or context_mert_keys),
            tag_available=sum(any((tags or {}).get(k, {}).values()) for k in keys),
            direction_keys=session.get('direction', []), negative_count=len(session.get('negatives', [])),
            old_direction_count=len(session.get('memories', [])),
            negative_contexts=session.get('negatives', []), direction_memories=session.get('memories', []))
        if context_mert_keys:
            diagnostic.update(context_mert_keys=context_mert_keys, context_mert_floor=context_mert_floor)
        if mode=='continue':
            calibrated=dict(soft_context)
            if sparse_current:calibrated[current]=sparse_current
            if calibrated:diagnostic['semantic_neighbourhood']=calibrated
            if soft_context:diagnostic['context_bridge_keys']=list(soft_context)
    if not len(pool):
        return reserve(diagnostic['reason']) if modern else ([], diagnostic)
    recent_reward=np.zeros(len(keys));before_repeat=score.copy()
    if mode == 'change':
        # At most 200 rows: groups describe audio relations, not asserted genres.
        shortlist = pool[np.argsort(-score[pool], kind='stable')[:200]]
        relation = np.stack([semantic[keys[i]] for i in shortlist]) if use_semantic else matrix[shortlist]
        grouping_floor = DIRECTION_SIMILARITY if use_semantic else float((config.get('similarity') or {}).get('like_min', .975))
        # Prefer directions that have a legal next step, without hard-rejecting sparse libraries.
        if use_semantic:
            next_mask = np.array([paths[i] not in hard for i in sem_positions]) & (intent[sem_positions] <= CHANGE_MAX) & old_admissible[sem_positions]
            next_counts = ((relation @ sem_matrix.T >= max(.78, opts['semantic_floor']-.08)) & next_mask).sum(axis=1)-1
        else:
            next_mask = np.array([path not in hard for path in paths]) & (intent <= high)
            next_counts = ((relation @ matrix.T >= max(.94, float((config.get('similarity') or {}).get('like_min', .975))-.035)) & next_mask).sum(axis=1)-1
        future = {int(i): max(0, int(n)) for i, n in zip(shortlist,next_counts)}
        prefer_viable = any(future.values())
        groups = []
        centers = []
        for j, row in enumerate(relation):
            distances = np.array([float(row @ center) for center in centers])
            group = int(np.argmax(distances)) if len(distances) and distances.max() >= grouping_floor else len(groups)
            if group == len(groups):
                groups.append([]); centers.append(row)
            groups[group].append(int(shortlist[j]))
        # Round-robin first; large branches cannot consume the entire candidate cap.
        selected = []
        for depth in range(max(map(len, groups), default=0)):
            for group, members in enumerate(groups):
                if depth < len(members):
                    selected.append((members[depth], group))
                if len(selected) >= opts['candidate_limit']:
                    break
            if len(selected) >= opts['candidate_limit']:
                break
        group_counts = {g: sum(group == g for _, group in selected) for _, g in selected}
        weights = []
        corrections = []
        for i, group in selected:
            fix = correction(paths[i]) if correction else 1.
            fix = max(.5, min(2., float(fix))) if np.isfinite(fix) else 1.
            viability = .35 if prefer_viable and not future[i] else 1.
            preference = float(np.exp(np.clip(adjustment_delta[i]/.035, -5, 1))) if modern else 1.
            weights.append(fix*viability*preference/group_counts[group])
            corrections.append(fix)
        diagnostic['direction_count'] = len(group_counts)
    else:
        if recent:
            previous = matrix[[positions[key] for key in recent]]
            rolling = np.mean(matrix @ previous.T, axis=1)
            # Only reorders already admissible candidates; bounded tie-breaker.
            recent_reward=.01*np.clip((rolling-.95)/.05, 0, 1)
            score = score + recent_reward
        if modern:
            before_repeat=score.copy()
            chosen, weights, repeat_details, repeat_mask, score = balanced_selection(
                pool, score, paths, unseen, session, opts['candidate_limit'], opts['allow_older_repeats'], use_semantic)
            selected = [(i, None) for i in chosen]
            diagnostic.update(repeat_details)
        else:
            pool = pool[np.argsort(-score[pool], kind='stable')[:opts['candidate_limit']]]
            selected = [(int(i), None) for i in pool]
            weights = [1/(rank+1) for rank in range(len(selected))]
        corrections = [1.] * len(selected)
    total = sum(weights)
    rows = []
    for (i, group), weight, fix in zip(selected, weights, corrections):
        rows.append(dict(path=paths[i], sim=float(local[i]), sim_secondary=float(local[i]),
            audio_score=float(audio_base[i]),recent_reward=float(recent_reward[i]),repeat_penalty=float(before_repeat[i]-score[i]) if modern and mode!='change' else 0.,
            audio_primary=float(audio_base[i]-mert_adjustment[i]+bridge_penalty[i]),mert_adjustment=float(mert_adjustment[i]),bridge_penalty=float(bridge_penalty[i]),
            local_semantic_similarity=float(semantic[current]@semantic[keys[i]]) if current in semantic and keys[i] in semantic else None,
            semantic_similarity=float(support[i]) if use_semantic else None,
            bridge_similarity=float(bridge_similarity[i]) if fallback == 'connected_neighbourhood' or modern and bridge_only[i] else None,
            intent_similarity=float(intent[i]), suitability=float(score[i]),
            model=model, direction=group, weight=float(weight), probability=float(weight/total),
            correction_fix=float(fix),
            next_available=future.get(i, 0) if mode == 'change' else None,
            continuity_reward=1.))
        if modern:
            rows[-1].update({name: bool(values[i]) if name == 'tag_known' else float(values[i]) for name, values in signals.items()})
            rows[-1]['is_repeat'] = bool(repeat_mask[i]) if mode != 'change' else paths[i] in history_set
            if mode != 'change':
                level = next(j for j, (mask, _, _) in enumerate(stages) if mask[i])
                label, delta = stages[level][2], stages[level][1]
                rows[-1].update(admission_stage=label, admission_expansion=delta, cycle_exit=bool(stage_details.get('cycle_exit')),
                    admission_floor=((semantic_admission_floor(delta) if mode=='continue' else (opts['semantic_floor'] if not delta else max(.78, opts['semantic_floor']-delta)))
                        if use_semantic else (low if not delta else max(.94, low-delta))))
    if modern:
        diagnostic.update(returned_repeats=sum(bool(row['is_repeat']) for row in rows),
                          returned_bridges=sum(row['bridge_similarity'] is not None for row in rows))
    diagnostic['reason'] = 'ready' if rows else 'no_supported_direction'
    diagnostic['returned'] = len(rows)
    return reserve(diagnostic['reason']) if modern and not rows else (rows, diagnostic)
