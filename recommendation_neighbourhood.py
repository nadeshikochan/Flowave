"""Reference-local admission scales from an immutable, validated semantic snapshot.

No candidate/feedback filtering here: rejecting the closest song must never lower
the reference's threshold. Verified recording duplicates are collapsed upstream.
"""
import numpy as np


NEIGHBOUR_MARGIN = .025  # Same width as the existing semantic quality neighbourhood.
NEIGHBOUR_COUNT = 3  # One peer alone creates isolated pairs instead of a continuing route.


def semantic_reference_peaks(keys, semantic, references):
    ids = [key for key in keys if key in semantic]
    wanted = [key for key in dict.fromkeys(references) if key in semantic and key in ids]
    if len(ids) < 2 or not wanted:
        return {}
    positions = {key: i for i, key in enumerate(ids)}
    matrix = np.stack([semantic[key] for key in ids])
    scores = matrix @ np.stack([semantic[key] for key in wanted]).T
    for j, key in enumerate(wanted):
        scores[positions[key], j] = -np.inf
    third = np.partition(scores, -NEIGHBOUR_COUNT, axis=0)[-NEIGHBOUR_COUNT] if len(ids) > NEIGHBOUR_COUNT else None
    return {key: dict(peak=float(np.clip(scores[:, j].max(), -1., 1.)),
                      third=float(third[j]) if third is not None and third[j] > 0 else None)
            for j, key in enumerate(wanted)}


def reference_floor(base, neighbourhood, *, require_neighbours=False):
    # Fixed thresholds remain authoritative for references with supported peers.
    # Nonpositive best agreement is not evidence for a similar continuation.
    peak = neighbourhood.get('peak') if isinstance(neighbourhood, dict) else neighbourhood
    if peak is None or not np.isfinite(peak) or peak <= 0:
        return base
    third = neighbourhood.get('third') if isinstance(neighbourhood, dict) else None
    # A single marginal match just above the cutoff can still form an isolated pair.
    # Keep the fixed gate if it has three supported peers OR a clearly stronger peer;
    # feedback/cooldown filtering cannot change either fact.
    if (not require_neighbours and peak - NEIGHBOUR_MARGIN + 1e-7 >= base) or (third is not None and third + 1e-7 >= base):
        return base
    return max(0., min(float(peak) - NEIGHBOUR_MARGIN, third if third is not None else 1.))


def sparse_reference(base, neighbourhood, *, require_neighbours=False):
    actual = reference_floor(base, neighbourhood, require_neighbours=require_neighbours)
    peak = neighbourhood.get('peak') if isinstance(neighbourhood, dict) else neighbourhood
    return None if actual == base else dict(base_floor=base, effective_floor=actual,
        nearest_other=peak, margin=NEIGHBOUR_MARGIN, neighbours=NEIGHBOUR_COUNT,
        third_other=neighbourhood.get('third') if isinstance(neighbourhood, dict) else None)


def soft_context_reference(base, natural_base, neighbourhood, current_affinity):
    detail = sparse_reference(base, neighbourhood, require_neighbours=True)
    link_floor = reference_floor(natural_base, neighbourhood)
    # A lawful local bridge can carry an isolated reference forward. A current
    # song already outside that reference's neighbourhood cannot waive its guard.
    if detail is None or not np.isfinite(current_affinity) or current_affinity + 1e-7 < link_floor:
        return None
    detail.update(role='soft_context', neighbour_floor=detail['effective_floor'], effective_floor=None,
                  current_affinity=float(current_affinity), current_link_floor=link_floor)
    return detail
