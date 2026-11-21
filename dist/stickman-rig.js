import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

export async function readStickmanRig(data) {
  const header = new DataView(data);
  if (data.byteLength < 20 || header.getUint32(0,true) !== 0x46546c67 ||
      header.getUint32(4,true) !== 2 || header.getUint32(8,true) !== data.byteLength ||
      header.getUint32(16,true) !== 0x4e4f534a) {
    throw new Error('Choose a valid glTF 2.0 GLB file.');
  }
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,header.getUint32(12,true))));
  if (json.buffers?.some(buffer => buffer.uri) || json.images?.length || json.extensionsRequired?.length) {
    throw new Error('Choose the self-contained, untextured StickMan GLB.');
  }

  const {scene} = await new GLTFLoader().parseAsync(data,'');
  const meshes = [];
  scene.traverse(node => { if (node.isSkinnedMesh) meshes.push(node); });
  const mesh = meshes[0];
  if (meshes.length !== 1 || !mesh.geometry.getAttribute('skinIndex') || !mesh.geometry.getAttribute('skinWeight')) {
    throw new Error('The GLB must contain one weighted StickMan mesh.');
  }
  const {bones,boneInverses} = mesh.skeleton;
  const ids = new Map(bones.map((bone,i) => [bone.name.replace(/_\d+$/,''),i]));
  const pivot = name => {
    const index = ids.get(name);
    if (index === undefined) throw new Error('Missing StickMan joint: ' + name);
    const inverse = boneInverses[index];
    if (!inverse || Math.abs(inverse.determinant()) < 1e-10) throw new Error('Invalid StickMan bind matrix.');
    return new THREE.Vector3().setFromMatrixPosition(inverse.clone().invert());
  };
  // This FAB export stores the effective joint origins in inverse-bind matrices.
  const neck = pivot('Neck');
  const hip = pivot('Root');
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  if (!Number.isFinite(bounds.min.y) || neck.y <= hip.y || bounds.max.y <= bounds.min.y) {
    throw new Error('The StickMan rig has an invalid rest pose.');
  }
  const chains = ['Left','Right'].map(side => {
    const arm = ['Arm','ForeArm','Hand'].map(joint => side+joint);
    const leg = ['UpLeg','Leg'].map(joint => side+joint);
    const [shoulder,elbow,wrist] = arm.map(pivot);
    const [thigh,knee] = leg.map(pivot);
    const ground = new THREE.Vector3(knee.x,bounds.min.y+(knee.y-thigh.y)*-.14,knee.z);
    return {arm,leg,shoulder,elbow,wrist,thigh,knee,ground};
  });
  return {geometry:mesh.geometry, ids, count:bones.length, chains, torsoLength:neck.y-hip.y};
}

// A segment may change its axial length while retaining its width and depth.
function segmentMatrix(start, end, posedStart, delta) {
  const rest = end.clone().sub(start);
  const length = Math.hypot(rest.x,rest.y);
  const desired = Math.hypot(delta.x,delta.y);
  if (length < 1e-5 || desired < 1e-5) {
    return new THREE.Matrix4().makeTranslation(...posedStart.clone().sub(start).toArray());
  }
  const x = rest.x/length;
  const y = rest.y/length;
  const scale = THREE.MathUtils.clamp(desired/length,.55,1.55)-1;
  const stretch = new THREE.Matrix4().set(
    1+scale*x*x,scale*x*y,0,0,
    scale*x*y,1+scale*y*y,0,0,
    0,0,1,0,
    0,0,0,1
  );
  const angle = Math.atan2(delta.y,delta.x)-Math.atan2(rest.y,rest.x);
  return new THREE.Matrix4().makeTranslation(...posedStart.toArray())
    .multiply(new THREE.Matrix4().makeRotationZ(angle))
    .multiply(stretch)
    .multiply(new THREE.Matrix4().makeTranslation(-start.x,-start.y,-start.z));
}

export function poseStickman(rig, figure, material) {
  const {ids,geometry,count,chains,torsoLength} = rig;
  const transforms = Array.from({length:count},() => new THREE.Matrix4());
  if (figure?.hip) {
    const unit = torsoLength/figure.neck.distanceTo(figure.hip);
    const delta = (first,last) => new THREE.Vector3((first.x-last.x)*unit,(last.y-first.y)*unit,0);
    function setChain(names, start, middle, end, limb) {
      if (!limb) return;
      const upper = segmentMatrix(start,middle,start,delta(limb.anchor,limb.bend));
      const joint = middle.clone().applyMatrix4(upper);
      const lower = segmentMatrix(middle,end,joint,delta(limb.bend,limb.end));
      transforms[ids.get(names[0])] = upper;
      transforms[ids.get(names[1])] = lower;
      if (names.length === 3) {
        const posedEnd = end.clone().applyMatrix4(lower);
        const rest = end.clone().sub(middle);
        const desired = posedEnd.clone().sub(joint);
        const angle = Math.atan2(desired.y,desired.x)-Math.atan2(rest.y,rest.x);
        transforms[ids.get(names[2])] = new THREE.Matrix4().makeTranslation(...posedEnd.toArray())
          .multiply(new THREE.Matrix4().makeRotationZ(angle))
          .multiply(new THREE.Matrix4().makeTranslation(-end.x,-end.y,-end.z));
      }
    }
    // The source asset faces -Z. Reverse sketch X here, then turn it toward the viewer.
    chains.forEach((chain,index) => {
      const side = index === 0 ? -1 : 1;
      const arm = figure.arms.find(limb => side*(limb.end.x-figure.neck.x)>0);
      const leg = figure.legs.find(limb => side*(limb.end.x-figure.hip.x)>0);
      setChain(chain.arm,chain.shoulder,chain.elbow,chain.wrist,arm);
      setChain(chain.leg,chain.thigh,chain.knee,chain.ground,leg);
    });
  }

  const posed = geometry.clone();
  const position = posed.getAttribute('position');
  const normal = posed.getAttribute('normal');
  const joints = posed.getAttribute('skinIndex');
  const weights = posed.getAttribute('skinWeight');
  const normalTransforms = transforms.map(matrix => new THREE.Matrix3().getNormalMatrix(matrix));
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const result = new THREE.Vector3();
  const resultNormal = new THREE.Vector3();
  const temp = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position,i);
    if (normal) direction.fromBufferAttribute(normal,i);
    result.set(0,0,0);
    resultNormal.set(0,0,0);
    let total = 0;
    for (let j = 0; j < 4; j++) {
      const weight = weights.getComponent(i,j);
      if (weight <= 0) continue;
      const joint = joints.getComponent(i,j);
      if (!transforms[joint]) continue;
      result.addScaledVector(temp.copy(point).applyMatrix4(transforms[joint]),weight);
      if (normal) resultNormal.addScaledVector(temp.copy(direction).applyMatrix3(normalTransforms[joint]),weight);
      total += weight;
    }
    if (total > 0) {
      position.setXYZ(i,result.x/total,result.y/total,result.z/total);
      if (normal) normal.setXYZ(i,...resultNormal.normalize().toArray());
    }
  }
  posed.deleteAttribute('skinIndex');
  posed.deleteAttribute('skinWeight');
  posed.rotateY(Math.PI);
  posed.computeBoundingBox();
  const scale = 3.8 / posed.boundingBox.getSize(new THREE.Vector3()).y;
  posed.translate(...posed.boundingBox.getCenter(new THREE.Vector3()).negate().toArray());
  posed.scale(scale,scale,scale);
  return new THREE.Mesh(posed,material);
}
