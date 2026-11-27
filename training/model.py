"""AirDraft six-class CNN and sketch preprocessing."""
import cv2
import numpy as np
from torch import nn

LABELS = ("stickman", "house", "fish", "bird", "tree", "flower")
IMAGE_SIZE = 64
MARGIN = 7
HOG_SETTINGS = ((64, 64), (16, 16), (8, 8), (8, 8), 9)


class SketchCNN(nn.Module):
    def __init__(self, classes=len(LABELS)):
        super().__init__()
        layers = []
        channels = 1
        for width in (16, 32, 48):
            layers.extend((nn.Conv2d(channels,width,3,padding=1,bias=False),
                           nn.BatchNorm2d(width),nn.ReLU(),nn.MaxPool2d(2)))
            channels = width
        self.features = nn.Sequential(*layers, nn.AdaptiveAvgPool2d((4,4)))
        self.classifier = nn.Sequential(nn.Flatten(),nn.Dropout(.25),nn.Linear(48*4*4,classes))

    def forward(self, images):
        return self.classifier(self.features(images))


def rasterize(sample):
    """Preserve canvas aspect ratio and center the ink within a grayscale image."""
    canvas = sample["canvas"]
    size = np.asarray([canvas["width"], canvas["height"]], dtype=float)
    if not np.isfinite(size).all() or np.any(size <= 0):
        raise ValueError("Invalid canvas dimensions.")
    strokes = []
    for stroke in sample["strokes"]:
        normalized = np.asarray(stroke["points"], dtype=float)
        if normalized.ndim != 2 or normalized.shape[1] != 2 or not len(normalized):
            raise ValueError("A stroke must contain x/y point pairs.")
        if not np.isfinite(normalized).all() or np.any((normalized < 0) | (normalized > 1)):
            raise ValueError("Stroke coordinates must be in the range 0–1.")
        strokes.append(normalized * size)
    if not strokes:
        raise ValueError("An empty sketch cannot be used.")
    points = np.concatenate(strokes)
    low, high = points.min(axis=0), points.max(axis=0)
    extent = (high - low).max()
    if extent < 1:
        raise ValueError("The sketch contains no usable shape.")
    scale = (IMAGE_SIZE - 1 - 2*MARGIN) / extent
    center = (high + low)/2
    image = np.zeros((IMAGE_SIZE, IMAGE_SIZE), dtype=np.uint8)
    for path in strokes:
        pixels = np.rint((path - center)*scale + (IMAGE_SIZE - 1)/2).astype(np.int32)
        if len(pixels) == 1:
            cv2.circle(image, tuple(pixels[0]), 1, 255, -1, cv2.LINE_AA)
        else:
            cv2.polylines(image, [pixels], False, 255, 2, cv2.LINE_AA)
    return image
