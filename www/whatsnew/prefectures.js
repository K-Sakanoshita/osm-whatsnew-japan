const prefectureElement = document.querySelector('#prefecture');
const daysElement = document.querySelector('#days');
const fromElement = document.querySelector('#from');
const toElement = document.querySelector('#to');
const statusElement = document.querySelector('#status');
let prefectureFeatures = [];
let categoryRules = {};
let prefectureMap = null;
let currentReportRows = [];
let pendingNationalPoints = null;
const charts = {};
const nationalPointsCache = new Map();
const PREFECTURE_FILL_LAYER = 'prefecture-select-fill';
const PREFECTURE_SELECTED_LAYER = 'prefecture-selected-fill';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
const number = value => Number(value).toLocaleString('ja-JP');
const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : '0.0%';
const formatJstDateTime = value => {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Tokyo',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute} (JST)`;
};
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;

function downloadCsv(filename, rows) {
  const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`API error ${response.status}`); }
  if (!response.ok) throw new Error(data.error || `API error ${response.status}`);
  return data;
}

async function fetchJsonc(url) {
  const response = await fetch(url);
  const source = await response.text();
  return JSON.parse(source.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n'));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0]) && !polygon.slice(1).some(hole => pointInRing(point, hole));
}

function contains(feature, point) {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
}

function bounds(feature) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = value => {
    if (typeof value[0] === 'number') {
      result[0] = Math.min(result[0], value[0]); result[1] = Math.min(result[1], value[1]);
      result[2] = Math.max(result[2], value[0]); result[3] = Math.max(result[3], value[1]);
    } else value.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  return result;
}

function renderPrefectureColors(points) {
  pendingNationalPoints = points;
  const counts = new Map(prefectureFeatures.map(feature => [feature.properties.P, 0]));
  points.forEach(row => {
    const point = [Number(row.lon), Number(row.lat)];
    const feature = prefectureFeatures.find(candidate => {
      const box = candidate._bounds || (candidate._bounds = bounds(candidate));
      return point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3] && contains(candidate, point);
    });
    if (!feature) return;
    const name = feature.properties.P;
    counts.set(name, counts.get(name) + 1);
  });

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'ja'));
  const positiveCount = ranked.filter(([, count]) => count > 0).length;
  const rankByName = new Map(ranked.map(([name], index) => [name, index + 1]));
  const intensityByName = new Map();
  ranked.forEach(([name, count], index) => {
    if (!count) intensityByName.set(name, 0);
    else if (positiveCount <= 1) intensityByName.set(name, 1);
    else intensityByName.set(name, 0.12 + 0.88 * (positiveCount - index - 1) / (positiveCount - 1));
  });

  prefectureFeatures.forEach(feature => {
    const name = feature.properties.P;
    feature.properties.updateCount = counts.get(name) || 0;
    feature.properties.updateRank = rankByName.get(name) || 47;
    feature.properties.updateIntensity = intensityByName.get(name) || 0;
  });

  const source = prefectureMap?.getSource('prefecture-boundaries');
  if (source) source.setData({type: 'FeatureCollection', features: prefectureFeatures});
}

async function loadNationalPoints() {
  const key = `${fromElement.value}:${toElement.value}`;
  if (!nationalPointsCache.has(key)) {
    const query = new URLSearchParams({from: fromElement.value, to: toElement.value});
    nationalPointsCache.set(key, fetchJson(`prefecture-map-api.php?${query}`).then(data => data.points));
  }
  return nationalPointsCache.get(key);
}

function selectedPrefectureName() {
  return prefectureFeatures[Number(prefectureElement.value)]?.properties?.P || '';
}

function updateMapSelection() {
  if (!prefectureMap?.getLayer(PREFECTURE_SELECTED_LAYER)) return;
  prefectureMap.setFilter(PREFECTURE_SELECTED_LAYER, ['==', ['get', 'P'], selectedPrefectureName()]);
}

function initializePrefectureMap(geojson) {
  prefectureMap = new maplibregl.Map({
    container: 'prefecture-map',
    center: [137.2, 36.2],
    zoom: 4.15,
    fadeDuration: 0,
    style: {
      version: 8,
      sources: {},
      layers: [{
        id: 'sea-background',
        type: 'background',
        paint: {'background-color': '#75bde8'},
      }],
    },
  });
  prefectureMap.addControl(new maplibregl.NavigationControl(), 'top-right');
  prefectureMap.on('load', () => {
    prefectureMap.addSource('prefecture-boundaries', {type: 'geojson', data: geojson});
    prefectureMap.addLayer({
      id: PREFECTURE_FILL_LAYER,
      type: 'fill',
      source: 'prefecture-boundaries',
      paint: {
        'fill-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'updateIntensity'], 0],
          0, '#d8efdd',
          0.35, '#91cf9b',
          0.7, '#f5c05e',
          1, '#f08024',
        ],
        'fill-opacity': 0.96,
        'fill-outline-color': '#35674f',
      },
    });
    prefectureMap.addLayer({
      id: PREFECTURE_SELECTED_LAYER,
      type: 'line',
      source: 'prefecture-boundaries',
      filter: ['==', ['get', 'P'], selectedPrefectureName()],
      paint: {'line-color': '#7b2d00', 'line-width': 3},
    });
    prefectureMap.on('click', PREFECTURE_FILL_LAYER, event => {
      const name = event.features?.[0]?.properties?.P;
      const index = prefectureFeatures.findIndex(feature => feature.properties.P === name);
      if (index < 0) return;
      prefectureElement.value = String(index);
      updateMapSelection();
      loadReport();
    });
    prefectureMap.on('mouseenter', PREFECTURE_FILL_LAYER, () => { prefectureMap.getCanvas().style.cursor = 'pointer'; });
    prefectureMap.on('mouseleave', PREFECTURE_FILL_LAYER, () => { prefectureMap.getCanvas().style.cursor = ''; });
    if (pendingNationalPoints) renderPrefectureColors(pendingNationalPoints);
  });
}

function countBy(rows, keyBuilder) {
  const counts = new Map();
  rows.forEach(row => {
    const key = keyBuilder(row);
    const current = counts.get(key) || {key, count: 0, row};
    current.count++;
    counts.set(key, current);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key), 'ja'));
}

function categoryName(row) {
  return categoryRules[row.type]?.[row.value] || row.value || '不明';
}

function renderHorizontalChart(id, entries, labelBuilder, datasetLabel) {
  charts[id]?.destroy();
  const top = entries.slice(0, 10);
  charts[id] = new Chart(document.querySelector(`#${id}`), {
    type: 'bar',
    data: {
      labels: top.map(labelBuilder),
      datasets: [{label: datasetLabel, data: top.map(entry => entry.count), backgroundColor: '#1b8d70'}],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {legend: {display: false}},
      scales: {x: {beginAtZero: true, ticks: {precision: 0}}},
    },
  });
}

function buildDailyRows(rows) {
  const daily = new Map();
  rows.forEach(row => {
    const date = String(row.date).slice(0, 10);
    const item = daily.get(date) || {date, create: 0, modify: 0};
    item[row.action === 'create' ? 'create' : 'modify']++;
    daily.set(date, item);
  });
  return [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function renderDailyChart(dailyRows) {
  charts['daily-chart']?.destroy();
  charts['daily-chart'] = new Chart(document.querySelector('#daily-chart'), {
    type: 'bar',
    data: {
      labels: dailyRows.map(row => row.date.replace(/-/g, '/')),
      datasets: [
        {label: '新規', data: dailyRows.map(row => row.create), backgroundColor: '#1b8d70'},
        {label: '変更', data: dailyRows.map(row => row.modify), backgroundColor: '#f29f24'},
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {x: {stacked: true}, y: {stacked: true, beginAtZero: true, ticks: {precision: 0}}},
    },
  });
}

function render(rows) {
  currentReportRows = rows;
  const total = rows.length;
  const creates = rows.filter(row => row.action === 'create').length;
  const mapperRows = countBy(rows, row => row.editorUid || row.editorName || 'unknown');
  document.querySelector('#total').textContent = `${number(total)}件`;
  document.querySelector('#creates').textContent = `${number(creates)}件`;
  document.querySelector('#modifies').textContent = `${number(total - creates)}件`;
  document.querySelector('#mappers').textContent = `${number(mapperRows.length)}人`;
  document.querySelector('#named-rate').textContent = percent(rows.filter(row => row.name).length, total);

  const categories = countBy(rows, row => `${row.type}=${row.value}`);
  renderHorizontalChart('category-chart', categories, entry => categoryName(entry.row), '更新ノード数');
  document.querySelector('#category-table').innerHTML = categories.slice(0, 100).map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(categoryName(entry.row))}<br><small>${escapeHtml(entry.key)}</small></td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');

  document.querySelector('#mapper-table').innerHTML = mapperRows.slice(0, 100).map((entry, index) => {
    const name = entry.row.editorName || '不明';
    const label = entry.row.editorUid ? `${name} (${entry.row.editorUid})` : name;
    const linked = name === '不明' ? escapeHtml(label) : `<a href="https://www.openstreetmap.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    return `<tr><td>${index + 1}</td><td>${linked}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`;
  }).join('');
  renderHorizontalChart('mapper-chart', mapperRows, entry => entry.row.editorName || '不明', '更新ノード数');

  const dailyRows = buildDailyRows(rows);
  renderDailyChart(dailyRows);
  document.querySelector('#daily-table').innerHTML = dailyRows.map(row =>
    `<tr><td>${escapeHtml(row.date.replace(/-/g, '/'))}</td><td>${number(row.create)}</td><td>${number(row.modify)}</td><td>${number(row.create + row.modify)}</td></tr>`).join('');

  const changesets = countBy(rows.filter(row => row.changeset), row => row.changeset);
  renderHorizontalChart('changeset-chart', changesets, entry => `#${entry.key}`, '更新ノード数');
  document.querySelector('#changeset-table').innerHTML = changesets.slice(0, 100).map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');
}

async function loadReport() {
  statusElement.textContent = '集計中…';
  document.querySelector('#prefecture-csv').hidden = true;
  try {
    const feature = prefectureFeatures[Number(prefectureElement.value)];
    if (!feature || !fromElement.value || !toElement.value || fromElement.value > toElement.value) throw new Error('集計条件を正しく選択してください。');
    const box = bounds(feature);
    const query = new URLSearchParams({from: fromElement.value, to: toElement.value, minLon: box[0], minLat: box[1], maxLon: box[2], maxLat: box[3]});
    const [data, nationalPoints] = await Promise.all([
      fetchJson(`prefectures-api.php?${query}`),
      loadNationalPoints(),
    ]);
    const rows = data.rows.filter(row => contains(feature, [Number(row.lon), Number(row.lat)]));
    render(rows);
    renderPrefectureColors(nationalPoints);
    const name = feature.properties.P;
    document.querySelector('#report-title').textContent = `${name}の更新ノードレポート`;
    document.querySelector('#period').textContent = `集計期間：${formatJstDateTime(data.periodStart)} ～ ${formatJstDateTime(data.periodEnd)}`;
    statusElement.textContent = `${number(rows.length)}件を集計`;
    document.querySelector('#prefecture-csv').hidden = false;
    updateMapSelection();
  } catch (error) {
    statusElement.textContent = `取得できませんでした: ${error.message}`;
  }
}

function formatInputDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function applyPresetDates() {
  const end = new Date(); const start = new Date(end);
  start.setDate(start.getDate() - Number(daysElement.value));
  fromElement.value = formatInputDate(start); toElement.value = formatInputDate(end); fromElement.max = toElement.value;
}

async function initialize() {
  applyPresetDates();
  const [geojson, categories] = await Promise.all([fetchJson('data/prefectures.min.geojson'), fetchJsonc('data/category-ja.jsonc')]);
  prefectureFeatures = geojson.features.sort((a, b) => a.properties.P.localeCompare(b.properties.P, 'ja'));
  categoryRules = categories.category || {};
  prefectureElement.innerHTML = prefectureFeatures.map((feature, index) => `<option value="${index}"${feature.properties.P === '東京都' ? ' selected' : ''}>${escapeHtml(feature.properties.P)}</option>`).join('');
  initializePrefectureMap(geojson);
  await loadReport();
}

daysElement.addEventListener('change', applyPresetDates);
prefectureElement.addEventListener('change', () => { updateMapSelection(); loadReport(); });
toElement.addEventListener('change', () => { fromElement.max = toElement.value; });
document.querySelector('#filter').addEventListener('submit', event => { event.preventDefault(); loadReport(); });
document.querySelector('#prefecture-csv').addEventListener('click', event => {
  event.preventDefault();
  const total = currentReportRows.length;
  const output = [['区分', '順位・日付', '名称', '補足', '件数', '割合']];
  countBy(currentReportRows, row => `${row.type}=${row.value}`).forEach((entry, index) => output.push(['代表タグ', index + 1, categoryName(entry.row), entry.key, entry.count, percent(entry.count, total)]));
  countBy(currentReportRows, row => row.editorUid || row.editorName || 'unknown').forEach((entry, index) => output.push(['マッパー', index + 1, entry.row.editorName || '不明', entry.row.editorUid || '', entry.count, percent(entry.count, total)]));
  buildDailyRows(currentReportRows).forEach(entry => {
    const count = entry.create + entry.modify;
    output.push(['日別更新', entry.date, '', `新規${entry.create}件・変更${entry.modify}件`, count, percent(count, total)]);
  });
  countBy(currentReportRows.filter(row => row.changeset), row => row.changeset).forEach((entry, index) => output.push(['変更セット', index + 1, entry.key, entry.row.editorName || '不明', entry.count, percent(entry.count, total)]));
  const safeName = selectedPrefectureName().replace(/[\\/:*?"<>|]/g, '_');
  downloadCsv(`osm-${safeName}_${fromElement.value}_${toElement.value}.csv`, output);
});
initialize().catch(error => { statusElement.textContent = `取得できませんでした: ${error.message}`; });
