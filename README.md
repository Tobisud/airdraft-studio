# AirDraft Studio

A static browser app that turns fingertip drawings into 3D geometry. Serve the `dist` directory on HTTPS or run `python3 -m http.server 8000 --directory dist` and open `http://localhost:8000`. The pinned Three.js and MediaPipe assets are downloaded from public CDNs. Video frames are processed locally.

## Try it

1. Select a model type and choose **Load example**, or clear the canvas and make your own sketch.
2. For webcam input, enable the camera, show one hand, and pinch your index finger to your thumb to draw. Release to lift the pen. Mouse and touch work without a camera.
3. Generate the model, drag to orbit, and export an OBJ for Blender or another model editor.

## Pipeline options

| Pipeline | Steps | Public model or data |
| --- | --- | --- |
| Direct geometry (implemented) | MediaPipe `VIDEO` landmarks → index fingertip (8) and thumb tip (4) → smoothed, mirrored coordinates and palm-relative pinch hysteresis → 2D stroke paths → rounded stroke volumes blended into a clay figure, or a fitted gable extruded with fixed proportional depth. | [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js) |
| Classify and fit a template | Render normalized strokes to raster input → fine-tune a MobileNetV3 classifier on target sketch classes, including unknown inputs → fit joints or roof corners to a parameterized template → add depth constraints and generate a mesh. Collect custom examples for classes or drawing styles missing from the public dataset. | [Quick, Draw!](https://quickdraw.withgoogle.com/data), [MobileNetV3 ImageNet weights](https://huggingface.co/timm/mobilenetv3_small_100.lamb_in1k) |
| Generate a reference and reconstruct | Condition Stable Diffusion 1.5 with ControlNet Scribble using the sketch and an object prompt → render one centered object with a clean background → remove background → run TripoSR on a GPU → inspect and export the predicted mesh. | [ControlNet Scribble](https://huggingface.co/lllyasviel/control_v11p_sd15_scribble), [TripoSR weights](https://huggingface.co/stabilityai/TripoSR) |

Stick figure mode loads the bundled StickMan rig and poses its arms and legs from detected sketch joints. If the default model cannot load, the browser can still build the procedural clay figure. The house uses the outline's bounds and roof peak to fit a solid with inferred depth. It does not model doors or windows. The alternative pipelines are implementation designs. For evaluation, record average frame time, pinch start/stop accuracy, and output fit across held-out sketches and lighting conditions.

## Collect labeled sketches

Open `collect.html` on the HTTPS site or a localhost preview. Allow camera access, move your index fingertip with your fingers apart to aim, then pinch your thumb and index finger to draw. Release to move between strokes. Mouse, pen, and touch are also supported.

Choose the drawing's label and save it before starting the next sketch. Export the dataset as JSON. Each record contains a label, canvas dimensions, and ordered strokes with normalized coordinates and an input source. To rasterize at the original aspect ratio, multiply x by the saved canvas width and y by the saved height before fitting the bounding box into the training raster. The anonymous session ID helps group related sketches for splitting. Use different browser sessions for different drawers and keep each drawer's sessions together when evaluating. Camera frames are processed locally and are never saved in the dataset.
