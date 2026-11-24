# AirDraft Studio for Python

Python desktop version of AirDraft Studio. OpenCV captures the webcam and renders a rotatable 3D preview. MediaPipe Hands detects the index finger and thumb. Tkinter provides the desktop controls. Camera processing runs locally.

## Run it

Use Python 3.10–3.12 with Tkinter. Most Windows and macOS Python installations include it. On Debian or Ubuntu, install your distribution's `python3-tk` package if importing `tkinter` fails.

From the repository root:

```sh
python -m venv .venv
```

Activate the environment with `source .venv/bin/activate` on macOS or Linux, or `.venv\Scripts\Activate.ps1` in Windows PowerShell. Then run:

```sh
python -m pip install -r python/requirements.txt
python python/airdraft.py
```

Try `python python/airdraft.py --camera 1` if your webcam uses a different camera index. Use `--data path/to/sketches.json` to choose your local dataset file. The default is `~/.airdraft/sketches.json`.

## Drawing and 3D

- Select **Enable camera** and move your fingertip with your thumb apart to aim. Pinch to draw or erase, and release to hover. Mouse drawing also works.
- Select **Stick figure** or **House**, then **Generate 3D**. A closed head, central body line, two arms, and two legs work best for stick figures. Drag the preview to orbit or select **Export OBJ** to save the geometry.
- The Python version uses the same house and stickman GLBs as the website. House proportions come from the sketch bounds. Stick figure pose comes from geometric landmark fitting. This version uses manual mode selection during generation.

## Collect and review sketches

Choose a label and select **Save sketch**. **Export JSON** writes the same format as the website's collector. Open a browser or desktop export through **Review JSON**, correct its labels, then approve or exclude drawings and export the approved set. Camera video is never saved.
