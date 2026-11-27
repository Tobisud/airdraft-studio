"""Compare a frozen ImageNet MobileNetV3-Small with the AirDraft baselines."""
import argparse
from copy import deepcopy
import csv
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn.functional import interpolate
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

from dataset import load_samples
from model import LABELS, rasterize
from train import evaluate, metrics, plot_results, write_csv


def read_split(path, samples):
    sample_by_id = {sample["id"]:i for i,sample in enumerate(samples)}
    splits = {"train":[], "validation":[], "test":[]}
    used = set()
    with path.open(encoding="utf-8",newline="") as file:
        for row in csv.DictReader(file):
            identity = row["sketch_id"]
            if identity in used or identity not in sample_by_id or row["split"] not in splits:
                raise ValueError("Split manifest has an unknown or repeated sketch.")
            i = sample_by_id[identity]
            sample = samples[i]
            if row["label"] != sample["label"] or row["session_id"] != sample["sessionId"]:
                raise ValueError(f"Sketch {identity} does not match the saved label and session.")
            used.add(identity)
            splits[row["split"]].append(i)
    if len(used) != len(samples) or not all(splits.values()):
        raise ValueError("The manifest must assign every sketch to a nonempty split.")
    test_sessions = {samples[i]["sessionId"] for i in splits["test"]}
    if any(samples[i]["sessionId"] in test_sessions for k in ("train","validation") for i in splits[k]):
        raise ValueError("The held-out test session overlaps training or validation.")
    return {name:np.asarray(indices) for name,indices in splits.items()}


def make_backbone(pretrained=True):
    weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    net = mobilenet_v3_small(weights=weights)
    backbone = nn.Sequential(net.features,net.avgpool,nn.Flatten()).eval()
    backbone.requires_grad_(False)
    return backbone


@torch.inference_mode()
def extract(backbone, images):
    mean = torch.tensor([.485,.456,.406]).view(1,3,1,1)
    std = torch.tensor([.229,.224,.225]).view(1,3,1,1)
    chunks = []
    for image in np.array_split(images,max(1,(len(images)+15)//16)):
        gray = torch.from_numpy(image[:,None]).float()/255
        rgb = interpolate(gray,size=(224,224),mode="bilinear",align_corners=False).repeat(1,3,1,1)
        chunks.append(backbone((rgb-mean)/std))
    # Return ordinary tensors so the trainable head can save inputs for backward.
    return torch.cat(chunks).numpy().copy()


def batches(features, labels, shuffle=False, seed=42):
    dataset = torch.utils.data.TensorDataset(torch.from_numpy(features),torch.from_numpy(labels).long())
    return torch.utils.data.DataLoader(dataset,batch_size=16,shuffle=shuffle,
                                      generator=torch.Generator().manual_seed(seed))


def run(args):
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError(f"{args.out} is not empty.")
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    samples, _ = load_samples(args.inputs)
    splits = read_split(args.split,samples)
    train, validation, test = (splits[k] for k in ("train","validation","test"))
    labels = np.asarray([LABELS.index(sample["label"]) for sample in samples])
    if any(set(labels[indices]) != set(range(len(LABELS))) for indices in splits.values()):
        raise ValueError("Every split must contain all six labels.")
    backbone = make_backbone()
    # The frozen BatchNorm layers stay in evaluation mode. Extract only development features here.
    training = extract(backbone,np.stack([rasterize(samples[i]) for i in train]))
    validated = extract(backbone,np.stack([rasterize(samples[i]) for i in validation]))
    head = nn.Linear(training.shape[1],len(LABELS))
    optimizer = torch.optim.AdamW(head.parameters(),lr=.003,weight_decay=.001)
    weights = torch.tensor(len(train)/(len(LABELS)*np.bincount(labels[train])),dtype=torch.float32)
    weighted = nn.CrossEntropyLoss(weight=weights)
    criterion = nn.CrossEntropyLoss()
    shuffled = batches(training,labels[train],True,args.seed)
    train_batches = batches(training,labels[train])
    validation_batches = batches(validated,labels[validation])
    best_loss,best_epoch,checkpoint = float("inf"),0,None
    history = []
    for epoch in range(1,args.epochs+1):
        head.train()
        norms = []
        for x,y in shuffled:
            optimizer.zero_grad(set_to_none=True)
            weighted(head(x),y).backward()
            norms.append(float(nn.utils.clip_grad_norm_(head.parameters(),3.0)))
            optimizer.step()
        train_loss,train_guess,train_true = evaluate(head,train_batches,criterion)
        val_loss,val_guess,val_true = evaluate(head,validation_batches,criterion)
        history.append({
            "epoch":epoch,"train_loss":train_loss,"validation_loss":val_loss,
            "train_accuracy":float(np.mean(train_guess==train_true)),
            "validation_accuracy":float(np.mean(val_guess==val_true)),
            "gradient_norm":float(np.mean(norms)),
        })
        if val_loss < best_loss-1e-5:
            best_loss,best_epoch,checkpoint = val_loss,epoch,deepcopy(head.state_dict())
        if epoch == 1 or epoch % 10 == 0:
            print(f"Epoch {epoch}: validation accuracy {history[-1]['validation_accuracy']:.1%}, loss {val_loss:.3f}",flush=True)
        if epoch-best_epoch >= args.patience:
            break

    head.load_state_dict(checkpoint)
    tested = extract(backbone,np.stack([rasterize(samples[i]) for i in test]))
    test_loss,guess,truth = evaluate(head,batches(tested,labels[test]),criterion)
    result = metrics(truth,guess)
    result["loss"] = test_loss
    result["correct"] = int(np.sum(guess==truth))
    report = {
        "model":"MobileNetV3-Small frozen ImageNet features + linear head",
        "pretrained_weights":"IMAGENET1K_V1","seed":args.seed,
        "split":{name:len(indices) for name,indices in splits.items()},
        "frozen_parameters":sum(p.numel() for p in backbone.parameters()),
        "trainable_parameters":sum(p.numel() for p in head.parameters()),
        "epochs_run":len(history),"best_epoch":best_epoch,
        "validation_accuracy":history[best_epoch-1]["validation_accuracy"],
        "test":result,
    }
    args.out.mkdir(parents=True,exist_ok=True)
    torch.save({"backbone_state_dict":backbone.state_dict(),"head_state_dict":checkpoint,
                "labels":LABELS,"input_size":224,"image_net_mean":[.485,.456,.406],
                "image_net_std":[.229,.224,.225]},args.out/"mobilenet-v3-small.pt")
    (args.out/"metrics.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    write_csv(args.out/"epochs.csv",history[0].keys(),[row.values() for row in history])
    write_csv(args.out/"test-predictions.csv",("sketch_id","actual","prediction"),
              [(samples[i]["id"],LABELS[actual],LABELS[predicted]) for i,actual,predicted in zip(test,truth,guess)])
    plot_results(history,best_epoch,result,args.out,"MobileNetV3-Small")
    print(f"Test {result['correct']}/{len(test)}, accuracy {result['accuracy']:.2%}, macro F1 {result['macro_f1']:.4f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs",nargs="+",type=Path)
    parser.add_argument("--split",type=Path,default=Path("results/split.csv"))
    parser.add_argument("--out",type=Path,default=Path("mobilenet-results"))
    parser.add_argument("--seed",type=int,default=42)
    parser.add_argument("--epochs",type=int,default=100)
    parser.add_argument("--patience",type=int,default=15)
    args = parser.parse_args()
    if min(args.epochs,args.patience) < 1:
        parser.error("Epochs and patience must be positive.")
    run(args)


if __name__ == "__main__":
    main()
