// Fit the fish, bird, tree and flower templates to a sketch.
// Each template part's origin sits at its joint (see FITTING.md), so fitting means
// measuring the sketch and setting each part's position, rotation and scale.
// `paths` are strokes of THREE.Vector3 in model units: x to the right, y up.
import * as THREE from 'three';

const boxOf = points => new THREE.Box3().setFromPoints(points);
const sizeOf = box => box.getSize(new THREE.Vector3());
const centerOf = box => box.getCenter(new THREE.Vector3());
const clamp = THREE.MathUtils.clamp;
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
const angleOf = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

function isClosed(path) {
  if (path.length < 5) return false;
  const size = sizeOf(boxOf(path));
  return path[0].distanceTo(path.at(-1)) < 0.35 * Math.max(size.x, size.y);
}

function strokeLength(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += path[i].distanceTo(path[i - 1]);
  return total;
}

// Short open strokes are most likely accidental marks; leave them out of measurements.
function withoutStrayMarks(paths) {
  const longest = Math.max(...paths.map(strokeLength));
  const kept = paths.filter(path => isClosed(path) || strokeLength(path) >= 0.25 * longest);
  return kept.length ? kept : paths;
}

function area(path) {
  const size = sizeOf(boxOf(path));
  return size.x * size.y;
}

// Copy the template so each fit gets its own nodes and geometry, all in one material.
function copyTemplate(template, name, material) {
  const model = template.clone(true);
  model.name = name;
  model.traverse(node => {
    if (node.isMesh) {
      node.geometry = node.geometry.clone();
      node.material = material;
    }
  });
  return model;
}

// The fish's waist: the narrowest point (top to bottom) between body and tail, away from the ends.
// Works for a fish drawn in one stroke (body and tail crossing) or with a separate tail.
function findWaist(paths) {
  const whole = boxOf(paths.flat());
  const width = sizeOf(whole).x;
  // Fill in points along each segment first: mouse strokes can have long straight stretches
  // with few recorded points, which would make some slices look falsely thin.
  const step = width / 200;
  const points = paths.flatMap(path => path.flatMap((p, i) => {
    if (i === 0) return [p];
    const count = Math.max(1, Math.ceil(p.distanceTo(path[i - 1]) / step));
    return Array.from({length: count}, (_, k) => path[i - 1].clone().lerp(p, (k + 1) / count));
  }));
  const bins = 24;
  const low = new Array(bins).fill(Infinity);
  const high = new Array(bins).fill(-Infinity);
  for (const p of points) {
    const i = Math.min(bins - 1, Math.floor(((p.x - whole.min.x) / Math.max(width, 1e-6)) * bins));
    low[i] = Math.min(low[i], p.y);
    high[i] = Math.max(high[i], p.y);
  }
  const thickness = high.map((h, i) => (h > low[i] ? h - low[i] : 0));
  let waist = -1;
  for (let i = Math.round(bins * 0.15); i < Math.round(bins * 0.85); i++) {
    if (thickness[i] > 0 && (waist < 0 || thickness[i] < thickness[waist])) waist = i;
  }
  if (waist < 0 || thickness[waist] > 0.6 * Math.max(...thickness)) return null;
  return whole.min.x + ((waist + 0.5) / bins) * width;
}

function fitFish(model, paths) {
  const points = paths.flat();
  const center = centerOf(boxOf(points)).x;
  const waist = findWaist(paths);
  let bodyPoints, tail, tailOnRight;
  if (waist !== null) {
    tailOnRight = waist > center; // the tail is the shorter side of the waist
    bodyPoints = points.filter(p => (tailOnRight ? p.x <= waist : p.x >= waist));
    tail = points.filter(p => (tailOnRight ? p.x > waist : p.x < waist));
  } else {
    // No clear waist: use the biggest closed stroke as the body and whatever sticks out as the tail.
    const loops = paths.filter(isClosed).sort((a, b) => area(b) - area(a));
    const box = boxOf(loops.length ? loops[0] : points);
    const margin = 0.03 * sizeOf(box).x;
    const left = points.filter(p => p.x < box.min.x - margin);
    const right = points.filter(p => p.x > box.max.x + margin);
    tailOnRight = right.length >= left.length;
    tail = tailOnRight ? right : left;
    bodyPoints = points.filter(p => box.containsPoint(p));
  }
  const bodySize = sizeOf(boxOf(bodyPoints));
  const tailHeight = tail.length > 1 ? sizeOf(boxOf(tail)).y : bodySize.y * 1.12;

  const sx = Math.max(bodySize.x, 0.2) / 2.55;
  const sy = clamp(bodySize.y / 1.28, 0.3 * sx, 2.5 * sx);
  const get = name => model.getObjectByName(name);
  get('Body').scale.set(sx, sy, sy);
  const t = clamp(tailHeight / 1.43, 0.35 * sy, 2.2 * sy);
  get('Tail').position.x = 1.15 * sx;
  get('Tail').scale.set(t, t, 1);
  const fin = Math.min(sx, sy);
  get('TopFin').position.set(0.05 * sx, 0.58 * sy, 0);
  get('TopFin').scale.set(fin, fin, 1);
  for (const [name, side] of [['EyeFront', 1], ['EyeBack', -1]]) {
    get(name).position.set(-0.72 * sx, 0.16 * sy, side * 0.33 * sy);
    get(name).scale.setScalar(fin);
  }
  // The template faces left. Turn it around (not mirror) when the tail is on the left.
  if (!tailOnRight) model.rotation.y = Math.PI;
  return `Fish · facing ${tailOnRight ? 'left' : 'right'}`;
}

function fitBird(model, sketch) {
  const paths = withoutStrayMarks(sketch);
  const all = boxOf(paths.flat());
  const allSize = sizeOf(all);
  // A small closed stroke near the middle is the body; it is not part of either wing.
  const body = paths.filter(isClosed).find(path => {
    const box = boxOf(path);
    return box.min.x < centerOf(all).x && box.max.x > centerOf(all).x && sizeOf(box).x < 0.35 * allSize.x;
  });
  const middle = body ? centerOf(boxOf(body)).x : centerOf(all).x;
  const wingStrokes = paths.filter(path => path !== body);
  const fitted = [];
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    // Use only the main stroke on this side (the most drawn length there), so separate stray marks
    // don't bend the wing. An "M" drawn in one stroke still works: its half on this side is used.
    const onSide = path => path.filter(p => sign * (p.x - middle) > 0);
    const main = wingStrokes.map(onSide).sort((a, b) => strokeLength(b) - strokeLength(a))[0] ?? [];
    const points = main;
    if (points.length < 2) continue;
    const shoulder = points.reduce((a, b) => Math.abs(b.x - middle) < Math.abs(a.x - middle) ? b : a);
    const tip = points.reduce((a, b) => Math.abs(b.x - middle) > Math.abs(a.x - middle) ? b : a);
    const line = new THREE.Line3(shoulder, tip);
    const distance = p => line.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p);
    let elbow = points.reduce((a, b) => distance(b) > distance(a) ? b : a);
    if (distance(elbow) < 0.06 * shoulder.distanceTo(tip)) elbow = line.getCenter(new THREE.Vector3());
    const inner = angleOf(shoulder, elbow);
    model.getObjectByName(`Wing${side}_Inner`).rotation.z = wrap(sign > 0 ? inner : inner - Math.PI);
    model.getObjectByName(`Wing${side}_Outer`).rotation.z = wrap(angleOf(elbow, tip) - inner);
    fitted.push(side);
  }
  // Match the wingspan: scale the whole bird so its front-view width equals the sketch's.
  model.updateMatrixWorld(true);
  const width = sizeOf(new THREE.Box3().setFromObject(model)).x;
  model.scale.setScalar(clamp(allSize.x / width, 0.2, 5));
  return fitted.length === 2 ? 'Bird · wings fitted' : 'Bird · draw one stroke per wing for a better fit';
}

function fitTree(model, paths) {
  const points = paths.flat();
  const whole = boxOf(points);
  const ground = whole.min.y;
  const height = sizeOf(whole).y;
  // Crown: the biggest stroke in the upper part, plus other strokes inside its box (cloud drawn in pieces).
  const upper = paths.filter(path => centerOf(boxOf(path)).y > ground + 0.4 * height).sort((a, b) => area(b) - area(a));
  let crown;
  let crownStrokes = [];
  if (upper.length) {
    crown = boxOf(upper[0]);
    crownStrokes = paths.filter(path => {
      const c = centerOf(boxOf(path));
      return path === upper[0] || (crown.containsPoint(c) && c.y > crown.min.y + 0.2 * sizeOf(crown).y);
    });
    crown = boxOf(crownStrokes.flat());
  } else {
    crown = new THREE.Box3(new THREE.Vector3(whole.min.x, ground + 0.4 * height, 0), whole.max.clone());
  }
  const crownSize = sizeOf(crown);
  const trunkPoints = paths.filter(path => !crownStrokes.includes(path)).flat()
    .filter(p => p.y < crown.min.y + 0.25 * crownSize.y);
  const hasTrunk = trunkPoints.length > 1 && crown.min.y - ground > 0.12 * height;
  const trunkHeight = hasTrunk ? crown.min.y - ground : 0.6 * crownSize.y;
  const trunkBox = trunkPoints.length > 1 ? boxOf(trunkPoints) : null;
  // Measure the trunk's width halfway up, so roots spreading at the bottom or branches at the top don't count.
  const midway = trunkPoints.filter(p => p.y > ground + 0.35 * (crown.min.y - ground) && p.y < ground + 0.65 * (crown.min.y - ground));
  const measured = midway.length > 1 ? sizeOf(boxOf(midway)).x : trunkBox ? sizeOf(trunkBox).x : 0.16 * crownSize.x;
  const trunkWidth = clamp(measured, 0.08 * crownSize.x, 0.6 * crownSize.x);
  const trunkX = trunkBox ? centerOf(trunkBox).x : centerOf(crown).x;

  const w = trunkWidth / 0.45;
  const h = trunkHeight / 1.4;
  model.getObjectByName('Trunk').scale.set(w, h, w);
  const crownNode = model.getObjectByName('Crown');
  crownNode.position.set(centerOf(crown).x - trunkX, 1.4 * h, 0);
  crownNode.scale.set(crownSize.x / 2.86, crownSize.y / 2.35, crownSize.x / 2.86);
  if (!upper.length) return 'Tree · draw a crown on top for a better fit';
  return hasTrunk ? 'Tree · trunk and crown fitted' : 'Tree · draw a trunk below the crown for a better fit';
}

function countPetals(points, center, radius) {
  // Petals show up as bumps in the bloom's outline: for each direction around the center,
  // take the farthest point, then count the peaks of that profile.
  const bins = 48;
  const reach = new Array(bins).fill(0);
  for (const p of points) {
    const r = Math.hypot(p.x - center.x, p.y - center.y);
    const bin = Math.floor(((Math.atan2(p.y - center.y, p.x - center.x) + Math.PI) / (2 * Math.PI)) * bins) % bins;
    reach[bin] = Math.max(reach[bin], r);
  }
  const filled = reach.filter(r => r > 0).length;
  if (filled < bins * 0.6) return null;
  const smooth = reach.map((_, i) => (reach.at(i - 1) + 2 * reach[i] + reach[(i + 1) % bins]) / 4);
  const typical = [...smooth].sort((a, b) => a - b)[bins >> 1];
  const angles = [];
  for (let i = 0; i < bins; i++) {
    const around = [-2, -1, 1, 2].map(k => smooth[(i + k + bins) % bins]);
    if (smooth[i] > Math.max(...around) && smooth[i] > typical * 0.85 && smooth[i] > 0.25 * radius) {
      angles.push(((i + 0.5) / bins) * 2 * Math.PI - Math.PI);
    }
  }
  return angles.length >= 3 ? angles : null;
}

function fitFlower(model, paths) {
  const points = paths.flat();
  const whole = boxOf(points);
  const ground = whole.min.y;
  const height = sizeOf(whole).y;
  // Stem: the most vertical stroke that reaches near the ground.
  const verticalness = path => {
    const size = sizeOf(boxOf(path));
    return size.y - 2 * size.x;
  };
  const stem = paths.filter(path => sizeOf(boxOf(path)).y > 0.3 * height && boxOf(path).min.y < ground + 0.2 * height)
    .sort((a, b) => verticalness(b) - verticalness(a))[0];
  const stemTop = stem ? boxOf(stem).max.y : ground + 0.6 * height;
  const stemX = stem ? stem.reduce((a, b) => b.y > a.y ? b : a).x : centerOf(whole).x;
  const others = paths.filter(path => path !== stem);
  // A stroke that meets the stem below its top 20% is a leaf; strokes at the top of the stem form the bloom.
  const meetsStemAt = path => {
    let best = Infinity, height = stemTop;
    for (const p of path) for (const q of stem) {
      const d = p.distanceToSquared(q);
      if (d < best) [best, height] = [d, q.y];
    }
    return (height - ground) / Math.max(stemTop - ground, 1e-6);
  };
  const headStrokes = stem
    ? others.filter(path => meetsStemAt(path) >= 0.8)
    : others.filter(path => centerOf(boxOf(path)).y > ground + 0.6 * (stemTop - ground));
  const leaves = others.filter(path => !headStrokes.includes(path));
  const headPoints = headStrokes.length ? headStrokes.flat() : points.filter(p => p.y > ground + 0.6 * height);
  const head = boxOf(headPoints);
  let headCenter = centerOf(head);
  const loops = headStrokes.filter(isClosed);
  const centerLoop = loops.filter(path => boxOf(path).containsPoint(headCenter)).sort((a, b) => area(a) - area(b))[0];
  if (centerLoop) headCenter = centerOf(boxOf(centerLoop));
  // Bloom size from how far the petal tips reach (90th percentile, so one stray point doesn't count).
  const reach = headPoints.map(p => Math.hypot(p.x - headCenter.x, p.y - headCenter.y)).sort((a, b) => a - b);
  const tipReach = Math.max(reach[Math.floor(0.9 * (reach.length - 1))] ?? 0, 0.05 * height);

  // Petals: separate petal loops if drawn that way, otherwise bumps in the outline.
  // Their directions set the count and which way the petals point.
  const petalLoops = loops.filter(path => path !== centerLoop);
  let directions = petalLoops.length >= 3
    ? petalLoops.map(path => { const c = centerOf(boxOf(path)); return Math.atan2(c.y - headCenter.y, c.x - headCenter.x); })
    : countPetals(headPoints, headCenter, tipReach);
  const petals = clamp(directions?.length ?? 6, 3, 8);
  // Average the directions modulo the petal spacing to get the angle of the first petal.
  const phase = directions
    ? Math.atan2(directions.reduce((a, d) => a + Math.sin(petals * d), 0), directions.reduce((a, d) => a + Math.cos(petals * d), 0)) / petals
    : Math.PI / 2;

  const stemHeight = Math.max(headCenter.y - ground, 0.2 * height);
  const headScale = tipReach / 0.92; // petal tips reach 0.92 from the bloom center in the template
  const thickness = clamp(headScale, 0.6, 1.6);
  model.getObjectByName('Stem').scale.set(thickness, stemHeight / 2.4, thickness);
  const headNode = model.getObjectByName('Head');
  headNode.position.set(0, stemHeight, 0);
  headNode.scale.setScalar(headScale);
  for (let i = 0; i < 8; i++) {
    const petal = model.getObjectByName(`Petal_${i + 1}`);
    if (i < petals) petal.rotation.z = phase + (i * 2 * Math.PI) / petals;
    else petal.removeFromParent(); // removed, not hidden: the OBJ exporter also exports hidden meshes
  }
  // Leaves: at most one per side, at the height where the drawn leaf meets the stem.
  for (const [name, sign] of [['LeafL', -1], ['LeafR', 1]]) {
    const node = model.getObjectByName(name);
    const leaf = leaves.find(path => sign * (centerOf(boxOf(path)).x - stemX) > 0);
    if (!leaf) {
      node.removeFromParent();
      continue;
    }
    const joint = leaf.reduce((a, b) => Math.abs(b.x - stemX) < Math.abs(a.x - stemX) ? b : a);
    node.position.set(0.03 * -sign, clamp(joint.y - ground, 0.1 * stemHeight, 0.9 * stemHeight), 0);
    node.scale.setScalar(clamp(sizeOf(boxOf(leaf)).x / 0.84, 0.4 * thickness, 2.5 * thickness));
  }
  const leafCount = Math.min(leaves.length, 2);
  return `Flower · ${petals} petals${leafCount ? ` · ${leafCount} ${leafCount > 1 ? 'leaves' : 'leaf'}` : ''}`;
}

const FITTERS = {fish: fitFish, bird: fitBird, tree: fitTree, flower: fitFlower};
export const TEMPLATE_KINDS = Object.keys(FITTERS);

export function fitTemplate(kind, template, paths, material) {
  const model = copyTemplate(template, 'AirDraft_' + kind[0].toUpperCase() + kind.slice(1), material);
  const label = FITTERS[kind](model, paths);
  return {model, label};
}
