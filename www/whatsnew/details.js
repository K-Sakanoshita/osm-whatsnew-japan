const nationwideButton = document.querySelector('#show-nationwide');
const daysElement = document.querySelector('#days');
const fromElement = document.querySelector('#from');
const toElement = document.querySelector('#to');
const statusElement = document.querySelector('#status');
let prefectureFeatures = [];
let selectedPrefecture = '';
let categoryRules = {};
let prefectureMap = null;
let currentReportRows = [];
let currentNationwideData = null;
let pendingPrefectureCounts = null;
const charts = {};
const CREATE_COLOR = '#177866';
const MODIFY_COLOR = '#c45f32';
const prefectureCountsCache = new Map();
const PREFECTURE_FILL_LAYER = 'prefecture-select-fill';
const PREFECTURE_SELECTED_LAYER = 'prefecture-selected-fill';
const PREFECTURE_NAME_EXPRESSION = ['coalesce', ['get', 'name:ja'], ['get', 'name']];
const prefectureName = feature => String(feature?.properties?.['name:ja'] || feature?.properties?.name || '');

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]));
const number = value => Number(value).toLocaleString('ja-JP');
const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : '0.0%';
function updateTotalSummary(total, creates, modifies) {
  const element = document.querySelector('#total');
  const main = document.createElement('span');
  main.className = 'summary-total-main';
  main.textContent = `${number(total)}件`;
  const detail = document.createElement('span');
  detail.className = 'summary-total-detail';
  detail.textContent = `（新規${number(creates)}件/更新${number(modifies)}件）`;
  element.replaceChildren(main, document.createTextNode(' '), detail);
}

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

async function fetchAllPois(baseQuery) {
  const rows = [];
  let cursor = '';
  let meta = null;
  for (let request = 1; request <= 50; request++) {
    const query = new URLSearchParams(baseQuery);
    query.set('mode', 'pois');
    query.set('limit', '2000');
    if (cursor) query.set('cursor', cursor);
    const data = await fetchJson(`api.php?${query}`);
    meta = data.meta;
    const batch = Array.isArray(data.items) ? data.items : [];
    rows.push(...batch.map(item => ({
      ...item,
      osmType: item.type,
      type: item.type2,
      value: item.kind,
    })));
    cursor = String(data.meta?.nextCursor || '');
    if (!cursor) return {meta, rows};
  }
  throw new Error('取得件数が100,000件を超えました。期間を短くしてください。');
}

function renderPrefectureColors(items) {
  pendingPrefectureCounts = items;
  const counts = new Map(prefectureFeatures.map(feature => [prefectureName(feature), 0]));
  items.forEach(row => {
    const name = String(row?.prefecture ?? '').trim();
    if (counts.has(name)) counts.set(name, Number(row.count) || 0);
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
    const name = prefectureName(feature);
    feature.properties.updateCount = counts.get(name) || 0;
    feature.properties.updateRank = rankByName.get(name) || 47;
    feature.properties.updateIntensity = intensityByName.get(name) || 0;
  });

  const source = prefectureMap?.getSource('prefecture-boundaries');
  if (source) source.setData({type: 'FeatureCollection', features: prefectureFeatures});
}

async function loadPrefectureCounts() {
  const key = `${fromElement.value}:${toElement.value}`;
  if (!prefectureCountsCache.has(key)) {
    const query = new URLSearchParams({
      mode: 'prefectures',
      from: fromElement.value,
      to: toElement.value,
    });
    prefectureCountsCache.set(key, fetchJson(`api.php?${query}`).then(data => data.items));
  }
  return prefectureCountsCache.get(key);
}

function selectedPrefectureName() {
  return selectedPrefecture;
}

function updateMapSelection() {
  nationwideButton.disabled = !selectedPrefecture;
  if (!prefectureMap?.getLayer(PREFECTURE_SELECTED_LAYER)) return;
  prefectureMap.setFilter(PREFECTURE_SELECTED_LAYER, ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture]);
}

function initializePrefectureMap(geojson) {
  prefectureMap = new maplibregl.Map({
    container: 'prefecture-map',
    center: [137.2, 36.2],
    zoom: 4.15,
    maxZoom: 7,
    maxBounds: [[118, 18], [158, 50]],
    fadeDuration: 0,
    style: './tiles/osmfj_nopoi.json',
  });
  prefectureMap.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  prefectureMap.on('load', () => {
    prefectureMap.addSource('prefecture-boundaries', {type: 'geojson', data: geojson});
    const firstSymbolLayer = prefectureMap.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
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
        'fill-opacity': 0.48,
        'fill-outline-color': '#35674f',
      },
    }, firstSymbolLayer);
    prefectureMap.addLayer({
      id: PREFECTURE_SELECTED_LAYER,
      type: 'line',
      source: 'prefecture-boundaries',
      filter: ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefectureName()],
      paint: {'line-color': '#7b2d00', 'line-width': 3},
    });
    prefectureMap.on('click', PREFECTURE_FILL_LAYER, event => {
      const name = prefectureName(event.features?.[0]);
      if (!name) return;
      selectedPrefecture = name;
      updateMapSelection();
      loadReport();
    });
    prefectureMap.on('mouseenter', PREFECTURE_FILL_LAYER, () => { prefectureMap.getCanvas().style.cursor = 'pointer'; });
    prefectureMap.on('mouseleave', PREFECTURE_FILL_LAYER, () => { prefectureMap.getCanvas().style.cursor = ''; });
    if (pendingPrefectureCounts) renderPrefectureColors(pendingPrefectureCounts);
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
  const start = new Date(fromElement.value + 'T00:00:00Z');
  const end = new Date(toElement.value + 'T00:00:00Z');
  if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end) {
    for (let time = start.getTime(); time <= end.getTime(); time += 24 * 60 * 60 * 1000) {
      const date = new Date(time).toISOString().slice(0, 10);
      daily.set(date, {date, create: 0, modify: 0});
    }
  }
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
        {label: '新規', data: dailyRows.map(row => row.create), backgroundColor: CREATE_COLOR},
        {label: '更新', data: dailyRows.map(row => row.modify), backgroundColor: MODIFY_COLOR},
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
  currentNationwideData = null;
  document.querySelector('#prefecture-ranking').hidden = true;
  document.querySelector('#changeset-ranking').hidden = false;
  currentReportRows = rows;
  const total = rows.length;
  const creates = rows.filter(row => row.action === 'create').length;
  const mapperRows = countBy(rows, row => row.editorUid || row.editorName || 'unknown');
  const changesets = countBy(rows.filter(row => row.changeset), row => row.changeset);
  updateTotalSummary(total, creates, total - creates);
  document.querySelector('#mappers').textContent = `${number(mapperRows.length)}人`;
  document.querySelector('#changesets').textContent = `${number(changesets.length)}件`;

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


  renderHorizontalChart('changeset-chart', changesets, entry => `#${entry.key}`, '更新ノード数');
  document.querySelector('#changeset-table').innerHTML = changesets.slice(0, 100).map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');
}

function buildAggregateDailyRows(rows) {
  const daily = new Map();
  const start = new Date(fromElement.value + 'T00:00:00Z');
  const end = new Date(toElement.value + 'T00:00:00Z');
  if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end) {
    for (let time = start.getTime(); time <= end.getTime(); time += 24 * 60 * 60 * 1000) {
      const date = new Date(time).toISOString().slice(0, 10);
      daily.set(date, {date, create: 0, modify: 0});
    }
  }
  rows.forEach(row => {
    const date = String(row.ranking_date || row.date).slice(0, 10);
    daily.set(date, {date, create: Number(row.creates) || 0, modify: Number(row.modifies) || 0});
  });
  return [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function renderNationwide(data) {
  currentReportRows = [];
  currentNationwideData = data;
  document.querySelector('#prefecture-ranking').hidden = false;
  document.querySelector('#changeset-ranking').hidden = false;

  const total = Number(data.total) || 0;
  const dailyRows = buildAggregateDailyRows(data.daily || []);
  const creates = dailyRows.reduce((sum, row) => sum + row.create, 0);
  const modifies = dailyRows.reduce((sum, row) => sum + row.modify, 0);
  const mapperCount = Number(data.mapperCount) || 0;
  const changesets = (data.changesets || []).map(row => ({key: row.changeset, count: Number(row.count) || 0, row: {editorName: row.editorName}}));
  updateTotalSummary(total, creates, modifies);
  document.querySelector('#mappers').textContent = `${number(mapperCount)}人`;
  document.querySelector('#changesets').textContent = `${number(Number(data.changesetCount) || 0)}件`;

  const prefectures = (data.prefectures || []).map(row => ({key: row.name, count: Number(row.count) || 0, row}));
  renderHorizontalChart('prefecture-chart', prefectures, entry => entry.row.name, '更新ノード数');
  document.querySelector('#prefecture-table').innerHTML = prefectures.map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(entry.row.name)}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');

  const categories = (data.categories || []).map(row => ({key: `${row.type}=${row.value}`, count: Number(row.count) || 0, row}));
  renderHorizontalChart('category-chart', categories, entry => categoryName(entry.row), '更新ノード数');
  document.querySelector('#category-table').innerHTML = categories.map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(categoryName(entry.row))}<br><small>${escapeHtml(entry.key)}</small></td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');

  const mappers = (data.mappers || []).map(row => ({key: row.uid || row.name, count: Number(row.count) || 0, row: {editorName: row.name, editorUid: row.uid}}));
  renderHorizontalChart('mapper-chart', mappers, entry => entry.row.editorName || '不明', '更新ノード数');
  document.querySelector('#mapper-table').innerHTML = mappers.map((entry, index) => {
    const name = entry.row.editorName || '不明';
    const label = entry.row.editorUid ? `${name} (${entry.row.editorUid})` : name;
    const linked = name === '不明' ? escapeHtml(label) : `<a href="https://www.openstreetmap.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    return `<tr><td>${index + 1}</td><td>${linked}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`;
  }).join('');

  renderHorizontalChart('changeset-chart', changesets, entry => `#${entry.key}`, '更新ノード数');
  document.querySelector('#changeset-table').innerHTML = changesets.map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');

  renderDailyChart(dailyRows);
  document.querySelector('#daily-table').innerHTML = dailyRows.map(row =>
    `<tr><td>${escapeHtml(row.date.replace(/-/g, '/'))}</td><td>${number(row.create)}</td><td>${number(row.modify)}</td><td>${number(row.create + row.modify)}</td></tr>`).join('');
}
async function loadReport() {
  statusElement.textContent = '集計中…';
  document.querySelector('#prefecture-csv').hidden = true;
  try {
    if (!fromElement.value || !toElement.value || fromElement.value > toElement.value) {
      throw new Error('集計条件を正しく選択してください。');
    }
    const name = selectedPrefectureName();
    const query = new URLSearchParams({
      from: fromElement.value,
      to: toElement.value,
    });
    if (name) query.set('prefecture', name);

    const nationwideQuery = new URLSearchParams(query);
    nationwideQuery.set('mode', 'japan');
    const reportRequest = name
      ? fetchAllPois(query)
      : fetchJson(`api.php?${nationwideQuery}`);
    const [data, prefectureCounts] = await Promise.all([reportRequest, loadPrefectureCounts()]);
    renderPrefectureColors(prefectureCounts);

    if (name) {
      render(data.rows);
      document.querySelector('#report-title').textContent = `${name}の更新ノードレポート`;
    } else {
      renderNationwide(data);
      document.querySelector('#report-title').textContent = '日本全国の更新ノード集計';
    }
    statusElement.textContent = '';
    document.querySelector('#period').textContent = `集計期間：${formatJstDateTime(data.meta.periodStart)} ～ ${formatJstDateTime(data.meta.periodEnd)}`;
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
  prefectureFeatures = geojson.features.sort((a, b) => prefectureName(a).localeCompare(prefectureName(b), 'ja'));
  categoryRules = categories.category || {};

  initializePrefectureMap(geojson);
  await loadReport();
}

nationwideButton.addEventListener('click', () => {
  selectedPrefecture = '';
  updateMapSelection();
  loadReport();
});
daysElement.addEventListener('change', () => { applyPresetDates(); loadReport(); });

fromElement.addEventListener('change', () => {
  if (fromElement.value > toElement.value) toElement.value = fromElement.value;
  loadReport();
});
toElement.addEventListener('change', () => {
  fromElement.max = toElement.value;
  if (fromElement.value > toElement.value) fromElement.value = toElement.value;
  loadReport();
});
document.querySelector('#filter').addEventListener('submit', event => { event.preventDefault(); loadReport(); });
document.querySelector('#prefecture-csv').addEventListener('click', event => {
  event.preventDefault();
  const output = [['区分', '順位・日付', '名称', '補足', '件数', '割合']];
  if (currentNationwideData) {
    const total = Number(currentNationwideData.total) || 0;
    (currentNationwideData.prefectures || []).forEach((row, index) => output.push(['都道府県', index + 1, row.name, '', row.count, percent(row.count, total)]));
    (currentNationwideData.categories || []).forEach((row, index) => output.push(['代表タグ', index + 1, categoryName(row), `${row.type}=${row.value}`, row.count, percent(row.count, total)]));
    (currentNationwideData.mappers || []).forEach((row, index) => output.push(['マッパー', index + 1, row.name, row.uid || '', row.count, percent(row.count, total)]));
    (currentNationwideData.changesets || []).forEach((row, index) => output.push(['変更セット', index + 1, row.changeset, row.editorName || '不明', row.count, percent(row.count, total)]));
    buildAggregateDailyRows(currentNationwideData.daily || []).forEach(row => output.push(['日別更新', row.date, '', `新規${row.create}件・更新${row.modify}件`, row.create + row.modify, percent(row.create + row.modify, total)]));
    downloadCsv(`osm-japan_${fromElement.value}_${toElement.value}.csv`, output);
    return;
  }

  const total = currentReportRows.length;
  countBy(currentReportRows, row => `${row.type}=${row.value}`).forEach((entry, index) => output.push(['代表タグ', index + 1, categoryName(entry.row), entry.key, entry.count, percent(entry.count, total)]));
  countBy(currentReportRows, row => row.editorUid || row.editorName || 'unknown').forEach((entry, index) => output.push(['マッパー', index + 1, entry.row.editorName || '不明', entry.row.editorUid || '', entry.count, percent(entry.count, total)]));
  buildDailyRows(currentReportRows).forEach(entry => {
    const count = entry.create + entry.modify;
    output.push(['日別更新', entry.date, '', `新規${entry.create}件・更新${entry.modify}件`, count, percent(count, total)]);
  });
  countBy(currentReportRows.filter(row => row.changeset), row => row.changeset).forEach((entry, index) => output.push(['変更セット', index + 1, entry.key, entry.row.editorName || '不明', entry.count, percent(entry.count, total)]));
  const safeName = selectedPrefectureName().replace(/[\/:*?"<>|]/g, '_');
  downloadCsv(`osm-${safeName}_${fromElement.value}_${toElement.value}.csv`, output);
});
initialize().catch(error => { statusElement.textContent = `取得できませんでした: ${error.message}`; });
