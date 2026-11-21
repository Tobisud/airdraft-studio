import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

import {createDrawing, clamp} from './drawing.js';
import {buildClayFigure, recognizeFigure} from './clay-figure.js';

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
let model = null;
let defaultRig = null;
let poseRig = null;
let lastFigurePaths = null;

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
  group.add(new THREE.Mesh(geometry,clay));
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
    const next = new THREE.Group();
    next.name = 'AirDraft_House';
    buildHouse(paths.flat(),next,width*scale,height*scale);
    lastFigurePaths = null;
    showModel(next, label, false);
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
  const sketch = structuredClone(examples[mode.value]);
  if (mode.value === 'tubes') {
    const aspect = canvas.clientWidth / canvas.clientHeight;
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
mode.addEventListener('change', () => {
  byId('mode-hint').textContent = mode.value === 'house'
    ? 'Draw a front view with straight walls and a peaked roof. The outline sets the house proportions.'
    : 'Draw a closed head, a body line, and two arms and legs. Drag the preview to rotate.';
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
