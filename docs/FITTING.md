# Fish, bird, tree and flower templates

Four GLB templates for the classes that don't have a 3D model yet. We made them ourselves in code
(`build_models.py`), so there's no license to credit. Each file passes the Khronos glTF validator with
0 errors and loads in three.js 0.169 (the version the app uses).

`preview.png` shows each model from the front and at an angle. `pose_test.png` shows parts being moved the way the app would move them.

## Conventions (same as `house-default.glb`)

- **Y is up, the front faces +Z** (toward the camera), so the front view matches the sketch.
- Units are about the size of the house (3–5 units across). Tree and flower stand on the ground at y = 0. Fish and bird are centered on the origin.
- One matte white material (`Matte clay`, roughness 0.82). The app can replace it, as it does for the house.
- No textures, no external files, no skeleton.
- **Every part is its own named node, and its origin sits at the joint it turns or stretches around.**
  So setting a node's `rotation.z` or `scale` moves the part naturally. Get parts with `gltf.scene.getObjectByName('Crown')`.

**Important:** don't load these with `makeTemplateHouse()`. That function bakes every node's transform into
the geometry, which removes the part nodes. Keep the loaded scene graph as it is and change the nodes.

**Easiest first version:** scale the whole model to the sketch's bounding box, exactly as the house does now.
That works right away. Then add the per-part fitting below, one class at a time.

Sketch measurements below are in the same units as the model after `generate()` scales the sketch, with y pointing up.

## Fish (`fish.glb`): side view, head toward −X (left)

| Part | Origin (joint) | Rest size | Fit from the sketch |
|---|---|---|---|
| `Body` | body center (0, 0, 0) | length 2.55 (x −1.15…1.40), height 1.28 | `scale.x = bodyLength / 2.55`, `scale.y = bodyHeight / 1.28` (body = the largest closed stroke) |
| `Tail` | where tail meets body (1.15, 0, 0) | 1.05 long, 1.43 tall | `position.x = 1.15 * Body.scale.x`; `scale.set(s, s, 1)` with `s = tailHeight / 1.43` |
| `TopFin` | top of body (0.05, 0.58, 0) | 1.0 × 0.64 | `position.set(0.05 * Body.scale.x, 0.58 * Body.scale.y, 0)` |
| `EyeFront`, `EyeBack` | (−0.72, 0.16, ±0.33) | small balls | `position.x = -0.72 * Body.scale.x`, `position.y = 0.16 * Body.scale.y` |

**Facing:** if the tail is on the sketch's left, turn the whole fish around with `fish.rotation.y = Math.PI`.
Don't mirror with a negative scale: that turns faces inside out in the exported OBJ.

## Bird (`bird.glb`): flying, seen from the front, head toward the camera

| Part | Origin (joint) | Rest pose | Fit from the sketch |
|---|---|---|---|
| `Body` | (0, 0, 0) | | none needed |
| `Beak`, `Tail` | front of head / back of body | | none needed |
| `WingL_Inner`, `WingR_Inner` | shoulder (∓0.36, 0.12, 0.05) | raised 25°; length 1.02 to the elbow | `rotation.z` from the shoulder→elbow angle (below) |
| `WingL_Outer`, `WingR_Outer` | elbow; **child of the inner wing** | bent 45° down; 1.24 long | `rotation.z` from the elbow→tip angle (below) |

For each wing stroke: **S** = the end nearest the body, **T** = the far tip, **E** = the elbow (the point
farthest from the straight line S–T; for an "M" bird it's the top of the arc).

```js
const angle = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));           // keep within -180°..180°
const a1 = angle(S, E), a2 = angle(E, T);
// Right wing: rest direction is +X (0). Left wing: rest direction is -X (PI).
inner.rotation.z = wrap(side === 'R' ? a1 : a1 - Math.PI);
outer.rotation.z = wrap(a2 - a1);                                  // relative to the inner wing
```

Only rotate the wings and scale the whole bird to the sketch width. Don't stretch an inner wing on just one axis:
the outer wing is its child, so it would come out skewed.

## Tree (`tree.glb`)

| Part | Origin (joint) | Rest size | Fit from the sketch |
|---|---|---|---|
| `Trunk` | ground center (0, 0, 0) | about 0.45 wide (middle), crown sits at y = 1.4 | `scale.set(w, h, w)` with `w = trunkWidth / 0.45`, `h = trunkHeight / 1.4` |
| `Crown` | its bottom-center, rest at (0, 1.4, 0) | 2.86 wide, 2.35 tall | `position.y = 1.4 * Trunk.scale.y`; `scale.set(cw, ch, cw)` with `cw = crownWidth / 2.86`, `ch = crownHeight / 2.35` |

Crown = the top stroke(s), usually a closed or cloud-like loop. Trunk = the strokes below it.
`trunkHeight` = ground (lowest sketch point) to the bottom of the crown. `trunkWidth` = the gap between the two trunk lines.

## Flower (`flower.glb`)

| Part | Origin (joint) | Rest size | Fit from the sketch |
|---|---|---|---|
| `Stem` | ground (0, 0, 0) | reaches the bloom at y = 2.4 | `scale.y = bloomCenterHeight / 2.4` |
| `Head` (empty group) | bloom center (0, 2.4, 0) | bloom 1.84 across | `position.y = bloomCenterHeight`; `scale.setScalar(bloomWidth / 1.84)` |
| `Center` | child of `Head` | 0.64 across | none needed |
| `Petal_1` … `Petal_8` | children of `Head`, origin at the bloom center, each points along its angle | 8 petals, 45° apart | show N petals (count the petal loops, 3–8): `Petal_i.visible = i <= N`, `Petal_i.rotation.z = Math.PI / 2 + (i - 1) * 2 * Math.PI / N` |
| `LeafL`, `LeafR` | where each joins the stem (y = 0.75 and 1.2) | | show only if the sketch has leaves; `position.y = leafHeight` |

## Where the numbers come from

`build_models.py` builds each part from smooth blended shapes (the same "clay" idea as `clay-figure.js`)
and meshes it with marching cubes. Change a shape there and run `python build_models.py` to rebuild all four files.
It needs `numpy`, `scikit-image`, `trimesh`, `scipy` and `fast-simplification`.
