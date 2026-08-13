const nationwideButton = document.querySelector('#show-nationwide');
const daysElement = document.querySelector('#days');
const fromElement = document.querySelector('#from');
const toElement = document.querySelector('#to');
const statusElement = document.querySelector('#status');
const detailsMapTitle = document.querySelector('#details-map-title');
let prefectureFeatures = [];
let selectedPrefecture = '';
let categoryRules = {};
let prefectureMap = null;
let currentCategoryEntries = [];
let pendingPrefectureCounts = null;
let apiUrl = '';
let categoryMapperRequest = 0;
const csvLists = {};
const charts = {};
const chartRenderers = {};
const chartCompanionRenderers = {};
const CREATE_COLOR = '#177866';
const MODIFY_COLOR = '#c45f32';
const prefectureCountsCache = new Map();
const PREFECTURE_FILL_LAYER = 'prefecture-select-fill';
const PREFECTURE_OUTLINE_LAYER = 'prefecture-select-outline';
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
  element.replaceChildren(main, detail);
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

function clearCsvList(key) {
  delete csvLists[key];
  const button = document.querySelector(`[data-csv-list="${key}"]`);
  if (button) button.disabled = true;
}

function setCsvList(key, rows) {
  csvLists[key] = rows;
  const button = document.querySelector(`[data-csv-list="${key}"]`);
  if (button) button.disabled = rows.length <= 1;
}

function resetCsvLists() {
  document.querySelectorAll('[data-csv-list]').forEach(button => {
    button.disabled = true;
  });
  Object.keys(csvLists).forEach(key => delete csvLists[key]);
}

function csvFileScope() {
  const name = selectedPrefectureName() || 'japan';
  return name.replace(/[\/:*?"<>|]/g, '_');
}

function mapperCsvRows(entries, total) {
  return [
    ['順位', 'マッパー', 'ユーザーID', '新規', '更新', '合計', '割合'],
    ...entries.map((entry, index) => [
      index + 1,
      entry.row.editorName || '不明',
      entry.row.editorUid || '',
      entry.creates,
      entry.modifies,
      entry.count,
      percent(entry.count, total),
    ]),
  ];
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
    const data = await fetchJson(`${apiUrl}?${query}`);
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
  const maximumCount = ranked[0]?.[1] || 0;
  const rankByName = new Map(ranked.map(([name], index) => [name, index + 1]));
  const intensityByName = new Map();
  ranked.forEach(([name, count]) => {
    if (!count) intensityByName.set(name, 0);
    else intensityByName.set(name, Math.log1p(count) / Math.log1p(maximumCount));
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
    prefectureCountsCache.set(key, fetchJson(`${apiUrl}?${query}`).then(data => data.items));
  }
  return prefectureCountsCache.get(key);
}

function selectedPrefectureName() {
  return selectedPrefecture;
}

function updateMapSelection() {
  nationwideButton.disabled = !selectedPrefecture;
  detailsMapTitle.textContent = `地域集計(${selectedPrefecture || '全国'})`;
  if (!prefectureMap?.getLayer(PREFECTURE_SELECTED_LAYER)) return;
  prefectureMap.setFilter(PREFECTURE_SELECTED_LAYER, ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture]);
}

function initializePrefectureMap(geojson) {
  const initialMapView = window.osmSharedMapView.read({
    fallbackCenter: [137.2, 36.2],
    fallbackZoom: 4.15,
    minZoom: 0,
    maxZoom: 7,
  });
  prefectureMap = new maplibregl.Map({
    container: 'prefecture-map',
    center: initialMapView.center,
    zoom: initialMapView.zoom,
    maxZoom: 7,
    maxBounds: [[118, 18], [158, 50]],
    fadeDuration: 0,
    style: './tiles/osmfj_nopoi.json',
    locale: window.osmSharedMapControls.locale,
  });
  window.osmSharedMapControls.add(prefectureMap);
  window.osmSharedMapView.bind(prefectureMap);
  prefectureMap.on('load', () => {
    prefectureMap.addSource('prefecture-boundaries', {type: 'geojson', data: geojson});
    const firstSymbolLayer = prefectureMap.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
    prefectureMap.addLayer({
      id: PREFECTURE_FILL_LAYER,
      type: 'fill',
      source: 'prefecture-boundaries',
      paint: {
        'fill-color': [
          'case',
          ['==', ['coalesce', ['get', 'updateCount'], 0], 0],
          'rgba(0,0,0,0)',
          [
            'interpolate', ['linear'], ['coalesce', ['get', 'updateIntensity'], 0],
            0, '#e5f5e0',
            0.25, '#bae4b3',
            0.5, '#74c476',
            0.75, '#31a354',
            1, '#006d2c',
          ],
        ],
        'fill-opacity': 0.48,
        'fill-outline-color': '#35674f',
      },
    }, firstSymbolLayer);
    prefectureMap.addLayer({
      id: PREFECTURE_OUTLINE_LAYER,
      type: 'line',
      source: 'prefecture-boundaries',
      paint: {
        'line-color': '#285b47',
        'line-width': 1,
        'line-opacity': 0.9,
      },
    }, firstSymbolLayer);
    prefectureMap.addLayer({
      id: PREFECTURE_SELECTED_LAYER,
      type: 'line',
      source: 'prefecture-boundaries',
      filter: ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefectureName()],
      paint: {
        'line-color': '#f05a24',
        'line-width': 2,
      },
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
    const current = counts.get(key) || {key, count: 0, creates: 0, modifies: 0, row};
    current.count++;
    current[row.action === 'create' ? 'creates' : 'modifies']++;
    counts.set(key, current);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key), 'ja'));
}

function countMappers(rows) {
  const counts = new Map();
  rows.forEach(row => {
    const key = row.editorUid || row.editorName || 'unknown';
    const current = counts.get(key) || {key, count: 0, creates: 0, modifies: 0, row};
    current.count++;
    current[row.action === 'create' ? 'creates' : 'modifies']++;
    counts.set(key, current);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key), 'ja'));
}

async function fillMapperActionCounts(data, baseQuery) {
  const mappers = Array.isArray(data.mappers) ? data.mappers : [];
  if (!mappers.some(row => row.creates === undefined || row.modifies === undefined)) return data;

  const fetchActionMappers = action => {
    const query = new URLSearchParams(baseQuery);
    query.set('mode', 'facets');
    query.set('action', action);
    return fetchJson(`${apiUrl}?${query}`);
  };
  const [createsData, modifiesData] = await Promise.all([
    fetchActionMappers('create'),
    fetchActionMappers('modify'),
  ]);
  const mapperKey = row => row.uid ? `uid:${row.uid}` : `name:${row.name || '不明'}`;
  const creates = new Map((createsData.mappers || []).map(row => [mapperKey(row), Number(row.count) || 0]));
  const modifies = new Map((modifiesData.mappers || []).map(row => [mapperKey(row), Number(row.count) || 0]));
  mappers.forEach(row => {
    const key = mapperKey(row);
    const count = Number(row.count) || 0;
    const createCount = creates.get(key);
    const modifyCount = modifies.get(key);
    row.creates = createCount ?? Math.max(0, count - (modifyCount || 0));
    row.modifies = modifyCount ?? Math.max(0, count - row.creates);
  });
  return data;
}

function categoryName(row) {
  return categoryRules[row.type]?.[row.value] || row.value || '不明';
}

function selectedChartAction(id) {
  return document.querySelector(`[data-chart-action="${id}"]`)?.value || 'both';
}

function filterChartEntries(entries, action) {
  if (action === 'both') return entries;
  const field = action === 'create' ? 'creates' : 'modifies';
  return entries
    .map(entry => {
      const count = Number(entry[field]) || 0;
      return {
        ...entry,
        count,
        creates: action === 'create' ? count : 0,
        modifies: action === 'modify' ? count : 0,
      };
    })
    .filter(entry => entry.count > 0)
    .sort((left, right) => right.count - left.count || String(left.key).localeCompare(String(right.key), 'ja'));
}

function initializeChartActionFilters() {
  const chartIds = [
    'prefecture-chart',
    'category-chart',
    'mapper-chart',
    'daily-chart',
    'changeset-chart',
    'category-mapper-chart',
  ];
  chartIds.forEach(id => {
    const canvas = document.querySelector(`#${id}`);
    const heading = id === 'category-mapper-chart'
      ? canvas?.closest('.category-mapper-ranking')?.querySelector('.category-mapper-actions')
      : canvas?.closest('section')?.querySelector('.ranking-heading');
    if (!heading) return;
    let actions = heading;
    if (heading.classList.contains('ranking-heading')) {
      actions = document.createElement('div');
      actions.className = 'chart-heading-actions';
      const csvButton = heading.querySelector('.csv-icon-button');
      if (csvButton) actions.append(csvButton);
      heading.append(actions);
    }
    const select = document.createElement('select');
    select.className = 'chart-action-filter form-select form-select-compact';
    select.dataset.chartAction = id;
    select.setAttribute('aria-label', 'グラフの更新種別');
    select.innerHTML = '<option value="both">新規・更新</option><option value="create">新規のみ</option><option value="modify">更新のみ</option>';
    actions.prepend(select);
    select.addEventListener('change', () => {
      chartRenderers[id]?.();
      chartCompanionRenderers[id]?.();
      applyRankingFilters();
    });
  });
}

function renderHorizontalChart(id, entries, labelBuilder, datasetLabel, onSelect) {
  chartRenderers[id] = () => renderHorizontalChart(id, entries, labelBuilder, datasetLabel, onSelect);
  charts[id]?.destroy();
  const action = selectedChartAction(id);
  const filteredEntries = filterChartEntries(entries, action);
  const top = filteredEntries.slice(0, 10);
  const hasActionBreakdown = entries.some(entry =>
    entry.creates !== undefined && entry.modifies !== undefined);
  const datasets = hasActionBreakdown && action === 'both'
    ? [
      {label: '新規', data: top.map(entry => entry.creates), backgroundColor: CREATE_COLOR},
      {label: '更新', data: top.map(entry => entry.modifies), backgroundColor: MODIFY_COLOR},
    ]
    : [{
      label: action === 'create' ? '新規' : action === 'modify' ? '更新' : datasetLabel,
      data: top.map(entry => entry.count),
      backgroundColor: action === 'create' ? CREATE_COLOR : action === 'modify' ? MODIFY_COLOR : '#1b8d70',
    }];
  charts[id] = new Chart(document.querySelector(`#${id}`), {
    type: 'bar',
    data: {
      labels: top.map(labelBuilder),
      datasets,
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {legend: {display: hasActionBreakdown}},
      scales: {
        x: {stacked: hasActionBreakdown && action === 'both', beginAtZero: true, ticks: {precision: 0}},
        y: {stacked: hasActionBreakdown && action === 'both'},
      },
      onClick: onSelect ? (_event, elements) => {
        const index = elements[0]?.index;
        if (index !== undefined) onSelect(top[index]);
      } : undefined,
    },
  });
}

function renderMapperChart(entries, id = 'mapper-chart') {
  chartRenderers[id] = () => renderMapperChart(entries, id);
  charts[id]?.destroy();
  const action = selectedChartAction(id);
  const top = filterChartEntries(entries, action).slice(0, 10);
  const datasets = action === 'both'
    ? [
      {label: '新規', data: top.map(entry => entry.creates), backgroundColor: CREATE_COLOR},
      {label: '更新', data: top.map(entry => entry.modifies), backgroundColor: MODIFY_COLOR},
    ]
    : [{
      label: action === 'create' ? '新規' : '更新',
      data: top.map(entry => entry.count),
      backgroundColor: action === 'create' ? CREATE_COLOR : MODIFY_COLOR,
    }];
  charts[id] = new Chart(document.querySelector(`#${id}`), {
    type: 'bar',
    data: {
      labels: top.map(entry => entry.row.editorName || '不明'),
      datasets,
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {stacked: action === 'both', beginAtZero: true, ticks: {precision: 0}},
        y: {
          stacked: action === 'both',
          ticks: {color: '#155e4a', font: {weight: '600'}},
        },
      },
    },
  });
  const canvas = charts[id].canvas;
  if (canvas.mapperProfileClickHandler) canvas.removeEventListener('click', canvas.mapperProfileClickHandler);
  if (canvas.mapperProfileMoveHandler) canvas.removeEventListener('mousemove', canvas.mapperProfileMoveHandler);
  const mapperAtEvent = event => {
    const chart = charts[id];
    const yScale = chart?.scales?.y;
    if (!yScale) return null;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * chart.width / rect.width;
    const y = (event.clientY - rect.top) * chart.height / rect.height;
    if (x < yScale.left || x > yScale.right || y < yScale.top || y > yScale.bottom) return null;
    const index = Math.round(yScale.getValueForPixel(y));
    return top[index]?.row?.editorUid ? top[index] : null;
  };
  canvas.mapperProfileClickHandler = event => {
    const mapper = mapperAtEvent(event);
    if (mapper) window.location.href = `profile.html?uid=${encodeURIComponent(mapper.row.editorUid)}`;
  };
  canvas.mapperProfileMoveHandler = event => {
    canvas.style.cursor = mapperAtEvent(event) ? 'pointer' : '';
  };
  canvas.addEventListener('click', canvas.mapperProfileClickHandler);
  canvas.addEventListener('mousemove', canvas.mapperProfileMoveHandler);
}

function mapperEntries(rows) {
  return rows.map(row => ({
    key: row.uid || row.name,
    count: Number(row.count) || 0,
    creates: Number(row.creates) || 0,
    modifies: Number(row.modifies) || 0,
    row: {editorName: row.name, editorUid: row.uid},
  }));
}

function mapperTableRows(entries, total) {
  return entries.map((entry, index) => {
    const name = entry.row.editorName || '不明';
    const label = entry.row.editorUid ? `${name} (${entry.row.editorUid})` : name;
    const linked = entry.row.editorUid
      ? `<a href="profile.html?uid=${encodeURIComponent(entry.row.editorUid)}">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    return `<tr><td>${index + 1}</td><td>${linked}</td><td>${number(entry.creates)}</td><td>${number(entry.modifies)}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`;
  }).join('');
}

function categoryTableRows(entries, total) {
  return entries.map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(categoryName(entry.row))}<br><small>${escapeHtml(entry.key)}</small></td><td><button class="category-mapper-button" type="button" data-category-index="${index}">マッパーを見る</button></td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');
}

function filteredChartTotal(entries) {
  return entries.reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);
}

function selectedCompanionTotal(chartId, entries, totals) {
  const action = selectedChartAction(chartId);
  return Number(totals?.[action]) || filteredChartTotal(entries);
}

function updatePrefectureCompanions(entries, totals) {
  const filtered = filterChartEntries(entries, selectedChartAction('prefecture-chart'));
  const total = selectedCompanionTotal('prefecture-chart', filtered, totals);
  document.querySelector('#prefecture-table').innerHTML = filtered.map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(entry.row.name)}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');
  setCsvList('prefectures', [
    ['順位', '都道府県', '件数', '割合'],
    ...filtered.map((entry, index) => [index + 1, entry.row.name, entry.count, percent(entry.count, total)]),
  ]);
}

function updateCategoryCompanions(entries, totals) {
  const allFiltered = filterChartEntries(entries, selectedChartAction('category-chart'));
  const filtered = allFiltered.slice(0, 100);
  const total = selectedCompanionTotal('category-chart', allFiltered, totals);
  currentCategoryEntries = filtered;
  document.querySelector('#category-table').innerHTML = categoryTableRows(filtered, total);
  setCsvList('categories', [
    ['順位', '代表タグ', 'タグ', '件数', '割合'],
    ...filtered.map((entry, index) => [
      index + 1, categoryName(entry.row), entry.key, entry.count, percent(entry.count, total),
    ]),
  ]);
}

function updateMapperCompanions(entries, key = 'mappers', chartId = 'mapper-chart', totals) {
  const filtered = filterChartEntries(entries, selectedChartAction(chartId)).slice(0, 100);
  const total = selectedCompanionTotal(chartId, filtered, totals);
  document.querySelector(`#${key === 'mappers' ? 'mapper' : 'category-mapper'}-table`).innerHTML = mapperTableRows(filtered, total);
  setCsvList(key, mapperCsvRows(filtered, total));
}

function updateDailyCompanions(rows) {
  const action = selectedChartAction('daily-chart');
  const filtered = rows.map(row => ({
    ...row,
    create: action === 'modify' ? 0 : row.create,
    modify: action === 'create' ? 0 : row.modify,
  }));
  document.querySelector('#daily-table').innerHTML = filtered.map(row =>
    `<tr><td>${escapeHtml(row.date.replace(/-/g, '/'))}</td><td>${number(row.create)}</td><td>${number(row.modify)}</td><td>${number(row.create + row.modify)}</td></tr>`).join('');
  setCsvList('daily', [
    ['日付', '新規', '更新', '合計'],
    ...filtered.map(row => [row.date, row.create, row.modify, row.create + row.modify]),
  ]);
}

function updateChangesetCompanions(entries) {
  const filtered = filterChartEntries(entries, selectedChartAction('changeset-chart')).slice(0, 100);
  document.querySelector('#changeset-table').innerHTML = filtered.map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');
  setCsvList('changesets', [
    ['順位', '変更セット', 'マッパー', '件数'],
    ...filtered.map((entry, index) => [index + 1, entry.key, entry.row.editorName || '不明', entry.count]),
  ]);
}

function filterRankingRows(input) {
  const tableBody = document.querySelector(`#${input.dataset.filterTarget}`);
  if (!tableBody) return;
  const query = input.value.normalize('NFKC').toLocaleLowerCase('ja');
  tableBody.querySelectorAll('tr').forEach(row => {
    row.hidden = Boolean(query) && !row.textContent.normalize('NFKC').toLocaleLowerCase('ja').includes(query);
  });
}

function applyRankingFilters() {
  document.querySelectorAll('.ranking-filter').forEach(filterRankingRows);
}

function resetCategoryMapperRanking() {
  categoryMapperRequest++;
  clearCsvList('category-mappers');
  document.querySelector('#category-mapper-ranking').hidden = true;
  document.querySelector('#category-mapper-table').innerHTML = '';
  document.querySelector('[data-filter-target="category-mapper-table"]').value = '';
  charts['category-mapper-chart']?.destroy();
  delete charts['category-mapper-chart'];
  delete chartRenderers['category-mapper-chart'];
  delete chartCompanionRenderers['category-mapper-chart'];
}

async function loadCategoryMapperRanking(entry) {
  const request = ++categoryMapperRequest;
  const panel = document.querySelector('#category-mapper-ranking');
  const status = document.querySelector('#category-mapper-status');
  panel.hidden = false;
  document.querySelector('#category-mapper-title').textContent = `${categoryName(entry.row)}のマッパーランキング`;
  document.querySelector('#category-mapper-key').textContent = entry.key;
  document.querySelector('#category-mapper-table').innerHTML = '';
  charts['category-mapper-chart']?.destroy();
  delete charts['category-mapper-chart'];
  delete chartRenderers['category-mapper-chart'];
  delete chartCompanionRenderers['category-mapper-chart'];
  status.textContent = '集計中…';
  panel.scrollIntoView({behavior: 'smooth', block: 'nearest'});

  try {
    const query = new URLSearchParams({
      from: fromElement.value,
      to: toElement.value,
      category: entry.row.type,
      category_value: entry.row.value,
    });
    const prefecture = selectedPrefectureName();
    if (prefecture) query.set('prefecture', prefecture);
    const facetsQuery = new URLSearchParams(query);
    facetsQuery.set('mode', 'facets');
    const data = await fetchJson(`${apiUrl}?${facetsQuery}`);
    await fillMapperActionCounts(data, query);
    if (request !== categoryMapperRequest) return;

    const mappers = mapperEntries(data.mappers || []);
    renderMapperChart(mappers, 'category-mapper-chart');
    const categoryTotals = {both: entry.count, create: entry.creates, modify: entry.modifies};
    chartCompanionRenderers['category-mapper-chart'] = () =>
      updateMapperCompanions(mappers, 'category-mappers', 'category-mapper-chart', categoryTotals);
    chartCompanionRenderers['category-mapper-chart']();
    filterRankingRows(document.querySelector('[data-filter-target="category-mapper-table"]'));
    status.textContent = mappers.length ? `${number(mappers.length)}人（合計件数の上位100名）` : '該当するマッパーはいません。';
  } catch (error) {
    if (request !== categoryMapperRequest) return;
    status.textContent = `取得できませんでした: ${error.message}`;
  }
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
  chartRenderers['daily-chart'] = () => renderDailyChart(dailyRows);
  charts['daily-chart']?.destroy();
  const action = selectedChartAction('daily-chart');
  const datasets = action === 'both'
    ? [
      {label: '新規', data: dailyRows.map(row => row.create), backgroundColor: CREATE_COLOR},
      {label: '更新', data: dailyRows.map(row => row.modify), backgroundColor: MODIFY_COLOR},
    ]
    : [{
      label: action === 'create' ? '新規' : '更新',
      data: dailyRows.map(row => row[action]),
      backgroundColor: action === 'create' ? CREATE_COLOR : MODIFY_COLOR,
    }];
  charts['daily-chart'] = new Chart(document.querySelector('#daily-chart'), {
    type: 'bar',
    data: {
      labels: dailyRows.map(row => row.date.replace(/-/g, '/')),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {stacked: action === 'both'},
        y: {stacked: action === 'both', beginAtZero: true, ticks: {precision: 0}},
      },
    },
  });
}

function render(rows) {
  document.querySelector('#prefecture-ranking').hidden = true;
  document.querySelector('#changeset-ranking').hidden = false;
  const total = rows.length;
  const creates = rows.filter(row => row.action === 'create').length;
  const mapperRows = countMappers(rows);
  const changesets = countBy(rows.filter(row => row.changeset), row => row.changeset);
  updateTotalSummary(total, creates, total - creates);
  document.querySelector('#mappers').textContent = `${number(mapperRows.length)}人`;

  const categories = countBy(rows, row => `${row.type}=${row.value}`);
  currentCategoryEntries = categories.slice(0, 100);
  renderHorizontalChart('category-chart', categories, entry => categoryName(entry.row), '更新地物数', loadCategoryMapperRanking);
  document.querySelector('#category-table').innerHTML = categoryTableRows(currentCategoryEntries, total);
  setCsvList('categories', [
    ['順位', '代表タグ', 'タグ', '件数', '割合'],
    ...currentCategoryEntries.map((entry, index) => [
      index + 1, categoryName(entry.row), entry.key, entry.count, percent(entry.count, total),
    ]),
  ]);

  const displayedMappers = mapperRows.slice(0, 100);
  document.querySelector('#mapper-table').innerHTML = mapperTableRows(displayedMappers, total);
  renderMapperChart(mapperRows);
  setCsvList('mappers', mapperCsvRows(displayedMappers, total));

  const dailyRows = buildDailyRows(rows);
  renderDailyChart(dailyRows);
  document.querySelector('#daily-table').innerHTML = dailyRows.map(row =>
    `<tr><td>${escapeHtml(row.date.replace(/-/g, '/'))}</td><td>${number(row.create)}</td><td>${number(row.modify)}</td><td>${number(row.create + row.modify)}</td></tr>`).join('');
  setCsvList('daily', [
    ['日付', '新規', '更新', '合計'],
    ...dailyRows.map(row => [row.date, row.create, row.modify, row.create + row.modify]),
  ]);


  renderHorizontalChart('changeset-chart', changesets, entry => `#${entry.key}`, '更新地物数');
  const displayedChangesets = changesets.slice(0, 100);
  document.querySelector('#changeset-table').innerHTML = displayedChangesets.map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');
  setCsvList('changesets', [
    ['順位', '変更セット', 'マッパー', '件数'],
    ...displayedChangesets.map((entry, index) => [
      index + 1, entry.key, entry.row.editorName || '不明', entry.count,
    ]),
  ]);
  const reportTotals = {both: total, create: creates, modify: total - creates};
  chartCompanionRenderers['category-chart'] = () => updateCategoryCompanions(categories, reportTotals);
  chartCompanionRenderers['mapper-chart'] = () => updateMapperCompanions(mapperRows, 'mappers', 'mapper-chart', reportTotals);
  chartCompanionRenderers['daily-chart'] = () => updateDailyCompanions(dailyRows);
  chartCompanionRenderers['changeset-chart'] = () => updateChangesetCompanions(changesets);
  chartCompanionRenderers['category-chart']();
  chartCompanionRenderers['mapper-chart']();
  chartCompanionRenderers['daily-chart']();
  chartCompanionRenderers['changeset-chart']();
  applyRankingFilters();
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
  document.querySelector('#prefecture-ranking').hidden = false;
  document.querySelector('#changeset-ranking').hidden = false;

  const total = Number(data.total) || 0;
  const dailyRows = buildAggregateDailyRows(data.daily || []);
  const creates = dailyRows.reduce((sum, row) => sum + row.create, 0);
  const modifies = dailyRows.reduce((sum, row) => sum + row.modify, 0);
  const mapperCount = Number(data.mapperCount) || 0;
  const changesets = (data.changesets || []).map(row => ({
    key: row.changeset,
    count: Number(row.count) || 0,
    creates: row.creates === undefined ? undefined : Number(row.creates) || 0,
    modifies: row.modifies === undefined ? undefined : Number(row.modifies) || 0,
    row: {editorName: row.editorName},
  }));
  updateTotalSummary(total, creates, modifies);
  document.querySelector('#mappers').textContent = `${number(mapperCount)}人`;

  const prefectures = (data.prefectures || []).map(row => ({
    key: row.name,
    count: Number(row.count) || 0,
    creates: row.creates === undefined ? undefined : Number(row.creates) || 0,
    modifies: row.modifies === undefined ? undefined : Number(row.modifies) || 0,
    row,
  }));
  renderHorizontalChart('prefecture-chart', prefectures, entry => entry.row.name, '更新地物数');
  document.querySelector('#prefecture-table').innerHTML = prefectures.map((entry, index) =>
    `<tr><td>${index + 1}</td><td>${escapeHtml(entry.row.name)}</td><td>${number(entry.count)}</td><td>${percent(entry.count, total)}</td></tr>`).join('');
  setCsvList('prefectures', [
    ['順位', '都道府県', '件数', '割合'],
    ...prefectures.map((entry, index) => [
      index + 1, entry.row.name, entry.count, percent(entry.count, total),
    ]),
  ]);

  const categories = (data.categories || []).map(row => ({
    key: `${row.type}=${row.value}`,
    count: Number(row.count) || 0,
    creates: row.creates === undefined ? undefined : Number(row.creates) || 0,
    modifies: row.modifies === undefined ? undefined : Number(row.modifies) || 0,
    row,
  }));
  currentCategoryEntries = categories;
  renderHorizontalChart('category-chart', categories, entry => categoryName(entry.row), '更新地物数', loadCategoryMapperRanking);
  document.querySelector('#category-table').innerHTML = categoryTableRows(currentCategoryEntries, total);
  setCsvList('categories', [
    ['順位', '代表タグ', 'タグ', '件数', '割合'],
    ...categories.map((entry, index) => [
      index + 1, categoryName(entry.row), entry.key, entry.count, percent(entry.count, total),
    ]),
  ]);

  const mappers = mapperEntries(data.mappers || []);
  renderMapperChart(mappers);
  document.querySelector('#mapper-table').innerHTML = mapperTableRows(mappers, total);
  setCsvList('mappers', mapperCsvRows(mappers, total));

  renderHorizontalChart('changeset-chart', changesets, entry => `#${entry.key}`, '更新地物数');
  document.querySelector('#changeset-table').innerHTML = changesets.map((entry, index) => {
    const editor = entry.row.editorName || '不明';
    return `<tr><td>${index + 1}</td><td><a href="https://www.openstreetmap.org/changeset/${encodeURIComponent(entry.key)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.key)}</a></td><td>${escapeHtml(editor)}</td><td>${number(entry.count)}</td></tr>`;
  }).join('');
  setCsvList('changesets', [
    ['順位', '変更セット', 'マッパー', '件数'],
    ...changesets.map((entry, index) => [
      index + 1, entry.key, entry.row.editorName || '不明', entry.count,
    ]),
  ]);

  renderDailyChart(dailyRows);
  document.querySelector('#daily-table').innerHTML = dailyRows.map(row =>
    `<tr><td>${escapeHtml(row.date.replace(/-/g, '/'))}</td><td>${number(row.create)}</td><td>${number(row.modify)}</td><td>${number(row.create + row.modify)}</td></tr>`).join('');
  setCsvList('daily', [
    ['日付', '新規', '更新', '合計'],
    ...dailyRows.map(row => [row.date, row.create, row.modify, row.create + row.modify]),
  ]);
  const reportTotals = {both: total, create: creates, modify: modifies};
  chartCompanionRenderers['prefecture-chart'] = () => updatePrefectureCompanions(prefectures, reportTotals);
  chartCompanionRenderers['category-chart'] = () => updateCategoryCompanions(categories, reportTotals);
  chartCompanionRenderers['mapper-chart'] = () => updateMapperCompanions(mappers, 'mappers', 'mapper-chart', reportTotals);
  chartCompanionRenderers['daily-chart'] = () => updateDailyCompanions(dailyRows);
  chartCompanionRenderers['changeset-chart'] = () => updateChangesetCompanions(changesets);
  chartCompanionRenderers['prefecture-chart']();
  chartCompanionRenderers['category-chart']();
  chartCompanionRenderers['mapper-chart']();
  chartCompanionRenderers['daily-chart']();
  chartCompanionRenderers['changeset-chart']();
  applyRankingFilters();
}
async function loadReport() {
  statusElement.textContent = '集計中…';
  resetCsvLists();
  resetCategoryMapperRanking();
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
      : fetchJson(`${apiUrl}?${nationwideQuery}`);
    const [data, prefectureCounts] = await Promise.all([reportRequest, loadPrefectureCounts()]);
    if (!name) await fillMapperActionCounts(data, query);
    renderPrefectureColors(prefectureCounts);

    if (name) {
      render(data.rows);
    } else {
      renderNationwide(data);
    }
    statusElement.textContent = '';
    document.querySelector('#period').textContent = `集計期間：${formatJstDateTime(data.meta.periodStart)} ～ ${formatJstDateTime(data.meta.periodEnd)}`;
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
  const [configuration, geojson, categories] = await Promise.all([
    fetchJsonc('data/config.jsonc'),
    fetchJson('data/prefectures.min.geojson'),
    fetchJsonc('data/category-ja.jsonc'),
  ]);
  try {
    const resolvedApiUrl = new URL(String(configuration.apiUrl || '').trim(), window.location.href);
    if (!/^https?:$/.test(resolvedApiUrl.protocol)) throw new Error();
    apiUrl = resolvedApiUrl.href;
  } catch {
    throw new Error('data/config.jsonc の apiUrl はHTTP(S)の相対URLまたは絶対URLを指定してください。');
  }
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
document.querySelectorAll('.ranking-filter').forEach(input => {
  input.addEventListener('input', () => filterRankingRows(input));
});
document.querySelector('#category-table').addEventListener('click', event => {
  const button = event.target.closest('[data-category-index]');
  if (!button) return;
  const entry = currentCategoryEntries[Number(button.dataset.categoryIndex)];
  if (entry) loadCategoryMapperRanking(entry);
});
document.querySelector('#category-mapper-close').addEventListener('click', resetCategoryMapperRanking);
document.querySelectorAll('[data-csv-list]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.csvList;
    const rows = csvLists[key];
    if (!rows || rows.length <= 1) return;
    downloadCsv(`osm-${csvFileScope()}-${key}_${fromElement.value}_${toElement.value}.csv`, rows);
  });
});
initializeChartActionFilters();
initialize().catch(error => { statusElement.textContent = `取得できませんでした: ${error.message}`; });
