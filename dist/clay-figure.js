import * as THREE from 'three';
import {MarchingCubes} from 'three/addons/objects/MarchingCubes.js';

export function buildClayFigure(paths, group, material) {
  const resolution = 80;
  const halfExtent = 2.55;
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

  const forms = paths.map(path => {
    const bounds = new THREE.Box3().setFromPoints(path);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const head = path.length >= 5 && center.y > .45 &&
      size.x > .24 && size.y > .24 && Math.max(size.x,size.y) < 1.65 &&
      size.x/size.y > .55 && size.x/size.y < 1.8 &&
      path[0].distanceTo(path.at(-1)) < .28 * Math.max(size.x,size.y);
    return {path,bounds,size,center,head};
  });
  const hasHead = forms.some(form => form.head);

  for (const {path,bounds,size,center,head} of forms) {
    if (head) {
      const radius = Math.min(size.x,size.y)*.52 + .045;
      stamp(center,center,radius,(size.x*.52+.045)/radius,(size.y*.52+.045)/radius);
      continue;
    }
    const torso = size.y > .60 && size.y > 2.6*size.x && Math.abs(center.x) < .45 && Math.abs(center.y) < .50;
    const legs = hasHead && size.y > .60 && bounds.min.y < -.85 && bounds.max.y < .35;
    const arms = hasHead && size.x > 1.2 && center.y > .1 && center.y < 1 && size.y < .65;
    const radius = torso || legs ? .20 : .135;
    let previous = path[0];
    for (const point of path.slice(1,-1)) {
      if (point.distanceToSquared(previous) < .035**2) continue;
      stamp(previous,point,radius);
      previous = point;
    }
    stamp(previous,path.at(-1),radius);

    if (torso && hasHead) {
      // The chest and hips follow the middle of the drawn body, leaving a narrower neck.
      const body = center.clone();
      body.y = bounds.min.y + size.y*.38;
      stamp(body,body,.29,1.25,THREE.MathUtils.clamp(size.y*.45/.29,1.1,2.45),.90);
      const shoulders = center.clone();
      shoulders.y = bounds.min.y + size.y*.72;
      stamp(shoulders,shoulders,.24,1.55,1,1);
      const hips = center.clone();
      hips.y = bounds.min.y + size.y*.10;
      stamp(hips,hips,.245,1.32,1.12,.95);
    }
    if (legs || arms) {
      const endpoints = new Set([path[0],path.at(-1)]);
      for (const endpoint of endpoints) {
        if (legs && endpoint.y < bounds.min.y + .24) {
          const foot = endpoint.clone().add(new THREE.Vector3(0,.035,.10));
          stamp(foot,foot,.18,1.23,.78,1.62);
        } else if (arms && Math.abs(endpoint.x-center.x) > size.x*.35) {
          stamp(endpoint,endpoint,.145,1.35,.90,1);
        }
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
}
