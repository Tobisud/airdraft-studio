import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

const byId = id => document.getElementById(id);
const canvas = byId('sketch');
const ctx = canvas.getContext('2d');
const viewer = byId('viewer');
const mode = byId('mode');
const status = byId('model-status');
const cameraButton = byId('camera');
const inputStatus = byId('input');
const cameraStatus = byId('camera-status');
const video = byId('video');
const cursor = byId('cursor');
const drawingHelp = cameraStatus.textContent;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const examples = {
  tubes: [
    Array.from({length: 41}, (_, i) => [
      .5 + .08 * Math.sin(i * Math.PI / 20),
      .255 + .08 * Math.cos(i * Math.PI / 20)
    ]),
    [[.5,.335],[.5,.61]],
    [[.32,.49],[.5,.435],[.68,.49]],
    [[.36,.81],[.5,.61],[.64,.81]]
  ],
  house: [
    [[.29,.46],[.5,.23],[.71,.46],[.71,.77],[.29,.77],[.29,.46]]
  ]
};
let strokes = [];
let active = null;
let pointerId = null;
let stream = null;
let landmarker = null;
let smooth = null;
let pinching = false;
let cameraFrame = null;

function paint() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#cabaff';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 4 * devicePixelRatio;
  ctx.lineJoin = ctx.lineCap = 'round';
  for (const stroke of strokes) {
    ctx.beginPath();
    const [x,y] = stroke[0];
    if (stroke.length === 1) {
      ctx.arc(x * canvas.width, y * canvas.height, ctx.lineWidth / 2, 0, 2 * Math.PI);
      ctx.fill();
      continue;
    }
    ctx.moveTo(x * canvas.width, y * canvas.height);
    for (const [px,py] of stroke.slice(1)) ctx.lineTo(px * canvas.width, py * canvas.height);
    ctx.stroke();
  }
  byId('undo').disabled = byId('clear').disabled = strokes.length === 0;
}

new ResizeObserver(() => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  paint();
}).observe(canvas);

function start(point) {
  active = [point];
  strokes.push(active);
  paint();
}
function add(point) {
  const [x,y] = active.at(-1);
  if (Math.hypot((x - point[0]) * canvas.clientWidth, (y - point[1]) * canvas.clientHeight) < 3) return;
  active.push(point);
  paint();
}
function finish() { active = null; }

function coordinate(event) {
  const rect = canvas.getBoundingClientRect();
  return [
    clamp((event.clientX - rect.left) / rect.width, 0, 1),
    clamp((event.clientY - rect.top) / rect.height, 0, 1)
  ];
}

canvas.addEventListener('pointerdown', event => {
  if (pointerId !== null || pinching || event.button !== 0) return;
  pointerId = event.pointerId;
  canvas.setPointerCapture(pointerId);
  start(coordinate(event));
});
canvas.addEventListener('pointermove', event => {
  if (event.pointerId === pointerId && active) add(coordinate(event));
});
for (const eventName of ['pointerup','pointercancel','lostpointercapture']) {
  canvas.addEventListener(eventName, event => {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    finish();
  });
}

function cameraLoop() {
  let lastTime = -1;
  function track(now) {
    if (!stream) return;
    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      try {
        const hand = landmarker.detectForVideo(video, now).landmarks[0];
        if (!hand) {
          if (pinching) finish();
          cursor.hidden = true;
          smooth = null;
          pinching = false;
          inputStatus.textContent = 'Show your hand';
        } else {
          const tip = hand[8];
          const thumb = hand[4];
          const aspect = video.videoWidth / video.videoHeight;
          const distance = (a,b) => Math.hypot((a.x-b.x)*aspect,a.y-b.y);
          const palm = distance(hand[0],hand[9]);
          const point = [clamp((.9-tip.x)/.8,0,1),clamp((tip.y-.1)/.8,0,1)];
          smooth = smooth ? smooth.map((value,i) => .58 * value + .42 * point[i]) : point;
          const down = pointerId === null && palm > .015 && distance(tip,thumb)/palm < (pinching ? .43 : .30);
          if (down && !pinching) start(smooth);
          else if (down && active) add(smooth);
          else if (!down && pinching) finish();
          pinching = down;
          cursor.hidden = false;
          cursor.style.left = smooth[0] * 100 + '%';
          cursor.style.top = smooth[1] * 100 + '%';
          cursor.classList.toggle('inking', down);
          inputStatus.textContent = down ? 'Drawing' : 'Hand detected';
        }
      } catch (error) {
        stopCamera();
        cameraStatus.textContent = 'Hand tracking stopped. You can keep drawing with a pointer.';
        console.error(error);
        return;
      }
    }
    cameraFrame = requestAnimationFrame(track);
  }
  cameraFrame = requestAnimationFrame(track);
}

function stopCamera() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  cancelAnimationFrame(cameraFrame);
  video.srcObject = null;
  video.hidden = cursor.hidden = true;
  if (pinching) finish();
  pinching = false;
  smooth = null;
  inputStatus.textContent = 'Pointer ready';
  cameraButton.textContent = 'Enable camera';
  cameraStatus.textContent = drawingHelp;
}

cameraButton.addEventListener('click', async () => {
  if (stream) { stopCamera(); return; }
  cameraButton.disabled = true;
  cameraStatus.textContent = 'Waiting for camera permission…';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera needs HTTPS or localhost.');
    stream = await navigator.mediaDevices.getUserMedia({video:{width:640,height:480},audio:false});
    video.srcObject = stream;
    await video.play();
    cameraStatus.textContent = 'Loading the hand tracking model…';
    if (!landmarker) {
      const visionBase = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
      const {FilesetResolver, HandLandmarker} = await import(visionBase + '/vision_bundle.mjs');
      const vision = await FilesetResolver.forVisionTasks(visionBase + '/wasm');
      landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'},
        runningMode:'VIDEO',
        numHands:1
      });
    }
    video.hidden = false;
    cameraButton.textContent = 'Stop camera';
    cameraStatus.textContent = 'Pinch to draw and release to lift the pen. Camera frames are processed on your device.';
    inputStatus.textContent = 'Show your hand';
    cameraLoop();
  } catch (error) {
    stopCamera();
    cameraStatus.textContent = error.name === 'NotAllowedError'
      ? 'Camera access was denied. Allow access in browser settings or draw with a pointer.'
      : 'Camera or hand model unavailable. Check your camera and connection, or draw with a pointer.';
    console.error(error);
  } finally {
    cameraButton.disabled = false;
  }
});

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

const ink = new THREE.MeshStandardMaterial({color:0xa88bfb,roughness:.38});
const clay = new THREE.MeshStandardMaterial({color:0xfafafa,roughness:.82});
const jointGeometry = new THREE.SphereGeometry(.055, 12, 8);
const up = new THREE.Vector3(0,1,0);
let model = null;
let modelRevision = 0;

function buildStrokes(paths, group) {
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const point = path[i];
      const joint = new THREE.Mesh(jointGeometry, ink);
      joint.position.copy(point);
      group.add(joint);
      if (i === 0) continue;
      const previous = path[i-1];
      const direction = point.clone().sub(previous);
      const length = direction.length();
      if (length < .0001) continue;
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(.055,.055,length,12),ink);
      segment.position.copy(point).lerp(previous,.5);
      segment.quaternion.setFromUnitVectors(up,direction.normalize());
      group.add(segment);
    }
  }
}

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
  const next = new THREE.Group();
  next.name = mode.value === 'house' ? 'AirDraft_House' : 'AirDraft_Strokes';
  if (mode.value === 'house') buildHouse(paths.flat(),next,width*scale,height*scale);
  else buildStrokes(paths,next);

  showModel(next, label);
}

function showModel(next, label) {
  modelRevision++;
  if (model) {
    scene.remove(model);
    model.traverse(node => {
      if (node.geometry && node.geometry !== jointGeometry) node.geometry.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (material && material !== ink && material !== clay) material.dispose();
      }
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
    view.position.copy(center).add(new THREE.Vector3(.65,.33,1).normalize().multiplyScalar(radius/Math.sin(halfFov)));
    controls.target.copy(center);
    controls.update();
  }
  status.textContent = renderer ? label : 'WebGL unavailable · OBJ export ready';
  byId('export').disabled = false;
}

function loadExample() {
  finish();
  strokes = structuredClone(examples[mode.value]);
  paint();
  generate('Example model');
}
byId('sample').addEventListener('click', loadExample);
for (const button of document.querySelectorAll('[data-model-name]')) {
  const message = byId(button.getAttribute('aria-describedby'));
  button.addEventListener('click', async () => {
    const revision = modelRevision;
    button.disabled = true;
    message.textContent = 'Loading the reconstructed mesh…';
    try {
      const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
      const {scene: sample} = await new GLTFLoader().loadAsync('./' + button.dataset.file);
      if (revision !== modelRevision) {
        message.textContent = 'The preview changed. Select the example again to load it.';
        return;
      }
      const size = new THREE.Box3().setFromObject(sample).getSize(new THREE.Vector3());
      sample.scale.multiplyScalar(3.8 / Math.max(size.x, size.y, size.z));
      sample.name = button.dataset.modelName;
      showModel(sample, button.dataset.modelLabel + ' · TripoSR');
      message.textContent = 'Example loaded. Drag the preview to rotate it.';
      byId('model-panel').scrollIntoView({block:'nearest'});
    } catch (error) {
      message.textContent = 'Could not load the 3D preview. You can download the GLB directly.';
      console.error(error);
    } finally {
      button.disabled = false;
    }
  });
}
byId('undo').addEventListener('click', () => { finish(); strokes.pop(); paint(); });
byId('clear').addEventListener('click', () => { finish(); strokes = []; paint(); });
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
    : 'Trace a head, torso, arms and legs. Drag to orbit and scroll or pinch to zoom.';
});
loadExample();
