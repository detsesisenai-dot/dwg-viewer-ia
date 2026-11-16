import { Viewer } from './viewer.js';
import { buildScene, pointInRing } from './scene.js';

const $ = (id) => document.getElementById(id);

// INSUNITS → metros por unidade
const INSUNITS = { 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 14: 0.1 };
const UNIT_LABEL = { 0.001: 'mm', 0.01: 'cm', 0.1: 'dm', 1: 'm', 1000: 'km', 0.0254: 'in', 0.3048: 'ft', 0: 'u' };
const MAX_LIST = 400;

const nf = (d = 2) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt2 = nf(2), fmt3 = nf(3), fmt0 = nf(0);

const state = {
  scene: null,
  file: null,
  unit: 1, // metros por unidade do desenho (0 = sem unidade)
  selected: null
};

const viewer = new Viewer($('canvas'), {
  onPointer: (p) => {
    $('coords').textContent = `X: ${fmt3.format(p.x)}   Y: ${fmt3.format(p.y)}`;
  },
  onClick: (p) => {
    const hit = filteredPolygons(true)
      .filter((poly) => p.x >= poly.bbox.minX && p.x <= poly.bbox.maxX && p.y >= poly.bbox.minY && p.y <= poly.bbox.maxY)
      .filter((poly) => pointInRing(p.x, p.y, poly.outer ?? poly.rings[0]))
      .sort((a, b) => a.area - b.area)[0];
    selectPolygon(hit ?? null, false);
  }
});

// ---------- Worker de leitura
const worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
let jobId = 0;
const jobs = new Map();
worker.onmessage = (e) => {
  const { id, status, db, error } = e.data;
  const job = jobs.get(id);
  if (!job) return;
  if (status) return setLoading(status);
  jobs.delete(id);
  error ? job.reject(new Error(error)) : job.resolve(db);
};
worker.onerror = (e) => {
  for (const job of jobs.values()) job.reject(new Error(e.message || 'Falha no worker'));
  jobs.clear();
};

function parseFile(buffer, fileName) {
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, buffer, fileName }, [buffer]);
  });
}

// ---------- Carregamento
async function loadFile(file) {
  if (!file) return;
  if (!/\.(dwg|dxf)$/i.test(file.name)) {
    alert('Selecione um arquivo .dwg ou .dxf.');
    return;
  }
  state.file = file;
  $('fileName').textContent = file.name;
  setLoading('Lendo arquivo…');
  try {
    const buffer = await file.arrayBuffer();
    state.version = detectVersion(buffer);
    const db = await parseFile(buffer, file.name);
    setLoading('Montando geometria…');
    await new Promise((r) => setTimeout(r, 0));
    const scene = buildScene(db);
    state.scene = scene;
    state.selected = null;
    state.unit = INSUNITS[scene.header.INSUNITS] ?? 1;
    viewer.hiddenLayers = new Set(scene.layers.filter((l) => !l.visible).map((l) => l.name));
    viewer.setScene(scene);
    $('dropzone').classList.add('hidden');
    $('toolbar').hidden = false;
    $('statusbar').hidden = false;
    renderPanel();
  } catch (err) {
    console.error(err);
    alert(`Não foi possível abrir "${file.name}".\n\n${err.message}`);
    $('fileName').textContent = state.scene ? $('fileName').textContent : 'Nenhum arquivo carregado';
  } finally {
    setLoading(null);
  }
}

function setLoading(text) {
  $('loading').hidden = !text;
  if (text) $('loadingText').textContent = text;
}

for (const id of ['fileInput', 'fileInput2']) {
  $(id).addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = '';
  });
}

// Arrastar e soltar em qualquer ponto da janela
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  $('dropzone').classList.remove('hidden');
  $('dropzone').classList.add('active');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) endDrag();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  endDrag();
  loadFile(e.dataTransfer?.files?.[0]);
});
function endDrag() {
  dragDepth = 0;
  $('dropzone').classList.remove('active');
  if (state.scene) $('dropzone').classList.add('hidden');
}

// ---------- Navegação
$('zoomIn').onclick = () => viewer.zoomAt(1.4);
$('zoomOut').onclick = () => viewer.zoomAt(1 / 1.4);
$('zoomFit').onclick = () => viewer.fit();
window.addEventListener('keydown', (e) => {
  if (!state.scene || e.target.matches('input, select, textarea')) return;
  if (e.key === '+' || e.key === '=') viewer.zoomAt(1.4);
  else if (e.key === '-') viewer.zoomAt(1 / 1.4);
  else if (e.key.toLowerCase() === 'f') viewer.fit();
  else if (e.key === 'Escape') selectPolygon(null);
});

// ---------- Unidades e formatação
const unitLabel = () => UNIT_LABEL[state.unit] === 'u' || !state.unit ? 'u' : 'm';
function fmtArea(a) {
  if (!state.unit) return `${fmt2.format(a)} u²`;
  return `${fmt2.format(a * state.unit * state.unit)} m²`;
}
function fmtLen(l) {
  if (!state.unit) return `${fmt2.format(l)} u`;
  return `${fmt2.format(l * state.unit)} m`;
}

// ---------- Painel
function filteredPolygons(ignoreList = false) {
  const { scene } = state;
  if (!scene) return [];
  const layer = $('layerFilter').value;
  const blocks = $('includeBlocks').checked;
  const hatch = $('includeHatch').checked;
  let list = scene.polygons.filter((p) =>
    (blocks || p.source === 'modelo') &&
    (hatch || !p.type.startsWith('Hachura')) &&
    (!layer || p.layer === layer) &&
    !viewer.hiddenLayers.has(p.layer)
  );
  if (ignoreList) return list;
  const sort = $('sortSelect').value;
  list = list.slice().sort((a, b) =>
    sort === 'area-asc' ? a.area - b.area :
    sort === 'layer' ? a.layer.localeCompare(b.layer, 'pt-BR', { numeric: true }) || b.area - a.area :
    b.area - a.area
  );
  return list;
}

function renderPanel() {
  const { scene, file } = state;
  $('panelEmpty').hidden = true;
  $('panelContent').hidden = false;

  const h = scene.header;
  const bb = scene.bbox;
  const ins = h.INSUNITS;
  $('fileInfo').innerHTML = kv([
    ['Nome', escapeHtml(file.name)],
    ['Tamanho', `${fmt2.format(file.size / 1024 / 1024)} MB`],
    ['Versão', escapeHtml(state.version || h.ACADVER || '—')],
    ['Extensão (X)', `${fmt3.format(bb.minX)} → ${fmt3.format(bb.maxX)}`],
    ['Extensão (Y)', `${fmt3.format(bb.minY)} → ${fmt3.format(bb.maxY)}`]
  ]);
  $('unitSelect').value = String(state.unit);
  $('unitNote').textContent = INSUNITS[ins]
    ? `Unidade lida do arquivo (INSUNITS = ${ins}).`
    : 'O arquivo não define unidade (INSUNITS). Assumido metro — ajuste se necessário.';

  // Filtro de layers (apenas layers que têm polígonos)
  const polyLayers = [...new Set(scene.polygons.map((p) => p.layer))].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
  $('layerFilter').innerHTML = '<option value="">Todos os layers</option>' +
    polyLayers.map((l) => `<option>${escapeHtml(l)}</option>`).join('');

  renderLayers();
  renderTypes();
  renderPolygons();
  renderSelected();
}

function renderStats(list) {
  const { scene } = state;
  const totalEntities = Object.values(scene.counts).reduce((a, b) => a + b, 0);
  const total = list.reduce((s, p) => s + p.area, 0);
  $('stats').innerHTML = [
    ['Entidades', fmt0.format(totalEntities)],
    ['Layers', fmt0.format(scene.layers.length)],
    ['Polígonos', fmt0.format(list.length)],
    ['Área somada', fmtArea(total)]
  ].map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
}

function renderPolygons() {
  const list = filteredPolygons();
  renderStats(list);
  const total = list.reduce((s, p) => s + p.area, 0);
  $('polyTotal').innerHTML = list.length
    ? `<span>${fmt0.format(list.length)} polígono(s)</span><strong>${fmtArea(total)}</strong>`
    : '<span class="muted">Nenhum polígono fechado encontrado com esses filtros.</span>';

  const shown = list.slice(0, MAX_LIST);
  $('polyList').innerHTML = shown.map((p) => `
    <li data-id="${p.id}" class="${state.selected?.id === p.id ? 'sel' : ''}">
      <i class="swatch" style="background:${p.color}"></i>
      <div class="pl-main">
        <div class="pl-area">${fmtArea(p.area)}</div>
        <div class="pl-meta">${escapeHtml(p.type)} · ${escapeHtml(p.layer)}</div>
      </div>
      <div class="pl-per" title="Perímetro">${fmtLen(p.perimeter)}</div>
    </li>`).join('') +
    (list.length > MAX_LIST ? `<li class="more muted">+ ${fmt0.format(list.length - MAX_LIST)} polígonos (use o filtro de layer ou exporte CSV)</li>` : '');
}

$('polyList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  selectPolygon(state.scene.polygons[Number(li.dataset.id)], true);
});

function selectPolygon(poly, zoom = false) {
  state.selected = poly;
  viewer.select(poly);
  if (poly && zoom) {
    const b = poly.bbox;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    viewer.fit({ minX: b.minX - w, maxX: b.maxX + w, minY: b.minY - h, maxY: b.maxY + h }, 0.05);
  }
  renderSelected();
  for (const li of $('polyList').querySelectorAll('li[data-id]')) {
    li.classList.toggle('sel', Number(li.dataset.id) === poly?.id);
  }
}

function renderSelected() {
  const p = state.selected;
  $('selectedCard').hidden = !p;
  if (!p) return;
  const rows = [
    ['Tipo', escapeHtml(p.type)],
    ['Layer', escapeHtml(p.layer)],
    ['Área', `<strong>${fmtArea(p.area)}</strong>`],
    ['Perímetro', fmtLen(p.perimeter)],
    ['Centroide', `${fmt3.format(p.centroid.x)}; ${fmt3.format(p.centroid.y)}`],
    ['Largura × altura', `${fmtLen(p.bbox.maxX - p.bbox.minX)} × ${fmtLen(p.bbox.maxY - p.bbox.minY)}`]
  ];
  if (p.vertices) rows.push(['Vértices', fmt0.format(p.vertices)]);
  if (p.rings.length > 1) rows.push(['Contornos', `${p.rings.length} (furos descontados)`]);
  rows.push(['Origem', p.source === 'modelo' ? 'Espaço do modelo' : 'Dentro de bloco'], ['Handle', escapeHtml(p.handle ?? '—')]);
  $('selectedInfo').innerHTML = kv(rows);
}
$('clearSel').onclick = () => selectPolygon(null);

function renderLayers() {
  const { scene } = state;
  $('layerCount').textContent = `(${scene.layers.length})`;
  $('layerList').innerHTML = scene.layers.map((l) => `
    <li>
      <label>
        <input type="checkbox" data-layer="${escapeHtml(l.name)}" ${viewer.hiddenLayers.has(l.name) ? '' : 'checked'} />
        <i class="swatch" style="background:${l.color}"></i>
        <span class="ln">${escapeHtml(l.name)}</span>
        <span class="muted">${fmt0.format(l.count)}</span>
      </label>
    </li>`).join('');
}

$('layerList').addEventListener('change', (e) => {
  const name = e.target.dataset.layer;
  if (name == null) return;
  viewer.setLayerVisible(name, e.target.checked);
  renderPolygons();
});
function setAllLayers(visible) {
  for (const l of state.scene.layers) viewer.setLayerVisible(l.name, visible);
  renderLayers();
  renderPolygons();
}
$('layersAll').onclick = () => setAllLayers(true);
$('layersNone').onclick = () => setAllLayers(false);

function renderTypes() {
  const { counts, unsupported } = state.scene;
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $('typeList').innerHTML = rows.map(([t, n]) =>
    `<li><span>${escapeHtml(t)}${unsupported[t] ? ' <em class="muted">(não desenhado)</em>' : ''}</span><strong>${fmt0.format(n)}</strong></li>`
  ).join('');
}

for (const id of ['layerFilter', 'sortSelect', 'includeBlocks', 'includeHatch']) {
  $(id).addEventListener('change', renderPolygons);
}
$('unitSelect').addEventListener('change', (e) => {
  state.unit = Number(e.target.value);
  renderPolygons();
  renderSelected();
});

// ---------- Exportação
$('exportCsv').onclick = () => {
  const list = filteredPolygons();
  const u = unitLabel();
  const f = state.unit || 1;
  const head = ['id', 'tipo', 'layer', 'handle', `area_${u}2`, `perimetro_${u}`, 'centroide_x', 'centroide_y', 'origem'];
  const rows = list.map((p) => [
    p.id, p.type, p.layer, p.handle ?? '',
    (p.area * f * f).toFixed(4), (p.perimeter * f).toFixed(4),
    p.centroid.x.toFixed(4), p.centroid.y.toFixed(4), p.source
  ]);
  const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.file.name.replace(/\.[^.]+$/, '')}-areas.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Utilitários
const ACAD_VERSIONS = {
  AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018'
};
function detectVersion(buffer) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
  const m = head.slice(0, 6).match(/^AC\d{4}$/) ? head.slice(0, 6) : head.match(/\$ACADVER\s+1\s+(AC\d{4})/)?.[1];
  return m ? `${ACAD_VERSIONS[m] ?? 'Desconhecida'} (${m})` : null;
}

function kv(rows) {
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
