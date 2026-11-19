const byId = id => document.getElementById(id);
const fileInput = byId('dataset-file');
const canvas = byId('review-sketch');
const context = canvas.getContext('2d');
const label = byId('review-label');
const status = byId('review-status');
const options = new Map(Array.from(label.options, option => [option.value,option.text]));
const format = 'airdraft-sketches-v1';
let records = [];
let decisions = [];
let index = 0;

function isSample(sample) {
  const dimension = value => Number.isFinite(value) && value > 0 && value <= 100000;
  const coordinate = value => Number.isFinite(value) && value >= 0 && value <= 1;
  return options.has(sample?.label) && dimension(sample.canvas?.width) && dimension(sample.canvas?.height) &&
    Array.isArray(sample.strokes) && sample.strokes.length > 0 &&
    sample.strokes.every(stroke => Array.isArray(stroke?.points) && stroke.points.length > 0 &&
      stroke.points.every(point => Array.isArray(point) && point.length === 2 && point.every(coordinate)));
}

function paint() {
  const width = canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  const height = canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  const sample = records[index];
  if (!sample || !width || !height) return;
  const scale = .88 * Math.min(width/sample.canvas.width, height/sample.canvas.height);
  const w = sample.canvas.width * scale;
  const h = sample.canvas.height * scale;
  const at = ([x,y]) => [(width-w)/2+x*w,(height-h)/2+y*h];
  context.strokeStyle = context.fillStyle = '#cabaff';
  context.lineWidth = 4 * devicePixelRatio;
  context.lineCap = context.lineJoin = 'round';
  for (const {points} of sample.strokes) {
    context.beginPath();
    if (points.length === 1) {
      context.arc(...at(points[0]),context.lineWidth/2,0,Math.PI*2);
      context.fill();
      continue;
    }
    context.moveTo(...at(points[0]));
    for (const point of points.slice(1)) context.lineTo(...at(point));
    context.stroke();
  }
}

function render() {
  const sample = records[index];
  const decision = decisions[index];
  byId('sample-title').textContent = sample ? 'Sketch ' + (index+1) + ' of ' + records.length : 'Drawing preview';
  byId('sample-controls').hidden = !sample;
  byId('previous').disabled = index === 0;
  byId('next').disabled = index >= records.length-1;
  if (sample) {
    const state = decision ? (decision.excluded ? 'Excluded' : 'Approved') : 'Unreviewed';
    byId('original-label').textContent = 'Original label: ' + options.get(sample.label) + ' · ' + state;
    label.value = decision?.label ?? sample.label;
  }
  const approved = decisions.filter(decision => decision && !decision.excluded).length;
  const excluded = decisions.filter(decision => decision?.excluded).length;
  byId('review-counts').textContent = records.length
    ? approved + ' approved · ' + excluded + ' excluded · ' + (records.length-approved-excluded) + ' unreviewed'
    : '';
  byId('export-reviewed').disabled = approved === 0;
  paint();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.disabled = true;
  try {
    const dataset = JSON.parse(await file.text());
    if (dataset?.format !== format || !Array.isArray(dataset.samples) || !dataset.samples.every(isSample)) {
      throw new Error('Unexpected dataset format');
    }
    records = dataset.samples;
    decisions = new Array(records.length).fill(null);
    index = 0;
    status.textContent = records.length ? 'Dataset loaded. Review each sketch before exporting.' : 'This dataset contains no sketches.';
    render();
  } catch {
    status.textContent = 'Could not open this file. Choose a valid AirDraft dataset JSON.';
  } finally {
    fileInput.value = '';
    fileInput.disabled = false;
  }
});

function move(delta) {
  index = Math.max(0,Math.min(records.length-1,index+delta));
  render();
}
byId('previous').addEventListener('click', () => move(-1));
byId('next').addEventListener('click', () => move(1));

function decide(excluded) {
  decisions[index] = {label:label.value,excluded};
  status.textContent = excluded ? 'Sketch excluded.' : 'Sketch approved as ' + options.get(label.value) + '.';
  move(1);
}
byId('approve').addEventListener('click', () => decide(false));
byId('exclude').addEventListener('click', () => decide(true));
byId('export-reviewed').addEventListener('click', () => {
  const samples = records.flatMap((sample,i) => {
    const decision = decisions[i];
    return decision && !decision.excluded ? [{...sample,label:decision.label}] : [];
  });
  if (!samples.length) return;
  const dataset = {format,coordinates:'Normalized canvas x,y. Origin at top-left.',samples};
  const url = URL.createObjectURL(new Blob([JSON.stringify(dataset)],{type:'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'airdraft-reviewed-' + new Date().toISOString().slice(0,10) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  status.textContent = 'Exported ' + samples.length + (samples.length === 1 ? ' reviewed sketch.' : ' reviewed sketches.');
});
new ResizeObserver(paint).observe(canvas);
