// Inference for the trained 64×64 AirDraft CNN. BatchNorm is folded into the exported kernels.
const SIZE = 64;
const CHANNELS = [1,16,32,48];
const LABELS = ['stickman','house','fish','bird','tree','flower'];
let loading;
let rasterizer;

export function readWeights(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength !== 93148 || view.getUint32(0) !== 0x41434e31) {
    throw new Error('Invalid sketch classifier weights.');
  }
  let cursor = 4;
  const take = count => {
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++,cursor += 4) values[i] = view.getFloat32(cursor,true);
    return values;
  };
  const layers = CHANNELS.slice(1).map((channels,i) => ({
    weights:take(channels*CHANNELS[i]*9),bias:take(channels)
  }));
  return {layers, weights:take(6*48*4*4), bias:take(6)};
}

function loadRasterizer() {
  if (rasterizer) return rasterizer;
  rasterizer = new Promise((resolve,reject) => {
    const script = document.createElement('script');
    script.src = 'https://docs.opencv.org/4.10.0/opencv.js';
    const timer = setTimeout(() => reject(new Error('Sketch preprocessing took too long to load.')),20000);
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('OpenCV sketch preprocessing could not load.'));
    };
    script.onload = () => {
      const cv = globalThis.cv;
      if (cv?.then) {
        cv.then(ready => {
          clearTimeout(timer);
          // OpenCV's module is itself a thenable. Wrap it before resolving.
          resolve({cv:ready});
        },reject);
      } else {
        clearTimeout(timer);
        if (cv?.Mat) resolve({cv});
        else reject(new Error('OpenCV sketch preprocessing could not start.'));
      }
    };
    document.head.append(script);
  }).catch(error => { rasterizer = null; throw error; });
  return rasterizer;
}

// np.rint, used during training, rounds exact halfway cases to the even integer.
function roundEven(value) {
  const floor = Math.floor(value);
  return value-floor === .5 ? floor+floor%2 : Math.round(value);
}

export function rasterizeSketch(cv, strokes, width, height) {
  const points = [];
  const paths = strokes.map(stroke => stroke.map(([x,y]) => {
    const point = [x*width,y*height];
    points.push(point);
    return point;
  }));
  const [left,top,right,bottom] = points.reduce(([l,t,r,b],[x,y]) =>
    [Math.min(l,x),Math.min(t,y),Math.max(r,x),Math.max(b,y)],
    [Infinity,Infinity,-Infinity,-Infinity]);
  const extent = Math.max(right-left,bottom-top);
  if (extent < 12) throw new Error('Draw a larger sketch before generating.');
  const scale = 49/extent;
  const cx = (left+right)/2, cy = (top+bottom)/2;
  const image = cv.Mat.zeros(SIZE,SIZE,cv.CV_8UC1);
  const ink = new cv.Scalar(255);
  try {
    for (const path of paths) {
      const pixels = path.flatMap(([x,y]) => [roundEven((x-cx)*scale+31.5),roundEven((y-cy)*scale+31.5)]);
      if (path.length === 1) {
        cv.circle(image,new cv.Point(...pixels),1,ink,-1,cv.LINE_AA);
        continue;
      }
      const polygon = cv.matFromArray(path.length,1,cv.CV_32SC2,pixels);
      const lines = new cv.MatVector();
      try {
        lines.push_back(polygon);
        cv.polylines(image,lines,false,ink,2,cv.LINE_AA);
      } finally {
        lines.delete();
        polygon.delete();
      }
    }
    return Float32Array.from(image.data,value => value/255);
  } finally {
    image.delete();
  }
}

function convolutionPool(input, size, inChannels, outChannels, {weights,bias}) {
  const stride = size+2;
  const paddedPlane = stride*stride;
  const padded = new Float32Array(inChannels*paddedPlane);
  for (let c = 0; c < inChannels; c++) {
    for (let y = 0; y < size; y++) {
      const start = (c*size+y)*size;
      padded.set(input.subarray(start,start+size),c*paddedPlane+(y+1)*stride+1);
    }
  }
  const half = size/2;
  const output = new Float32Array(outChannels*half*half);
  for (let o = 0; o < outChannels; o++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let sum = bias[o];
        for (let c = 0; c < inChannels; c++) {
          const p = c*paddedPlane+y*stride+x;
          const w = (o*inChannels+c)*9;
          sum += padded[p]*weights[w] + padded[p+1]*weights[w+1] + padded[p+2]*weights[w+2]
            + padded[p+stride]*weights[w+3] + padded[p+stride+1]*weights[w+4] + padded[p+stride+2]*weights[w+5]
            + padded[p+2*stride]*weights[w+6] + padded[p+2*stride+1]*weights[w+7] + padded[p+2*stride+2]*weights[w+8];
        }
        const cell = (o*half+(y>>1))*half+(x>>1);
        if (sum > output[cell]) output[cell] = sum;
      }
    }
  }
  return output;
}

export function predictRaster(image, model) {
  let features = image, size = SIZE;
  for (let i = 0; i < model.layers.length; i++, size /= 2) {
    features = convolutionPool(features,size,CHANNELS[i],CHANNELS[i+1],model.layers[i]);
  }
  const pooled = new Float32Array(48*16);
  for (let channel = 0; channel < 48; channel++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const start = channel*64+y*16+x*2;
        pooled[channel*16+y*4+x] =
          (features[start]+features[start+1]+features[start+8]+features[start+9])/4;
      }
    }
  }
  const logits = Array.from(model.bias,(value,i) => {
    for (let j = 0; j < pooled.length; j++) value += pooled[j]*model.weights[i*pooled.length+j];
    return value;
  });
  const max = Math.max(...logits);
  const raw = logits.map(value => Math.exp(value-max));
  const sum = raw.reduce((a,b) => a+b,0);
  const best = logits.indexOf(max);
  return {label:LABELS[best],score:raw[best]/sum,logits};
}

export async function classifySketch(strokes, width, height) {
  loading ??= fetch(new URL('./assets/sketch-cnn-v1.bin',import.meta.url))
    .then(response => {
      if (!response.ok) throw new Error('The sketch classifier could not load.');
      return response.arrayBuffer();
    })
    .then(readWeights)
    .catch(error => { loading = null; throw error; });
  const [{cv},model] = await Promise.all([loadRasterizer(),loading]);
  return predictRaster(rasterizeSketch(cv,strokes,width,height),model);
}
