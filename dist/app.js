import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

import {createDrawing, clamp} from './drawing.js';
import {buildClayFigure, recognizeFigure} from './clay-figure.js';
import {fitTemplate, TEMPLATE_KINDS} from './template-fit.js';

const byId = id => document.getElementById(id);
const canvas = byId('sketch');
const viewer = byId('viewer');
const mode = byId('mode');
const status = byId('model-status');
const drawing = createDrawing((count, canUndo) => {
  byId('undo').disabled = !canUndo;
  byId('clear').disabled = count === 0;
});

const examples = {
  tubes: [
    Array.from({length: 41}, (_, i) => [
      .5 + .08 * Math.sin(i * Math.PI / 20),
      .245 + .08 * Math.cos(i * Math.PI / 20)
    ]),
    [[.5,.325],[.5,.62]],
    [[.222,.391],[.36,.382],[.5,.377],[.64,.382],[.778,.391]],
    [[.425,.825],[.446,.70],[.5,.62],[.554,.70],[.575,.825]]
  ],
  house: [
    [[.29,.46],[.5,.23],[.71,.46],[.71,.77],[.29,.77],[.29,.46]]
  ]
};
// Example sketches for the template classes. Shapes are in canvas-height units; x offsets are
// divided by the canvas aspect ratio so circles stay round on a wide canvas.
function templateExample(kind, aspect) {
  const at = (cx, cy) => ([dx, dy]) => [cx + dx / aspect, cy + dy];
  const loop = (cx, cy, rx, ry, {turn = 0, wobble = 0, bumps = 0, n = 36} = {}) =>
    Array.from({length: n + 1}, (_, i) => {
      const a = i / n * 2 * Math.PI;
      const r = 1 + wobble * Math.cos(bumps * a);
      const x = rx * r * Math.cos(a), y = ry * r * Math.sin(a);
      return at(cx, cy)([x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)]);
    });
  const line = (cx, cy, points) => points.map(at(cx, cy));
  if (kind === 'fish') return [
    loop(.46, .5, .2, .12),
    line(.46, .5, [[.19, 0], [.33, -.11], [.29, 0], [.33, .11], [.19, 0]]),
    line(.46, .5, [[-.06, -.115], [0, -.19], [.08, -.11]])
  ];
  if (kind === 'bird') {
    const wing = [[-.02, .03], [-.06, -.03], [-.11, -.08], [-.16, -.09], [-.21, -.05], [-.26, .0], [-.32, .04]];
    return [line(.5, .48, wing), line(.5, .48, wing.map(([x, y]) => [-x, y]))];
  }
  if (kind === 'tree') return [
    loop(.5, .35, .2, .17, {wobble: .07, bumps: 7, n: 60}),
    line(.5, .35, [[-.04, .16], [-.045, .3], [-.055, .45]]),
    line(.5, .35, [[.04, .16], [.045, .3], [.055, .45]])
  ];
  if (kind === 'flower') return [
    loop(.5, .27, .035, .035),
    ...Array.from({length: 6}, (_, i) => {
      const a = i / 6 * 2 * Math.PI;
      return loop(.5 + .085 * Math.cos(a) / aspect, .27 + .085 * Math.sin(a), .05, .028, {turn: a});
    }),
    line(.5, .36, [[0, 0], [-.01, .15], [.005, .3], [0, .48]]),
    line(.5, .62, [[0, 0], [-.04, -.04], [-.1, -.05], [-.05, -.005], [0, 0]]),
    line(.5, .52, [[0, 0], [.04, -.04], [.1, -.05], [.05, -.005], [0, 0]])
  ];
}

const scene = new THREE.Scene();
const view = new THREE.PerspectiveCamera(39, 1, .01, 100);
const grid = new THREE.GridHelper(12, 24, 0x61567f, 0x3a3551);
scene.add(grid);
scene.add(new THREE.HemisphereLight(0xe5ddff, 0x635479, 2.0));
const key = new THREE.DirectionalLight(0xf7f3ff, 2.4);
key.position.set(4,7,5);
scene.add(key);
let renderer;
let controls;
try {
  renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  viewer.prepend(renderer.domElement);
  controls = new OrbitControls(view, renderer.domElement);
  controls.enableDamping = true;
  new ResizeObserver(() => {
    view.aspect = viewer.clientWidth / viewer.clientHeight;
    view.updateProjectionMatrix();
    renderer.setSize(viewer.clientWidth, viewer.clientHeight, false);
  }).observe(viewer);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, view);
  });
} catch (error) {
  console.warn('WebGL preview unavailable', error);
}

const clay = new THREE.MeshStandardMaterial({color:0xfafafa,roughness:.82});
const houseGray = new THREE.MeshStandardMaterial({color:0xb8b8b8,roughness:.82});
let houseTemplate = null;
let houseLoading = null;
let model = null;
let defaultRig = null;
let poseRig = null;
let lastFigurePaths = null;
const templates = {};
const templateLoading = {};
let lastTemplatePaths = null;

function buildHouse(points, group, width, height) {
  const peak = points.reduce((highest,p) => p.y > highest.y ? p : highest);
  const edge = points.filter(p => Math.abs(p.x) > width * .40);
  const eave = clamp(edge.reduce((highest,p) => Math.max(highest,p.y), -height/2), -height*.15, height*.32);
  const corners = [
    new THREE.Vector2(-width/2, -height/2),
    new THREE.Vector2(width/2, -height/2),
    new THREE.Vector2(width/2, eave),
    new THREE.Vector2(clamp(peak.x,-width*.36,width*.36), height/2),
    new THREE.Vector2(-width/2, eave)
  ];
  const radius = Math.min(width,height) * .044;
  const shape = new THREE.Shape();
  corners.forEach((corner,i) => {
    const previous = corners.at(i-1);
    const next = corners[(i+1)%corners.length];
    const inset = toward => corner.clone().lerp(toward, Math.min(.25,radius/corner.distanceTo(toward)));
    const from = inset(previous);
    const to = inset(next);
    if (i === 0) shape.moveTo(from.x,from.y);
    else shape.lineTo(from.x,from.y);
    shape.quadraticCurveTo(corner.x,corner.y,to.x,to.y);
  });
  shape.closePath();
  const depth = width * .65;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled:true, bevelThickness:radius*.42,
    bevelSize:radius*.34, bevelSegments:6, curveSegments:8
  });
  geometry.translate(0,0,-depth/2);
  group.add(new THREE.Mesh(geometry,houseGray));
}

function makeTemplateHouse(template, width, height) {
  const house = new THREE.Group();
  house.name = 'AirDraft_House';
  const center = template.bounds.getCenter(new THREE.Vector3());
  const size = template.bounds.getSize(new THREE.Vector3());
  const depth = width * size.z/size.x;
  house.scale.set(width/size.x,height/size.y,depth/size.z);
  template.scene.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    geometry.translate(-center.x,-center.y,-center.z);
    const mesh = new THREE.Mesh(geometry,houseGray);
    mesh.name = node.name;
    house.add(mesh);
  });
  return house;
}

function loadHouseTemplate() {
  if (!houseLoading) {
    houseLoading = import('three/addons/loaders/GLTFLoader.js')
      .then(async ({GLTFLoader}) => {
        const {scene} = await new GLTFLoader().loadAsync('./assets/house-default.glb');
        scene.updateMatrixWorld(true);
        houseTemplate = {scene,bounds:new THREE.Box3().setFromObject(scene)};
        return houseTemplate;
      })
      .catch(error => {
        console.warn('House template unavailable',error);
        return null;
      })
      .finally(() => { houseLoading = null; });
  }
  return houseLoading;
}

function renderHouse(paths, width, height, label) {
  if (houseTemplate) {
    showModel(makeTemplateHouse(houseTemplate,width,height),label,false);
    return;
  }
  const fallback = new THREE.Group();
  fallback.name = 'AirDraft_House';
  buildHouse(paths.flat(),fallback,width,height);
  showModel(fallback,'Loading house template…',false);
  loadHouseTemplate().then(template => {
    if (model !== fallback || mode.value !== 'house') return;
    if (template) showModel(makeTemplateHouse(template,width,height),label,false);
    else status.textContent = 'House template unavailable · simple preview';
  });
}

function loadTemplate(kind) {
  templateLoading[kind] ??= import('three/addons/loaders/GLTFLoader.js')
    .then(({GLTFLoader}) => new GLTFLoader().loadAsync(`./assets/${kind}.glb`))
    .then(({scene}) => (templates[kind] = scene))
    .catch(error => {
      console.warn(`${kind} template unavailable`, error);
      delete templateLoading[kind];
      return null;
    });
  return templateLoading[kind];
}

function renderTemplate(kind, paths) {
  lastTemplatePaths = paths;
  const show = template => {
    const {model: fitted, label} = fitTemplate(kind, template, paths, clay);
    showModel(fitted, label, true);
  };
  if (templates[kind]) {
    show(templates[kind]);
    return;
  }
  status.textContent = `Loading ${kind} template…`;
  loadTemplate(kind).then(template => {
    if (mode.value !== kind || lastTemplatePaths !== paths) return;
    if (template) show(template);
    else status.textContent = `${kind[0].toUpperCase() + kind.slice(1)} template unavailable`;
  });
}

function generate(label) {
  const strokes = drawing.strokes;
  const points = strokes.flat();
  if (!points.length) { status.textContent = 'Draw or load an example first'; return; }
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const bounds = points.reduce((box,[x,y]) => ({
    left:Math.min(box.left,x), right:Math.max(box.right,x),
    top:Math.min(box.top,y), bottom:Math.max(box.bottom,y)
  }), {left:1,right:0,top:1,bottom:0});
  const width = (bounds.right-bounds.left)*aspect;
  const height = bounds.bottom-bounds.top;
  if (mode.value === 'house' && (width < .06 || height < .06)) {
    status.textContent = 'Draw a wider and taller house outline';
    return;
  }
  const scale = 3.8 / Math.max(width,height,.06);
  const paths = strokes.map(path => path.map(([x,y]) => new THREE.Vector3(
    (x-(bounds.right+bounds.left)/2)*aspect*scale,
    ((bounds.top+bounds.bottom)/2-y)*scale,
    0
  )));
  if (mode.value === 'house') {
    lastFigurePaths = null;
    renderHouse(paths,width*scale,height*scale,label);
  } else if (TEMPLATE_KINDS.includes(mode.value)) {
    lastFigurePaths = null;
    renderTemplate(mode.value, paths);
  } else {
    renderFigure(paths);
  }
}

function renderFigure(paths) {
  const next = new THREE.Group();
  next.name = 'AirDraft_Stickman';
  lastFigurePaths = paths;
  const rig = defaultRig;
  const figure = rig ? recognizeFigure(paths) : buildClayFigure(paths,next,clay);
  if (rig) {
    next.name = 'AirDraft_Posed_Stickman';
    next.add(poseRig(rig,figure,clay));
  }
  let label = rig ? 'StickMan rest pose · draw a closed head' : 'Draw a closed head to fit a figure';
  if (figure) {
    const {hip,arms,legs} = figure;
    const parts = ['Head',hip && 'torso',arms.length + (arms.length === 1 ? ' arm' : ' arms'),
      legs.length + (legs.length === 1 ? ' leg' : ' legs')].filter(Boolean);
    label = rig && !hip ? 'StickMan rest pose · add body and limbs' : parts.join(' · ');
  }
  showModel(next, label, true);
}

function showModel(next, label, frontView) {
  if (model) {
    scene.remove(model);
    model.traverse(node => {
      node.geometry?.dispose();
    });
  }
  model = next;
  scene.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  grid.position.y = box.min.y - .03;
  if (controls) {
    const radius = Math.max(box.getSize(new THREE.Vector3()).length()/2,.8);
    const halfVerticalFov = THREE.MathUtils.degToRad(view.fov/2);
    const aspect = viewer.clientWidth / viewer.clientHeight;
    const halfFov = Math.min(halfVerticalFov, Math.atan(Math.tan(halfVerticalFov) * aspect));
    view.position.copy(center).add(new THREE.Vector3(frontView ? .15 : .65,frontView ? .10 : .33,1).normalize().multiplyScalar(radius/Math.sin(halfFov)));
    controls.target.copy(center);
    controls.update();
  }
  status.textContent = renderer ? label : 'WebGL unavailable · OBJ export ready';
  byId('export').disabled = false;
}

function loadExample() {
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const sketch = TEMPLATE_KINDS.includes(mode.value)
    ? templateExample(mode.value, Math.max(.5, aspect))
    : structuredClone(examples[mode.value]);
  if (mode.value === 'tubes') {
    sketch[0] = sketch[0].map(([x,y]) => [.5+(x-.5)/Math.max(.5,aspect),y]);
  }
  drawing.replace(sketch);
  generate('Example model');
}
byId('sample').addEventListener('click', loadExample);
byId('undo').addEventListener('click', () => drawing.undo());
byId('clear').addEventListener('click', () => drawing.replace([]));
byId('generate').addEventListener('click', () => generate('Model ready'));
byId('export').addEventListener('click', () => {
  if (!model) return;
  const content = new OBJExporter().parse(model);
  const url = URL.createObjectURL(new Blob([content],{type:'text/plain'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = model.name.toLowerCase() + '.obj';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
});
const modeHints = {
  tubes: 'Draw a closed head, a body line, and two arms and legs. Drag the preview to rotate.',
  house: 'Draw a front view with straight walls and a peaked roof. The outline sets the house proportions.',
  fish: 'Draw a side view: a closed body and a tail on one side. The tail side sets which way the fish faces.',
  bird: 'Draw a flying bird from the front, like an "M", with one stroke per wing. The bends set the wing angles.',
  tree: 'Draw a closed crown on top and a trunk below. Their sizes set the tree.',
  flower: 'Draw a stem, a bloom with 3 to 8 petals, and up to two leaves. The petal count and stem height set the flower.'
};
mode.addEventListener('change', () => {
  byId('mode-hint').textContent = modeHints[mode.value];
  if (TEMPLATE_KINDS.includes(mode.value)) loadTemplate(mode.value);
});
loadExample();

async function loadDefaultRig() {
  try {
    const [{readStickmanRig,poseStickman},response] = await Promise.all([
      import('./stickman-rig.js'),
      fetch('./assets/stickman-default.glb')
    ]);
    if (!response.ok) throw new Error('StickMan download failed (' + response.status + ').');
    defaultRig = await readStickmanRig(await response.arrayBuffer());
    poseRig = poseStickman;
    if (mode.value === 'tubes' && lastFigurePaths) renderFigure(lastFigurePaths);
  } catch (error) {
    console.warn('Default StickMan unavailable',error);
  }
}
loadDefaultRig();
