export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createDrawing(onChange) {
  const byId = id => document.getElementById(id);
  const canvas = byId('sketch');
  const ctx = canvas.getContext('2d');
  const cameraButton = byId('camera');
  const inputStatus = byId('input');
  const cameraStatus = byId('camera-status');
  const video = byId('video');
  const cursor = byId('cursor');
  const drawingHelp = cameraStatus.textContent;

  let strokes = [];
  const sources = new WeakMap();
  let active = null;
  let pointerId = null;
  let stream = null;
  let landmarker = null;
  let smooth = null;
  let pinching = false;
  let armed = false;
  let pinchSince = null;
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
    onChange(strokes.length);
  }

  new ResizeObserver(() => {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    paint();
  }).observe(canvas);

  function start(point, source) {
    active = [point];
    strokes.push(active);
    sources.set(active, source);
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
    start(coordinate(event), event.pointerType || 'mouse');
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
            pinching = armed = false;
            pinchSince = null;
            inputStatus.textContent = 'Show your hand';
          } else {
            const tip = hand[8];
            const thumb = hand[4];
            const aspect = video.videoWidth / video.videoHeight;
            const distance = (a,b) => Math.hypot((a.x-b.x)*aspect,a.y-b.y);
            const palm = distance(hand[0],hand[9]);
            const point = [clamp((.9-tip.x)/.8,0,1),clamp((tip.y-.1)/.8,0,1)];
            smooth = smooth ? smooth.map((value,i) => .58 * value + .42 * point[i]) : point;
            const ratio = palm > .015 ? distance(tip,thumb)/palm : Infinity;
            if (palm <= .015 || pointerId !== null) {
              if (pinching) finish();
              armed = pinching = false;
              pinchSince = null;
            } else if (ratio >= .43) {
              if (pinching) finish();
              pinching = false;
              armed = true;
              pinchSince = null;
            } else if (pinching && active) {
              add(smooth);
            } else if (armed && ratio < .30) {
              pinchSince ??= now;
              if (now - pinchSince >= 75) {
                start(smooth, 'camera');
                pinching = true;
              }
            } else {
              pinchSince = null;
            }
            cursor.hidden = false;
            cursor.style.left = smooth[0] * 100 + '%';
            cursor.style.top = smooth[1] * 100 + '%';
            cursor.classList.toggle('inking', pinching);
            inputStatus.textContent = pinching ? 'Drawing' : armed ? 'Hovering' : 'Separate thumb and index finger';
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
    pinching = armed = false;
    pinchSince = null;
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
      cameraStatus.textContent = 'Move with your fingers apart to aim. Pinch to draw and release to lift the pen.';
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
    cursor.classList.remove('inking');
  }

  window.addEventListener('pagehide', stopCamera);
  return {
    get strokes() { return strokes; },
    sourceOf: stroke => sources.get(stroke),
    replace(next) { resetPen(); strokes = next; paint(); },
    undo() { resetPen(); strokes.pop(); paint(); }
  };
}
