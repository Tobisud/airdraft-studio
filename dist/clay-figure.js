import * as THREE from 'three';
import {MarchingCubes} from 'three/addons/objects/MarchingCubes.js';

export function buildClayFigure(paths, group, material) {
  const resolution = 64;
  const halfExtent = 2.55;
  const step = 2 * halfExtent / resolution;
  const surface = new MarchingCubes(resolution, material, false, false, 30000);
  const field = surface.field;
  surface.isolation = 0;
  field.fill(-step * 2);

  function stamp(first, last, radius, stretchX = 1, stretchY = 1) {
    const padding = (radius + 2 * step) * Math.max(1, stretchX, stretchY);
    const startIndex = value => Math.max(0, Math.floor((value - padding + halfExtent) / step));
    const endIndex = value => Math.min(resolution - 1, Math.ceil((value + padding + halfExtent) / step));
    const minX = startIndex(Math.min(first.x,last.x));
    const maxX = endIndex(Math.max(first.x,last.x));
    const minY = startIndex(Math.min(first.y,last.y));
    const maxY = endIndex(Math.max(first.y,last.y));
    const dx = last.x-first.x;
    const dy = last.y-first.y;
    const lengthSquared = dx*dx + dy*dy;
    for (let z = startIndex(0); z <= endIndex(0); z++) {
      const depth = z*step-halfExtent;
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

  const bounds = new THREE.Box3();
  for (const path of paths) {
    bounds.setFromPoints(path);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const closedHead = path.length >= 5 && center.y > .45 &&
      size.x > .24 && size.y > .24 && Math.max(size.x,size.y) < 1.65 &&
      size.x/size.y > .55 && size.x/size.y < 1.8 &&
      path[0].distanceTo(path.at(-1)) < .28 * Math.max(size.x,size.y);
    if (closedHead) {
      const radius = Math.min(size.x,size.y)*.52 + .045;
      stamp(center,center,radius,(size.x*.52+.045)/radius,(size.y*.52+.045)/radius);
      continue;
    }
    const torso = size.y > .60 && size.y > 2.6*size.x && Math.abs(center.x) < .45 && Math.abs(center.y) < .50;
    const radius = torso ? .26 : .135;
    let previous = path[0];
    for (const point of path.slice(1,-1)) {
      if (point.distanceToSquared(previous) < .035**2) continue;
      stamp(previous,point,radius);
      previous = point;
    }
    stamp(previous,path.at(-1),radius);
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
}
