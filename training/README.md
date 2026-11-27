# AirDraft sketch classification

| Classifier | Correct on test | Test accuracy | Macro F1 |
|---|---:|---:|---:|
| Small CNN trained from scratch | 59/60 | 98.33% | 0.9833 |
| OpenCV HOG + linear SVM | 57/60 | 95.00% | 0.9488 |
| Frozen MobileNetV3-Small + linear head | 56/60 | 93.33% | 0.9333 |

All three classifiers used the same train, validation, and test split. AirDraft Studio uses the Small CNN in browser **Auto detect** mode.

## Data and split

The three reviewed exports contained 200 unique sketches. There were no duplicate IDs, conflicting labels, or identical stroke records under different IDs. Only the supplied AirDraft sketches were used.

| Class | Training | Validation | Test | Total |
|---|---:|---:|---:|---:|
| Stickman | 19 | 5 | 10 | 34 |
| House | 20 | 5 | 10 | 35 |
| Fish | 20 | 5 | 10 | 35 |
| Bird | 12 | 3 | 10 | 25 |
| Tree | 21 | 5 | 10 | 36 |
| Flower | 20 | 5 | 10 | 35 |
| **Total** | **112 (56%)** | **28 (14%)** | **60 (30%)** | **200** |

The test set is the entire 60-sketch camera-only session, with ten drawings of each class. It was selected for complete class coverage and camera input before training. The other two sessions were split 80/20 by class into training and validation using seed 42. No test examples entered training or checkpoint selection. Training and validation can share session IDs. No participant mapping was provided, so the experiment measures performance on one unseen session and cannot verify generalization to unseen drawers.

## Method

OpenCV projects each sketch onto a centered 64 × 64 grayscale image while preserving its aspect ratio. During CNN training only, images receive small rotations, translations, and scale changes. The CNN has three convolutional blocks and 23,382 trainable parameters. It produces six class scores.

The CNN ran on CPU with AdamW, a learning rate of 0.001, weight decay of 0.001, minibatches of 16, and class-weighted cross-entropy. Gradient L2 norms were recorded before clipping at 3.0. Train and validation curves show unweighted cross-entropy measured without augmentation, so their values are comparable. The best checkpoint was selected by lowest validation loss. Training stopped after 15 epochs without improvement.

The comparison baseline uses OpenCV HOG features and a class-weighted linear SVM. Both models used the same 112 training sketches and the same held-out test set.

## Small CNN and SVM results

The CNN ran for 39 epochs and selected epoch 24, with 96.43% validation accuracy. Its only test error was a tree classified as a fish. The SVM classified three flowers as stickmen. These are pilot results on one camera session. Test another participant before generalizing the result.

[CNN training curves and gradient norms](results/training-curves.png) · [CNN confusion matrix](results/confusion-matrix.png) · [CNN and SVM metrics](results/metrics.json)

## Reproduce

This run used Python 3.12 and PyTorch 2.9.1 on CPU. Create a fresh virtual environment and run these commands from the `training/` directory. The original reviewed sketch exports are held by the project team. To reproduce the reported run, supply your local copies of the three JSON files.

```sh
# Linux or Windows, CPU-only PyTorch build
python -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt

python train.py "airdraft-reviewed-2026-11-27 (2).json" "airdraft-reviewed-2026-11-27 (1).json" "airdraft-reviewed-2026-11-27.json" --out reproduced-results
```

On macOS, use the appropriate PyTorch wheel from PyPI. Keep the original input order above to reproduce the stratified validation split. The three reviewed exports are separate input files. To distinguish repeat sessions from one person in a future run, supply `--participants` with a JSON object mapping session IDs to anonymous participant codes.

## Files

- `train.py` — data splitting, CPU training, evaluation, and plot generation.
- `model.py` — CNN architecture and sketch rasterization.
- `dataset.py` — AirDraft JSON parsing, deduplication, and conflict checks.
- `results/training-curves.png` — loss, accuracy, and gradient magnitude by epoch.
- `results/confusion-matrix.png` — CNN predictions on the camera test session.
- `results/metrics.json` — exact counts, scores, and per-class metrics for both models.
- `results/epochs.csv`, `results/split.csv`, and `results/test-predictions.csv` — epoch history, split manifest, and test predictions.
- [`results/sketch-cnn.pt`](results/sketch-cnn.pt) and [`results/hog-svm.joblib`](results/hog-svm.joblib) — trained CNN and SVM checkpoints.

## Third model: MobileNetV3-Small

For MobileNet, the same 64 × 64 rasters were bilinearly resized to 224 × 224, copied to three channels, and normalized with the ImageNet channel means and standard deviations. The ImageNet backbone stayed frozen in evaluation mode. Its pooled 576-value features fed a new six-class linear head with 3,462 trainable parameters. The head used weighted cross-entropy and AdamW at a learning rate of 0.003, with batches of 16 and early stopping after 15 epochs without validation loss improvement. This version used no sketch augmentation. The lowest validation loss was at epoch 64, with 96.43% validation accuracy. Training stopped after epoch 79.

The held-out errors were two flowers predicted as stickmen, one tree predicted as a stickman, and one tree predicted as a fish. The result applies to this frozen-backbone experiment and one camera session. It does not establish how MobileNet would perform after fine-tuning or on an independent participant.

[MobileNet training curves and gradient norms](mobilenet-results/training-curves.png) · [MobileNet confusion matrix](mobilenet-results/confusion-matrix.png) · [MobileNet metrics](mobilenet-results/metrics.json)

Install matching Torchvision alongside PyTorch. For the Linux or Windows CPU builds:

```sh
python -m pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
python train_mobilenet.py "airdraft-reviewed-2026-11-27 (2).json" "airdraft-reviewed-2026-11-27 (1).json" "airdraft-reviewed-2026-11-27.json" --split results/split.csv --out reproduced-mobilenet
```

`train_mobilenet.py` reads the split manifest. It downloads the [Torchvision ImageNet weights](https://docs.pytorch.org/vision/stable/models/generated/torchvision.models.mobilenet_v3_small.html) on its first run if they are missing from the local cache. The [trained checkpoint](mobilenet-results/mobilenet-v3-small.pt) includes the frozen backbone and trained head. Load it with `make_backbone(pretrained=False)` to use the saved weights offline.
