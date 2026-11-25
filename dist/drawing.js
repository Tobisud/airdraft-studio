export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// One Euro filter (Casiez et al., CHI 2012). It smooths strongly when the hand moves slowly,
// where tracking jitter is most visible, and lightly when it moves fast, so the pen keeps up.
// minCutoff: lower = steadier when still. beta: higher = less lag on fast moves.
function oneEuroFilter({minCutoff = 1, beta = 6, derivativeCutoff = 1} = {}) {
  let last = null;
  let lastTime = 0;
  let speed = [0, 0];
  const alpha = (cutoff, seconds) => 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds));
  return {
    reset() { last = null; },
    filter(point, time) {
      if (!last) {
        last = point;
        lastTime = time;
        speed = [0, 0];
        return point;
      }
      const seconds = Math.max((time - lastTime) / 1000, 1e-3);
      lastTime = time;
      const a = alpha(derivativeCutoff, seconds);
      speed = point.map((value, i) => a * (value - last[i]) / seconds + (1 - a) * speed[i]);
      const b = alpha(minCutoff + beta * Math.hypot(...speed), seconds);
      last = point.map((value, i) => b * value + (1 - b) * last[i]);
      return last;
    }
  };
}

// Clip each centerline segment against a circle in screen pixels.
function clipStroke(stroke, center, width, height, radius) {
  const offset = ([x,y]) => [(x-center[0])*width,(y-center[1])*height];
  if (stroke.length === 1) return Math.hypot(...offset(stroke[0])) < radius ? [] : [stroke];

  const pieces = [];
  let piece = [];
  let changed = false;
  const append = (first,last) => {
    if (!piece.length) piece.push(first);
    piece.push(last);
  };
  for (let i = 1; i < stroke.length; i++) {
    const first = stroke[i-1];
    const last = stroke[i];
    const [x,y] = offset(first);
    const dx = (last[0]-first[0])*width;
    const dy = (last[1]-first[1])*height;
    const lengthSquared = dx*dx + dy*dy;
    if (!lengthSquared) continue;
    const centerT = -(x*dx+y*dy)/lengthSquared;
    const distanceSquared = (x+centerT*dx)**2 + (y+centerT*dy)**2;
    const halfSpan = Math.sqrt(Math.max(0,radius*radius-distanceSquared)/lengthSquared);
    const enter = Math.max(0,centerT-halfSpan);
    const exit = Math.min(1,centerT+halfSpan);
    if (enter >= exit) {
      append(first,last);
      continue;
    }
    changed = true;
    const at = t => first.map((coordinate,axis) => coordinate+(last[axis]-coordinate)*t);
    if (enter > 0) append(first,at(enter));
    if (piece.length) pieces.push(piece);
    piece = exit < 1 ? [at(exit),last] : [];
  }
  if (piece.length) pieces.push(piece);
  return changed ? pieces : [stroke];
}

export function createDrawing(onChange) {
  const byId = id => document.getElementById(id);
  const canvas = byId('sketch');
  const ctx = canvas.getContext('2d');
  const cameraButton = byId('camera');
  const eraserButton = byId('eraser');
  const inputStatus = byId('input');
  const cameraStatus = byId('camera-status');
  const video = byId('video');
  const cursor = byId('cursor');
  const eraserPreview = byId('eraser-preview');
  const drawingHelp = cameraStatus.textContent;
  const cameraDrawHelp = 'The pen sits between your thumb and index fingertip. Pinch and hold to draw. Open clearly to lift the pen.';
  const cameraEraseHelp = 'Pinch and hold over the sketch to erase inside the circle. Release to hover.';
  const pointerEraseHelp = 'Drag the circle over the sketch to erase, or enable the camera to erase with a pinch.';

  let strokes = [];
  const sources = new WeakMap();
  let active = null;
  let erasing = false;
  let erasePoint = null;
  let eraseRecorded = false;
  const history = [];
  const eraseRadius = 16;
  const pinchStartRatio = .18;
  const pinchReleaseRatio = .25;
  const eraserToggleHoldMs = 75;
  // A pinch must stay open (or the hand stay lost) this long before a stroke ends,
  // so a one-frame tracking glitch does not cut a stroke in two.
  const releaseGraceMs = 100;
  for (const ring of [cursor, eraserPreview]) {
    ring.style.setProperty('--eraser-diameter', eraseRadius * 2 + 'px');
  }
  let pointerId = null;
  let stream = null;
  let landmarker = null;
  let smooth = null;
  const smoother = oneEuroFilter();
  let gapSince = null;
  let pending = [];
  let pinching = false;
  let armed = false;
  let pinchSince = null;
  let pinchOnEraser = false;
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
    onChange(strokes.length, history.length > 0 || strokes.length > 0);
  }

  new ResizeObserver(() => {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    paint();
  }).observe(canvas);

  function eraseAt(point) {
    const next = strokes.flatMap(stroke => {
      const pieces = clipStroke(stroke, point, canvas.clientWidth, canvas.clientHeight, eraseRadius + 2);
      if (pieces[0] !== stroke) {
        for (const piece of pieces) sources.set(piece, sources.get(stroke));
      }
      return pieces;
    });
    if (next.length === strokes.length && next.every((stroke,i) => stroke === strokes[i])) return;
    if (!eraseRecorded) {
      history.push(strokes);
      eraseRecorded = true;
    }
    strokes = next;
  }

  function start(point, source) {
    if (erasing) {
      erasePoint = point;
      eraseAt(point);
      paint();
      return;
    }
    history.push(strokes.slice());
    active = [point];
    strokes.push(active);
    sources.set(active, source);
    paint();
  }
  function add(point) {
    if (erasePoint) {
      const [x,y] = erasePoint;
      const dx = point[0]-x;
      const dy = point[1]-y;
      const steps = Math.max(1,Math.ceil(Math.hypot(dx*canvas.clientWidth,dy*canvas.clientHeight)/(eraseRadius/2)));
      for (let i = 1; i <= steps; i++) eraseAt([x+dx*i/steps,y+dy*i/steps]);
      erasePoint = point;
      if (eraseRecorded) paint();
      return;
    }
    const [x,y] = active.at(-1);
    if (Math.hypot((x - point[0]) * canvas.clientWidth, (y - point[1]) * canvas.clientHeight) < 3) return;
    active.push(point);
    paint();
  }
  function finish() {
    active = erasePoint = null;
    eraseRecorded = false;
  }

  function coordinate(event) {
    const rect = canvas.getBoundingClientRect();
    return [
      clamp((event.clientX - rect.left) / rect.width, 0, 1),
      clamp((event.clientY - rect.top) / rect.height, 0, 1)
    ];
  }

  function positionCursor(element, [x,y]) {
    element.style.left = x * 100 + '%';
    element.style.top = y * 100 + '%';
  }

  function showEraserPreview(point, pressed) {
    positionCursor(eraserPreview, point);
    eraserPreview.hidden = false;
    eraserPreview.classList.toggle('inking', pressed);
    cursor.hidden = true;
  }

  canvas.addEventListener('pointerdown', event => {
    if (pointerId !== null || pinching || event.button !== 0) return;
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    const point = coordinate(event);
    if (erasing) showEraserPreview(point, true);
    start(point, event.pointerType || 'mouse');
  });
  canvas.addEventListener('pointermove', event => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    const pressed = event.pointerId === pointerId;
    const point = coordinate(event);
    if (erasing && !pinching && (pressed || event.pointerType !== 'touch')) {
      showEraserPreview(point, pressed);
    }
    if (pressed && (active || erasePoint)) add(point);
  });
  canvas.addEventListener('pointerleave', () => {
    if (pointerId === null) eraserPreview.hidden = true;
  });
  for (const eventName of ['pointerup','pointercancel','lostpointercapture']) {
    canvas.addEventListener(eventName, event => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      finish();
      if (erasing && eventName === 'pointerup' && event.pointerType !== 'touch' &&
          document.elementFromPoint(event.clientX, event.clientY) === canvas) {
        showEraserPreview(coordinate(event), false);
      } else {
        eraserPreview.hidden = true;
      }
    });
  }

  function isOverEraser([x,y]) {
    const area = canvas.getBoundingClientRect();
    const button = eraserButton.getBoundingClientRect();
    const px = area.left + x*area.width;
    const py = area.top + y*area.height;
    return px >= button.left && px <= button.right && py >= button.top && py <= button.bottom;
  }

  function endPinch() {
    if (pinching) finish();
    pinching = false;
    gapSince = null;
    pending = [];
  }

  // Called when the pinch looks open or the hand is lost. During the grace period the stroke
  // stays open and points are held back; if the pinch comes back they are drawn, otherwise dropped.
  function holdStroke(now, point) {
    if (!pinching) return false;
    gapSince ??= now;
    if (now - gapSince > releaseGraceMs) {
      endPinch();
      return false;
    }
    if (point) pending.push(point);
    return true;
  }

  function cameraLoop() {
    let lastTime = -1;
    function track(now) {
      if (!stream) return;
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        try {
          const hand = landmarker.detectForVideo(video, now).landmarks[0];
          const aspect = video.videoWidth / video.videoHeight;
          const distance = (a,b) => Math.hypot((a.x-b.x)*aspect,a.y-b.y);
          const palm = hand ? distance(hand[0],hand[9]) : 0;
          if (!hand || palm <= .015) {
            if (!holdStroke(now, null)) {
              cursor.hidden = true;
              eraserButton.classList.remove('camera-hover');
              smooth = null;
              smoother.reset();
              armed = false;
              pinchSince = null;
              inputStatus.textContent = 'Show your hand';
            }
          } else {
            const tip = hand[8];
            const thumb = hand[4];
            // The pen sits midway between the thumb tip and index tip. That point barely moves
            // when the fingers close or open, so strokes don't get a hook at the start or end.
            const pen = {x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2};
            const point = [clamp((.9-pen.x)/.8,0,1),clamp((pen.y-.1)/.8,0,1)];
            smooth = smoother.filter(point, now);
            const canTargetEraser = pointerId === null;
            const overEraser = canTargetEraser && isOverEraser(smooth);
            const ratio = distance(tip,thumb)/palm;
            if (pointerId !== null) {
              endPinch();
              armed = false;
              pinchSince = null;
            } else if (ratio >= pinchReleaseRatio) {
              if (!holdStroke(now, smooth)) {
                armed = true;
                pinchSince = null;
              }
            } else if (pinching) {
              if (active || erasePoint) {
                for (const held of pending) add(held);
                add(smooth);
              }
              pending = [];
              gapSince = null;
            } else if (armed && ratio < pinchStartRatio) {
              if (pinchSince === null) {
                pinchSince = now;
                pinchOnEraser = overEraser || eraserButton.classList.contains('camera-hover');
              }
              if (!pinchOnEraser || now - pinchSince >= eraserToggleHoldMs) {
                eraserPreview.hidden = true;
                if (pinchOnEraser) eraserButton.click();
                else start(smooth, 'camera');
                pinching = true;
              }
            } else {
              pinchSince = null;
            }
            cursor.hidden = !eraserPreview.hidden;
            positionCursor(cursor, smooth);
            const editing = Boolean(active || erasePoint);
            cursor.classList.toggle('inking', pinching && editing);
            eraserButton.classList.toggle('camera-hover', overEraser && !pinching);
            if (pinching) {
              inputStatus.textContent = editing
                ? (erasing ? 'Erasing' : 'Drawing')
                : (erasing ? 'Eraser selected' : 'Pen selected');
            } else {
              inputStatus.textContent = armed
                ? (overEraser ? 'Hold pinch to toggle eraser' : 'Hovering')
                : 'Separate thumb and index finger';
            }
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

  function updateToolHelp() {
    cameraStatus.textContent = video.hidden
      ? (erasing ? pointerEraseHelp : drawingHelp)
      : (erasing ? cameraEraseHelp : cameraDrawHelp);
  }

  function stopCamera() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    cancelAnimationFrame(cameraFrame);
    video.srcObject = null;
    video.hidden = cursor.hidden = true;
    eraserButton.classList.remove('camera-hover');
    endPinch();
    armed = false;
    pinchSince = null;
    smooth = null;
    smoother.reset();
    inputStatus.textContent = 'Pointer ready';
    cameraButton.textContent = 'Enable camera';
    updateToolHelp();
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
      updateToolHelp();
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

  function resetPen() {
    finish();
    pointerId = null;
    pinching = armed = false;
    pinchSince = null;
    gapSince = null;
    pending = [];
    cursor.classList.remove('inking');
    eraserPreview.hidden = true;
  }

  eraserButton.addEventListener('click', () => {
    resetPen();
    erasing = !erasing;
    eraserButton.setAttribute('aria-pressed', String(erasing));
    cursor.classList.toggle('eraser-cursor', erasing);
    canvas.classList.toggle('eraser-active', erasing);
    inputStatus.textContent = erasing ? 'Eraser selected' : 'Pen selected';
    if (!cameraButton.disabled) updateToolHelp();
  });

  window.addEventListener('pagehide', stopCamera);
  return {
    get strokes() { return strokes; },
    sourceOf: stroke => sources.get(stroke),
    replace(next) {
      resetPen();
      history.length = 0;
      strokes = next;
      paint();
    },
    undo() {
      resetPen();
      if (history.length) strokes = history.pop();
      else strokes.pop();
      paint();
    }
  };
}
