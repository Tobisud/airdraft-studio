"""Train a CPU CNN on reviewed AirDraft sketches and evaluate a held-out session."""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import csv
import json
from pathlib import Path

import cv2
import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.svm import LinearSVC
import torch
from torch.utils.data import DataLoader, Dataset, TensorDataset

from dataset import load_samples
from model import HOG_SETTINGS, IMAGE_SIZE, LABELS, SketchCNN, rasterize


def source(sample):
    return "+".join(sorted({stroke["source"] for stroke in sample["strokes"]}))


def make_split(samples, labels, seed, participants=None):
    groups = defaultdict(list)
    for i, sample in enumerate(samples):
        session = sample["sessionId"]
        groups[participants[session] if participants else session].append(i)
    eligible = []
    expected = set(range(len(LABELS)))
    for group, indices in groups.items():
        held = set(indices)
        development = [i for i in range(len(samples)) if i not in held]
        if set(labels[indices]) != expected or set(labels[development]) != expected:
            continue
        if min(Counter(labels[development]).values()) < 2:
            continue
        camera_only = all(source(samples[i]) == "camera" for i in indices)
        eligible.append((not camera_only, abs(len(indices)/len(samples)-.30), group, development, indices))
    if not eligible:
        raise ValueError("A held-out group and the remaining development set must both contain all six labels.")
    _, _, group, development, test = min(eligible)
    train, validation = train_test_split(development, test_size=.20, random_state=seed,
                                         stratify=labels[development])
    return {"train":np.asarray(train), "validation":np.asarray(validation), "test":np.asarray(test)}, group


class AugmentedSketches(Dataset):
    def __init__(self, images, labels, seed):
        self.images, self.labels = images, labels
        self.rng = np.random.default_rng(seed)

    def __len__(self):
        return len(self.images)

    def __getitem__(self, index):
        image = self.images[index]
        transform = cv2.getRotationMatrix2D(((IMAGE_SIZE-1)/2,)*2,
                    float(self.rng.uniform(-12,12)), float(self.rng.uniform(.90,1.08)))
        transform[:,2] += self.rng.uniform(-2,2,size=2)
        image = cv2.warpAffine(image,transform,(IMAGE_SIZE,IMAGE_SIZE),flags=cv2.INTER_LINEAR)
        return torch.from_numpy(image[None]).float()/255, int(self.labels[index])


def loader(images, labels):
    return DataLoader(TensorDataset(torch.from_numpy(images[:,None]).float()/255,
                                    torch.from_numpy(labels).long()),batch_size=32)


@torch.no_grad()
def evaluate(model, batches, criterion):
    model.eval()
    loss = 0.
    guesses, labels = [], []
    for images, targets in batches:
        logits = model(images)
        loss += criterion(logits,targets).item()*len(targets)
        guesses.extend(logits.argmax(1).tolist())
        labels.extend(targets.tolist())
    return loss/len(labels), np.asarray(guesses), np.asarray(labels)


def metrics(truth, predicted):
    ids = range(len(LABELS))
    return {
        "accuracy":accuracy_score(truth,predicted),
        "macro_f1":f1_score(truth,predicted,labels=list(ids),average="macro",zero_division=0),
        "per_class":classification_report(truth,predicted,labels=list(ids),target_names=LABELS,
                                           output_dict=True,zero_division=0),
        "confusion_matrix":confusion_matrix(truth,predicted,labels=list(ids)).tolist(),
    }


def plot_results(history, best_epoch, result, out, model_name="CNN"):
    plt.rcParams.update({"font.size":10,"axes.spines.top":False,"axes.spines.right":False})
    epochs = [row["epoch"] for row in history]
    palette = ("#4b4194","#038574")
    fig, axes = plt.subplots(1,3,figsize=(13.2,4.2),layout="constrained")
    for axis, metric, title in zip(axes,("loss","accuracy","gradient_norm"),
                                   ("Cross-entropy loss","Classification accuracy","Gradient norm before clipping")):
        if metric == "gradient_norm":
            axis.plot(epochs,[row[metric] for row in history],color=palette[0])
            axis.set_ylabel("Mean minibatch L2 norm")
        else:
            for name,color in zip(("train","validation"),palette):
                axis.plot(epochs,[row[f"{name}_{metric}"] for row in history],label=name.title(),color=color)
            axis.legend(frameon=False)
            if metric == "accuracy":
                axis.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1))
                axis.set_ylim(0,1.03)
        axis.axvline(best_epoch,color="#655d6a",linestyle=":",linewidth=1)
        axis.set(title=title,xlabel="Epoch")
        axis.grid(axis="y",alpha=.22)
    fig.suptitle(f"AirDraft {model_name} training · best validation checkpoint at epoch {best_epoch}")
    fig.savefig(out/"training-curves.png",dpi=200)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(6.6,5.6),layout="constrained")
    matrix = np.asarray(result["confusion_matrix"])
    heat = ax.imshow(matrix,cmap="Purples",vmin=0)
    for row,col in np.ndindex(matrix.shape):
        ax.text(col,row,matrix[row,col],ha="center",va="center",
                color="white" if matrix[row,col] > matrix.max()/2 else "#26213c")
    ax.set(xticks=range(len(LABELS)),xticklabels=LABELS,yticks=range(len(LABELS)),yticklabels=LABELS,
           xlabel="Predicted label",ylabel="Reviewed label",title=f"{model_name} on the held-out camera session")
    fig.colorbar(heat,ax=ax,shrink=.8,label="Sketches")
    fig.savefig(out/"confusion-matrix.png",dpi=200)
    plt.close(fig)


def write_csv(path, columns, rows):
    with path.open("w",newline="",encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(columns)
        writer.writerows(rows)


def run(args):
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError(f"{args.out} is not empty. Choose a new output directory.")
    torch.set_num_threads(2)
    torch.manual_seed(args.seed)
    samples, duplicates = load_samples(args.inputs)
    labels = np.array([LABELS.index(sample["label"]) for sample in samples])
    if set(labels) != set(range(len(LABELS))):
        raise ValueError("The reviewed exports must contain all six classes.")
    participants = None
    if args.participants:
        participants = json.loads(args.participants.read_text())
        if not isinstance(participants,dict) or any(
            not isinstance(participants.get(s["sessionId"]),str) or not participants[s["sessionId"]].strip()
            for s in samples
        ):
            raise ValueError("Assign an anonymous participant code to every session.")
    split, test_group = make_split(samples, labels, args.seed, participants)
    train, validation, test = (split[name] for name in ("train","validation","test"))
    images = np.stack([rasterize(sample) for sample in samples])
    print("Split:", {name:len(ids) for name,ids in split.items()}, flush=True)
    batches = DataLoader(AugmentedSketches(images[train],labels[train],args.seed),batch_size=16,
                         shuffle=True,generator=torch.Generator().manual_seed(args.seed))
    clean_train = loader(images[train],labels[train])
    val_batches = loader(images[validation],labels[validation])
    counts = np.bincount(labels[train],minlength=len(LABELS))
    weights = torch.tensor(len(train)/(len(LABELS)*counts),dtype=torch.float32)
    weighted_loss = torch.nn.CrossEntropyLoss(weight=weights)
    plain_loss = torch.nn.CrossEntropyLoss()
    model = SketchCNN()
    optimizer = torch.optim.AdamW(model.parameters(),lr=.001,weight_decay=.001)
    history = []
    checkpoint, best_loss, best_epoch = None, float("inf"), 0
    for epoch in range(1,args.epochs+1):
        model.train()
        norms = []
        for x,y in batches:
            optimizer.zero_grad(set_to_none=True)
            loss = weighted_loss(model(x),y)
            loss.backward()
            norms.append(float(torch.nn.utils.clip_grad_norm_(model.parameters(),3.0)))
            optimizer.step()
        train_loss, train_pred, train_true = evaluate(model,clean_train,plain_loss)
        val_loss, val_pred, val_true = evaluate(model,val_batches,plain_loss)
        row = {"epoch":epoch,"train_loss":train_loss,"validation_loss":val_loss,
               "train_accuracy":float(np.mean(train_pred==train_true)),
               "validation_accuracy":float(np.mean(val_pred==val_true)),
               "gradient_norm":float(np.mean(norms))}
        history.append(row)
        if val_loss < best_loss - 1e-5:
            checkpoint,best_loss,best_epoch = deepcopy(model.state_dict()),val_loss,epoch
        if epoch == 1 or epoch % 10 == 0:
            print(f"Epoch {epoch}: validation loss {val_loss:.3f}, accuracy {row['validation_accuracy']:.1%}",flush=True)
        if epoch-best_epoch >= args.patience:
            break

    model.load_state_dict(checkpoint)
    test_loss, guess, truth = evaluate(model,loader(images[test],labels[test]),plain_loss)
    cnn = metrics(truth,guess)
    cnn["loss"] = test_loss
    hog = cv2.HOGDescriptor(*HOG_SETTINGS)
    features = np.stack([hog.compute(image).ravel() for image in images])
    baseline = LinearSVC(class_weight="balanced",random_state=args.seed,max_iter=10000)
    baseline.fit(features[train],labels[train])
    svm_guess = baseline.predict(features[test])
    report = {
        "total":len(samples),"duplicate_ids_removed":duplicates,
        "labels":LABELS,"split":{
            name:{"count":len(ids),"percent":round(len(ids)/len(samples)*100,3),
                  "labels":dict(Counter(samples[i]["label"] for i in ids)),
                  "sources":dict(Counter(source(samples[i]) for i in ids))}
            for name,ids in split.items()
        },
        "grouping":"participant" if participants else "session",
        "test_group":test_group,"seed":args.seed,
        "cnn":{"parameters":sum(p.numel() for p in model.parameters()),"epochs_run":len(history),
               "best_epoch":best_epoch,"best_validation_loss":best_loss,
               "best_validation_accuracy":history[best_epoch-1]["validation_accuracy"],"test":cnn},
        "hog_svm":{"test":metrics(truth,svm_guess)},
    }
    args.out.mkdir(parents=True,exist_ok=True)
    torch.save({"state_dict":checkpoint,"labels":LABELS,"image_size":IMAGE_SIZE},args.out/"sketch-cnn.pt")
    joblib.dump({"classifier":baseline,"labels":LABELS,"hog_settings":HOG_SETTINGS},args.out/"hog-svm.joblib")
    (args.out/"metrics.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    write_csv(args.out/"epochs.csv",history[0].keys(),[row.values() for row in history])
    write_csv(args.out/"split.csv",("sketch_id","split","label","source","session_id"),[
        (samples[i]["id"],name,samples[i]["label"],source(samples[i]),samples[i]["sessionId"])
        for name,ids in split.items() for i in ids
    ])
    write_csv(args.out/"test-predictions.csv",("sketch_id","actual","cnn_prediction","svm_prediction"),[
        (samples[i]["id"],LABELS[actual],LABELS[cnn_label],LABELS[svm_label])
        for i,actual,cnn_label,svm_label in zip(test,truth,guess,svm_guess)
    ])
    plot_results(history,best_epoch,cnn,args.out)
    print(f"CNN test accuracy {cnn['accuracy']:.1%}, macro F1 {cnn['macro_f1']:.3f}.",flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs",nargs="+",type=Path)
    parser.add_argument("--out",type=Path,default=Path("results"))
    parser.add_argument("--participants",type=Path,help="Optional JSON mapping each session ID to an anonymous participant code.")
    parser.add_argument("--seed",type=int,default=42)
    parser.add_argument("--epochs",type=int,default=80)
    parser.add_argument("--patience",type=int,default=15)
    args = parser.parse_args()
    if min(args.epochs,args.patience) < 1:
        parser.error("Epochs and patience must be positive.")
    try:
        run(args)
    except (OSError,ValueError) as error:
        parser.exit(2,f"{error}\n")


if __name__ == "__main__":
    main()
