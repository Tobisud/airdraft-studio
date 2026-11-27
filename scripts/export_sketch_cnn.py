"""Export the trained AirDraft SketchCNN as browser-ready little-endian weights."""
import argparse
from pathlib import Path

import torch


def export(checkpoint, output):
    saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if tuple(saved["labels"]) != ("stickman", "house", "fish", "bird", "tree", "flower") or saved["image_size"] != 64:
        raise ValueError("Expected the six-class 64×64 AirDraft checkpoint.")
    state = saved["state_dict"]
    expected = ((16, 1), (32, 16), (48, 32))
    arrays = []
    for index, (out_channels, in_channels) in zip((0, 4, 8), expected):
        weights = state[f"features.{index}.weight"]
        if weights.shape != (out_channels, in_channels, 3, 3):
            raise ValueError("Unexpected convolution dimensions.")
        batch_norm = f"features.{index+1}."
        scale = state[batch_norm+"weight"] / (state[batch_norm+"running_var"] + 1e-5).sqrt()
        bias = state[batch_norm+"bias"] - scale * state[batch_norm+"running_mean"]
        arrays.extend((weights * scale[:, None, None, None], bias))
    weights, bias = state["classifier.2.weight"], state["classifier.2.bias"]
    if weights.shape != (6, 48*4*4) or bias.shape != (6,):
        raise ValueError("Unexpected classifier dimensions.")
    arrays.extend((weights, bias))
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_bytes(b"ACN1" + b"".join(array.numpy().astype("<f4").tobytes() for array in arrays))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    export(args.checkpoint,args.output)
