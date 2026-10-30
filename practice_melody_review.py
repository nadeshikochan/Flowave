"""Reversible experimental pitch preview; never edits raw notes or boundaries."""
import math
import re
from practice_melody_evidence import validate_evidence

MODES = {'standard': (.10, .03), 'strict': (.20, .06)}
PCS = dict(C=0, D=2, E=4, F=5, G=7, A=9, B=11)


def rounded(value):
    return math.floor(value + .5)


def pitch_class(name):
    match = re.fullmatch(r'([A-G])([#b]*)', name)
    return (PCS[match[1]] + match[2].count('#') - match[2].count('b')) % 12 if match else None


def scale_for(label):
    tonic, separator, mode = label.partition(':')
    pc = pitch_class(tonic)
    if pc is None or not separator or mode not in ('major', 'minor'):
        return None
    # Harmonic/melodic minor leading tones must not be penalized as mistakes.
    steps = [0, 2, 4, 5, 7, 9, 11] if mode == 'major' else [0, 2, 3, 5, 7, 8, 9, 10, 11]
    return {(pc + value) % 12 for value in steps}


def chord_support(label, pc):
    match = re.fullmatch(r'([A-G][#b]*)(?::([^/]+))?(?:/.+)?', label)
    if not match:
        return False
    root = pitch_class(match[1]); quality = match[2] or 'maj'
    intervals = {'maj':[0,4,7], 'min':[0,3,7], '7':[0,4,7,10], 'maj7':[0,4,7,11], 'min7':[0,3,7,10]}.get(quality, [])
    return root is not None and pc in {(root + n) % 12 for n in intervals}


def preview_review(payload, evidence, mode):
    if mode not in MODES:
        raise ValueError('请选择标准或严格复核。')
    validate_evidence(evidence, payload)
    window, margin = MODES[mode]
    activations = [scores for chunk in evidence['chunks'] for row, scores in zip(chunk['regions'],chunk['pitch_activation']) if row[3] and row[1] > row[0]]
    notes = [list(n) for n in payload['notes']]
    changes = []
    for index, (note, scores) in enumerate(zip(payload['notes'], activations)):
        a, b, p, _ = note
        keys = [key for start,end,key in payload['keys'] if start <= a and end >= b]
        if len(keys) != 1 or b-a < .15:
            continue
        scale = scale_for(keys[0]); old = rounded(p)
        if scale is None or old % 12 in scale:
            continue
        if any(start < b and end > a and chord_support(chord,old%12) for start,end,chord in payload['chords']):
            continue
        if 0 < index < len(notes)-1:
            previous, following = payload['notes'][index-1], payload['notes'][index+1]
            if (rounded(previous[2]) == rounded(following[2]) and abs(old-rounded(previous[2])) == 1
                    and a-previous[1] < .15 and following[0]-b < .15):
                continue  # Preserve potentially real chromatic neighbour figures, e.g. 5 #4 5.
        candidates = [q for q in (old-1,old+1) if 0 <= q <= 127 and q%12 in scale and abs(p-(old+q)/2) <= window]
        if not candidates:
            continue
        chosen = max(candidates, key=lambda q:scores[q*2])
        # Independent sigmoid activations are evidence, not calibrated probabilities.
        if scores[chosen*2] < .2 or scores[old*2]-scores[chosen*2] > margin:
            continue
        notes[index][2] = float(chosen)
        changes.append(dict(index=index,start=a,old=p,new=chosen,reason='ambiguous-chromatic-candidate'))
    return dict(notes=notes, changes=changes, mode=mode, experimental=True,
                recipe='chromatic-preview-v1; fixed gates; no boundary edits; no raw overwrite')
