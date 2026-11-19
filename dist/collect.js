import {createDrawing} from './drawing.js';

const byId = id => document.getElementById(id);
const save = byId('save');
const exportData = byId('export-data');
const label = byId('label');
const status = byId('collection-status');
const prefix = 'airdraft.sketch.v1.';
const labels = Array.from(label.options);
let sessionId = crypto.randomUUID();
try {
  sessionId = sessionStorage.getItem('airdraft.collection.session') || sessionId;
  sessionStorage.setItem('airdraft.collection.session', sessionId);
} catch {
  // Storage is optional for the anonymous session ID.
}

const drawing = createDrawing((count, canUndo) => {
  byId('undo').disabled = !canUndo;
  save.disabled = byId('clear').disabled = count === 0;
});
byId('undo').addEventListener('click', () => drawing.undo());
byId('clear').addEventListener('click', () => drawing.replace([]));

function samples() {
  return Object.keys(localStorage)
    .filter(key => key.startsWith(prefix))
    .map(key => JSON.parse(localStorage.getItem(key)))
    .filter(Boolean)
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt));
}

function updateCounts(records) {
  const totals = new Map(labels.map(option => [option.value,0]));
  for (const {label} of records) totals.set(label, (totals.get(label) ?? 0) + 1);
  byId('counts').replaceChildren(...labels.flatMap(option => {
    const name = document.createElement('dt');
    const count = document.createElement('dd');
    name.textContent = option.text;
    count.textContent = totals.get(option.value);
    return [name,count];
  }));
  exportData.disabled = records.length === 0;
}

save.addEventListener('click', () => {
  if (!drawing.strokes.length) return;
  const canvas = byId('sketch');
  const record = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    sessionId,
    label: label.value,
    canvas: {width:canvas.clientWidth,height:canvas.clientHeight},
    strokes: drawing.strokes.map(points => ({
      source: drawing.sourceOf(points),
      points: points.map(point => point.map(coordinate => Number(coordinate.toFixed(5))))
    }))
  };
  try {
    localStorage.setItem(prefix + record.id, JSON.stringify(record));
  } catch {
    status.textContent = 'Could not save. Browser storage may be full or blocked. Your sketch is still on the canvas.';
    return;
  }
  drawing.replace([]);
  status.textContent = 'Saved ' + label.selectedOptions[0].text.toLowerCase() + ' sketch.';
  refresh();
});

exportData.addEventListener('click', () => {
  let records;
  try {
    records = samples();
  } catch {
    status.textContent = 'Browser storage is unavailable. The dataset could not be exported.';
    return;
  }
  if (!records.length) return;
  const dataset = {
    format: 'airdraft-sketches-v1',
    coordinates: 'Normalized canvas x,y. Origin at top-left.',
    samples: records
  };
  const blob = new Blob([JSON.stringify(dataset)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'airdraft-sketches-' + new Date().toISOString().slice(0,10) + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  status.textContent = 'Exported ' + records.length + (records.length === 1 ? ' sketch.' : ' sketches.');
});

function refresh() {
  try {
    updateCounts(samples());
  } catch {
    updateCounts([]);
    status.textContent = 'This browser could not read the saved dataset.';
  }
}

window.addEventListener('storage', event => {
  if (event.key === null || event.key.startsWith(prefix)) refresh();
});
refresh();
