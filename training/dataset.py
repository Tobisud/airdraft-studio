"""Read reviewed AirDraft exports and remove repeated sketch IDs."""
import json
from model import LABELS


def load_samples(paths):
    """Keep one record per sketch ID and surface conflicts before fitting."""
    records = {}
    duplicate_count = 0
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(payload, dict) or payload.get("format") != "airdraft-sketches-v1":
            raise ValueError(f"{path}: expected an AirDraft dataset JSON export.")
        samples = payload.get("samples")
        if not isinstance(samples, list):
            raise ValueError(f"{path}: missing samples array.")
        for index, sample in enumerate(samples, 1):
            if not isinstance(sample, dict):
                raise ValueError(f"{path}: sample {index} is not an object.")
            sample_id, label = sample.get("id"), sample.get("label")
            session = sample.get("sessionId")
            if not isinstance(sample_id, str) or not sample_id or label not in LABELS:
                raise ValueError(f"{path}: sample {index} has an invalid ID or label.")
            if not isinstance(session, str) or not session:
                raise ValueError(f"{path}: sample {sample_id} has no session ID.")
            previous = records.get(sample_id)
            if previous is not None:
                old, old_path = previous
                if any(old.get(key) != sample.get(key) for key in ("label", "strokes", "canvas", "sessionId")):
                    raise ValueError(f"Conflicting sketch {sample_id} in {old_path} and {path}. "
                                     "Resolve its label or duplicate record before training.")
                duplicate_count += 1
            else:
                records[sample_id] = (sample, path)
    if not records:
        raise ValueError("The exports contain no sketches.")
    return [sample for sample, _ in records.values()], duplicate_count
