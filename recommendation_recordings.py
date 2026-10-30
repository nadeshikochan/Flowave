"""Recommendation-only grouping of verified identical audio payloads; identities stay independent."""
from collections import defaultdict


def collapse(index, current, context, recent, history, protected, blocked, excluded, session, unavailable, groups, prepared, semantic=()):
    buckets=defaultdict(list)
    for key in index:buckets[groups.get(key) or ('resource',key)].append(key)
    if all(len(items)==1 for items in buckets.values()):return None
    failed=set(unavailable)
    preferred=[current,*reversed(context),*reversed(recent),*reversed(session.get('direction',[]))]
    mapping={};members={};chosen=set()
    for items in buckets.values():
        available=[k for k in items if index[k][0] not in failed] or items
        if current not in available:available=[k for k in available if k in semantic] or available
        representative=next((k for k in preferred if k in available),min(available))
        chosen.add(representative);members[representative]=items
        mapping.update({k:representative for k in items})
    keymap=lambda k:mapping.get(k,k)
    paths={index[k][0]:index[keymap(k)][0] for k in index}
    pathmap=lambda p:paths.get(p,p)
    keysmap=lambda values:list(dict.fromkeys(keymap(k) for k in values))
    next_session={**session,'direction':keysmap(session.get('direction',[])),
        'origin':keymap(session.get('origin','')),
        'route':keysmap(session.get('route',[])),
        'negatives':[{**n,'key':keymap(n.get('key')),'positive':keysmap(n.get('positive',[]))} for n in session.get('negatives',[])],
        'memories':[{**m,'keys':keysmap(m.get('keys',[]))} for m in session.get('memories',[])],
        'plays':[pathmap(p) for p in session.get('plays',[])]}
    next_session['negatives']=list({n['key']:n for n in next_session['negatives']}.values())
    # An unreadable copy does not make the other copies unreadable.
    unavailable_reps=[index[k][0] for k,items in members.items() if all(index[item][0] in failed for item in items)]
    keys,source_paths,matrix,positions=prepared
    ids=[i for i,k in enumerate(keys) if k in chosen]
    new_keys=[keys[i] for i in ids];new_paths=[source_paths[i] for i in ids]
    return dict(index={k:v for k,v in index.items() if k in chosen},current=keymap(current),
        context=keysmap(context),recent=keysmap(recent),history=[pathmap(p) for p in history],
        protected=[pathmap(p) for p in protected],blocked=[pathmap(p) for p in blocked],
        excluded=keysmap(excluded or []),session=next_session,unavailable=unavailable_reps,
        prepared=(new_keys,new_paths,matrix[ids],{k:i for i,k in enumerate(new_keys)}),members=members,keymap=mapping)
