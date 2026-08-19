"""
Rep-load calculator: convert between different rep/set schemes at equal difficulty.

Uses Epley's formula for 1RM estimation:
    1RM = weight * (1 + reps / 30)

Then we estimate the load for a target rep count:
    target_weight = 1RM / (1 + target_reps / 30)

RIR (Reps In Reserve) adjustment:
    If a set was done at RIR > 0, the effective max reps = actual_reps + RIR.
    We compute e1RM from that, then back-calculate.

Set-count adjustment (volume matching):
    When converting from one set×rep scheme to another, we aim to keep total
    "effective volume" (sets * reps relative to 1RM) roughly constant.
    
    Normalized volume load = sets * reps * (%1RM)
    We solve for target sets so that normalized volume is preserved.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Scheme:
    sets: int
    reps: int
    load_kg: float
    rir: float = 0.0


@dataclass
class ConvertedScheme:
    sets: int
    reps: int
    load_kg: float
    rir: float
    difficulty_match: str  # "exact", "approximate", "rough"


def estimate_1rm(weight: float, reps: int, rir: float = 0.0) -> float:
    """
    Estimate 1RM using Epley's formula, adjusted for RIR.
    Effective reps = actual reps + RIR (the reps you *could* have done).
    For reps <= 1: if it's a 1RM test, just return the weight.
    """
    if reps <= 0:
        return weight
    effective_reps = reps + rir
    if effective_reps <= 0:
        return weight
    if effective_reps == 1:
        return weight * 1.03  # Epley slightly overestimates at 1 rep
    return weight * (1 + effective_reps / 30.0)


def weight_from_1rm(one_rm: float, target_reps: int, target_rir: float = 0.0) -> float:
    """
    Calculate the weight needed to hit a given rep count at a given RIR,
    based on the estimated 1RM.
    """
    effective_reps = target_reps + target_rir
    if effective_reps <= 0:
        return one_rm
    return one_rm / (1 + effective_reps / 30.0)


def normalize_scheme(scheme: Scheme) -> float:
    """
    Compute normalized volume load: sets * reps * (%1RM).
    This is our measure of "how hard the whole exercise was".
    """
    e1rm = estimate_1rm(scheme.load_kg, scheme.reps, scheme.rir)
    if e1rm <= 0:
        return 0
    intensity = scheme.load_kg / e1rm
    return scheme.sets * scheme.reps * intensity


DIFFICULTY_ORDER = ["exact", "approximate", "rough"]


def convert_scheme(source: Scheme, target_reps: int,
                   target_rir: float = 0.0,
                   target_sets: Optional[int] = None) -> list[ConvertedScheme]:
    """
    Convert a source scheme to equivalent target rep schemes.
    
    If target_sets is provided, we compute the load for that exact sets×reps combo.
    If not, we suggest multiple set counts that preserve roughly equal volume.
    
    Returns a list of ConvertedScheme suggestions, sorted by best match.
    """
    e1rm = estimate_1rm(source.load_kg, source.reps, source.rir)
    source_nvl = normalize_scheme(source)

    target_weight = weight_from_1rm(e1rm, target_reps, target_rir)
    target_intensity = target_weight / e1rm if e1rm > 0 else 0

    results = []

    if target_sets is not None:
        # Exact request
        tgt_nvl = target_sets * target_reps * target_intensity
        match_quality = _match_quality(source_nvl, tgt_nvl)
        results.append(ConvertedScheme(
            sets=target_sets,
            reps=target_reps,
            load_kg=round(target_weight, 1),
            rir=target_rir,
            difficulty_match=match_quality
        ))
    else:
        # Suggest multiple set counts
        candidates = []
        for s in range(1, 13):
            tgt_nvl = s * target_reps * target_intensity
            ratio = tgt_nvl / source_nvl if source_nvl > 0 else 0
            # Penalize being far from source volume
            candidates.append((s, tgt_nvl, ratio))

        # Sort by how close ratio is to 1.0
        candidates.sort(key=lambda c: abs(c[2] - 1.0))

        for s, nvl, ratio in candidates[:4]:
            match_quality = _match_quality(source_nvl, nvl)
            results.append(ConvertedScheme(
                sets=s,
                reps=target_reps,
                load_kg=round(target_weight, 1),
                rir=target_rir,
                difficulty_match=match_quality
            ))

    # Sort by best match
    results.sort(key=lambda r: DIFFICULTY_ORDER.index(r.difficulty_match))
    return results


def _match_quality(source_nvl: float, target_nvl: float) -> str:
    """Rate how well the target volume load matches the source."""
    if source_nvl <= 0:
        return "rough"
    ratio = target_nvl / source_nvl
    if 0.90 <= ratio <= 1.10:
        return "exact"
    elif 0.75 <= ratio <= 1.33:
        return "approximate"
    else:
        return "rough"


def parse_scheme_str(text: str) -> Optional[Scheme]:
    """
    Parse a string like '5x5 @ 180kg rir 2' or '3x10 at 100' into a Scheme.
    Returns None if parsing fails.
    """
    import re
    text = text.strip().lower()

    # Pattern: [sets]x[reps] @ [weight][unit] [rir X]
    pat = r'(\d+)\s*x\s*(\d+)\s*(?:@|at)\s*([\d.]+)\s*(kg|lb)?(?:\s*rir\s*(\d+))?'
    m = re.search(pat, text)
    if not m:
        return None

    sets = int(m.group(1))
    reps = int(m.group(2))
    weight = float(m.group(3))
    rir = float(m.group(5)) if m.group(5) else 0.0
    return Scheme(sets=sets, reps=reps, load_kg=weight, rir=rir)


# Convenience: known rep-scheme conversion table
REP_SCHEME_INFO = {
    1:  "Single / 1RM test",
    2:  "Double",
    3:  "Triple",
    4:  "Heavy strength (4)",
    5:  "Strength (5)",
    6:  "Strength-hypertrophy (6)",
    8:  "Hypertrophy (8)",
    10: "Hypertrophy-endurance (10)",
    12: "Endurance (12)",
    15: "High-rep pump (15)",
    20: "Very high rep (20)",
}
