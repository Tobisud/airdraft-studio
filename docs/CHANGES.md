# AirDraft update: fish, bird, tree and flower models

Copy these files into the site's `dist` folder, keeping the folder layout. Nothing else needs to change.

| File | New or changed | What |
|---|---|---|
| `template-fit.js` | new | Measures the sketch and fits the fish, bird, tree and flower templates |
| `assets/fish.glb`, `bird.glb`, `tree.glb`, `flower.glb` | new | The four templates (rounded matte white, named parts, 60–140 kB each) |
| `app.js` | changed | Four new modes, an example sketch for each, template loading, fitting on Generate 3D |
| `index.html` | changed | Fish, Bird, Tree and Flower added to the model dropdown |
| `drawing.js` | changed | Smoother camera drawing (pen between thumb and index, One Euro filter, 0.1 s grace before a stroke ends). Independent of the models; skip it if you only want the models |

`changes.diff` shows every line changed in `app.js`, `index.html` and `drawing.js`.
`FITTING.md` explains each template's parts and which sketch measurement drives them.

## How each model follows the sketch

- **Fish:** finds the waist (narrowest point) between body and tail, so a fish drawn in one stroke works too;
  the shorter side is the tail. Body length/height and tail size come from either side of the waist. Faces left or right
  depending on the tail side (turned around, not mirrored, so OBJ export stays correct).
- **Bird:** for each wing, the main stroke on that side gives a shoulder, elbow and tip, which set the inner and outer wing angles;
  stray marks are ignored; the whole bird is scaled to the sketch's wingspan.
- **Tree:** crown width and height from the top stroke(s); trunk height from the strokes below and trunk width measured halfway up;
  the crown follows the trunk top.
  With no trunk drawn, it uses a standard trunk and the status says to draw one.
- **Flower:** stem height from the most vertical stroke; petal count (3–8) and petal directions from separate petal loops, or from bumps
  in the bloom's outline if drawn as one stroke; bloom size from how far the petals reach; up to two leaves where they meet the stem.
  Unused petals and leaves are removed (not hidden), because the OBJ exporter also exports hidden meshes.

## Tested

- In headless Chrome with three.js 0.169: every mode's example (all six), mouse-drawn sketches, and OBJ export. No page errors.
- Fitted on 36 sketches (the 4 examples plus 32 messy generated ones with dropped strokes, stray marks and tilt).
  `fit_check_generated.png` shows each model's front view with its sketch on top: fish 9/9, tree 8/8, flower 8/8 with matching
  petal directions, bird 8/9 (the miss is a sketch with one wing stroke missing). Two generated sketches were
  deliberately mislabeled (a bird labeled tree, a house labeled flower): the fitter trusts the chosen type and still
  builds a tree or flower, so a wrong type must be caught by the classifier and its confidence threshold.

- On 91 real sketches drawn on the website (Santiago's first set): fish 15/15 facing the right way, bird 15/15 and
  tree 16/16 fitted, flowers with matching petal counts and directions. `fit_check_real.png` shows them.
  Trunks drawn spreading out toward the ground become a wide cone, which follows the drawn lines.

## Not changed

- Mode selection is still manual. When the classifier is ready, set `mode.value` from its prediction before calling `generate()`.
- The Python desktop app still only builds the stick figure and house.
