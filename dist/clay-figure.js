import * as THREE from 'three';
import {MarchingCubes} from 'three/addons/objects/MarchingCubes.js';

export function recognizeFigure(paths) {
  const outlines = paths.map(path => {
    const bounds = new THREE.Box3().setFromPoints(path);
    const size = bounds.getSize(new THREE.Vector3());
    return {path,bounds,size,center:bounds.getCenter(new THREE.Vector3())};
  });
  const head = outlines.filter(({path,size,center}) =>
    path.length >= 5 && center.y > .35 && size.x > .24 && size.y > .24 &&
    Math.max(size.x,size.y) < 1.65 && size.x/size.y > .50 && size.x/size.y < 2 &&
    path[0].distanceTo(path.at(-1)) < .36*Math.max(size.x,size.y)
  ).sort((a,b) => b.center.y-a.center.y)[0];
  if (!head) return null;

  const body = paths.filter(path => path !== head.path);
  const points = body.flat();
  const neck = new THREE.Vector3(head.center.x,head.bounds.min.y,0);
  const bottom = points.reduce((lowest,p) => Math.min(lowest,p.y),neck.y);
  const span = neck.y-bottom;
  if (span < .60) return {head,neck,hip:null,arms:[],legs:[]};

  const expectedHip = neck.y-span*.48;
  const endpoints = body.flatMap(path => [path[0],path.at(-1)]);
  const candidates = points.filter(p => Math.abs(p.x-neck.x) < .42 &&
    p.y < neck.y-span*.25 && p.y > neck.y-span*.65);
  const hipScore = p => endpoints.filter(end => end.distanceToSquared(p) < .14**2).length*.18
    - Math.abs(p.y-expectedHip)*.65 - Math.abs(p.x-neck.x)*1.3;
  const hip = candidates.reduce((best,p) => !best || hipScore(p)>hipScore(best) ? p : best,null)
    ?? new THREE.Vector3(neck.x,expectedHip,0);
  const bodyLength = neck.y-hip.y;
  const shoulders = neck.clone().lerp(hip,.13);

  function findLimb(side, leg) {
    const anchor = (leg ? hip : shoulders).clone();
    const reference = leg ? hip : neck;
    const minOffset = leg ? .12 : .23;
    const eligible = points.filter(p => {
      const offset = side*(p.x-reference.x);
      return offset > minOffset && (leg
        ? p.y < hip.y-span*.16
        : p.y > hip.y+bodyLength*.04 && p.y < neck.y+bodyLength*.42);
    });
    const weight = p => leg ? hip.y-p.y+.22*side*(p.x-hip.x) : side*(p.x-neck.x);
    const end = eligible.reduce((best,p) => !best || weight(p)>weight(best) ? p : best,null);
    if (!end) return null;
    anchor.x += side*Math.min(leg ? .13 : .22,Math.abs(end.x-reference.x)*.42);
    const midpoint = anchor.clone().lerp(end,.5);
    const maxBend = anchor.distanceTo(end)*.23;
    const bend = eligible.reduce((best,p) => {
      const distance = p.distanceToSquared(midpoint);
      return distance < maxBend**2 && (!best || distance < best.distanceToSquared(midpoint)) ? p : best;
    },null);
    return {anchor,bend:bend ?? midpoint,end};
  }

  return {
    head,neck,hip,shoulders,
    arms:[findLimb(-1,false),findLimb(1,false)].filter(Boolean),
    legs:[findLimb(-1,true),findLimb(1,true)].filter(Boolean)
  };
}

export function buildClayFigure(paths, group, material) {
  const figure = recognizeFigure(paths);
  const arms = figure?.arms ?? [];
  const legs = figure?.legs ?? [];
  const extent = [...arms,...legs].reduce((max,{bend,end}) =>
    Math.max(max,Math.abs(bend.x),Math.abs(bend.y),Math.abs(end.x),Math.abs(end.y)),1.9);
  const halfExtent = Math.max(2.55,extent+.65);
  const resolution = Math.min(120,Math.ceil(80*halfExtent/2.55));
  const step = 2 * halfExtent / resolution;
  const surface = new MarchingCubes(resolution, material, false, false, 30000);
  const field = surface.field;
  surface.isolation = 0;
  field.fill(-step * 2);

  function stamp(first, last, radius, stretchX = 1, stretchY = 1, stretchZ = 1) {
    const padding = (radius + 2 * step) * Math.max(1, stretchX, stretchY, stretchZ);
    const startIndex = value => Math.max(0, Math.floor((value - padding + halfExtent) / step));
    const endIndex = value => Math.min(resolution - 1, Math.ceil((value + padding + halfExtent) / step));
    const minX = startIndex(Math.min(first.x,last.x));
    const maxX = endIndex(Math.max(first.x,last.x));
    const minY = startIndex(Math.min(first.y,last.y));
    const maxY = endIndex(Math.max(first.y,last.y));
    const dx = last.x-first.x;
    const dy = last.y-first.y;
    const lengthSquared = dx*dx + dy*dy;
    for (let z = startIndex(first.z); z <= endIndex(first.z); z++) {
      const depth = (z*step-halfExtent-first.z)/stretchZ;
      for (let y = minY; y <= maxY; y++) {
        const py = y*step-halfExtent-first.y;
        for (let x = minX; x <= maxX; x++) {
          const px = x*step-halfExtent-first.x;
          const t = lengthSquared ? THREE.MathUtils.clamp((px*dx+py*dy)/lengthSquared,0,1) : 0;
          const value = radius-Math.hypot((px-dx*t)/stretchX,(py-dy*t)/stretchY,depth);
          const index = x + resolution*(y + resolution*z);
          field[index] = Math.max(field[index],value);
        }
      }
    }
  }

  if (!figure) {
    for (const path of paths) {
      let previous = path[0];
      for (const point of path.slice(1,-1)) {
        if (point.distanceToSquared(previous) < .035**2) continue;
        stamp(previous,point,.135);
        previous = point;
      }
      stamp(previous,path.at(-1),.135);
    }
  } else {
    const {head,neck,hip,shoulders} = figure;
    const length = hip ? neck.distanceTo(hip) : 0;
    const radius = hip
      ? THREE.MathUtils.clamp(length*.43,.32,.58)
      : Math.min(head.size.x,head.size.y)*.52;
    const face = hip ? neck.clone().add(new THREE.Vector3(0,radius*.88,0)) : head.center;
    stamp(face,face,radius,.98,1.05,.94);
    if (hip) {
      const trunk = THREE.MathUtils.clamp(length*.25,.22,.36);
      const chest = neck.clone().lerp(hip,.39);
      const pelvis = hip.clone().lerp(neck,.11);
      stamp(neck,shoulders,trunk*.55);
      stamp(shoulders,pelvis,trunk,1.07,1,.77);
      stamp(chest,chest,trunk,1.24,1.25,.88);
      stamp(pelvis,hip,trunk*.91,1.18,.91,.79);
      for (const {anchor,bend,end} of arms) {
        stamp(anchor,bend,trunk*.53);
        stamp(bend,end,trunk*.42);
        const direction = end.clone().sub(bend).normalize();
        const palm = end.clone().addScaledVector(direction,trunk*.40);
        const fingertips = end.clone().addScaledVector(direction,trunk*.88);
        stamp(end,palm,trunk*.40,1,1,.70);
        stamp(palm,fingertips,trunk*.32,1,1,.70);
        const thumb = palm.clone().addScaledVector(direction,-trunk*.15)
          .add(new THREE.Vector3(0,-trunk*.33,trunk*.08));
        stamp(palm,thumb,trunk*.18);
      }
      for (const {anchor,bend,end} of legs) {
        stamp(anchor,bend,trunk*.65);
        stamp(bend,end,trunk*.49);
        const foot = end.clone().add(new THREE.Vector3(0,.025,.10));
        stamp(foot,foot,.15,1.18,.76,1.64);
      }
    }
  }

  // A small averaging pass blends intersecting stroke volumes into rounded joints.
  const original = field.slice();
  const plane = resolution*resolution;
  for (let i = plane+resolution+1; i < field.length-plane-resolution-1; i++) {
    if (original[i] <= -step*1.99) continue;
    field[i] = original[i]*.56 + (
      original[i-1]+original[i+1]+original[i-resolution]+original[i+resolution]+
      original[i-plane]+original[i+plane]
    )*(.44/6);
  }
  surface.update();
  const geometry = new THREE.BufferGeometry();
  const end = surface.count*3;
  geometry.setAttribute('position',new THREE.BufferAttribute(surface.positionArray.slice(0,end),3));
  geometry.setAttribute('normal',new THREE.BufferAttribute(surface.normalArray.slice(0,end),3));
  geometry.normalizeNormals();
  geometry.scale(halfExtent,halfExtent,halfExtent);
  surface.geometry.dispose();
  group.add(new THREE.Mesh(geometry,material));
  return figure;
}
