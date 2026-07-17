const statusElement = document.querySelector('#ranking-status');
const daysElement = document.querySelector('#ranking-days');
const fromElement = document.querySelector('#ranking-from');
const toElement = document.querySelector('#ranking-to');
const periodElement = document.querySelector('#ranking-period');
const csvElement = document.querySelector('#ranking-csv');
const charts = {};
let categoryRules = {};
let rankingCsvRows = [];

const parseUtcDate = value => new Date(`${String(value).replace(' ', 'T')}Z`);
const formatPeriodDate = value => {
  if (!value) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Tokyo',
  }).formatToParts(parseUtcDate(value)).map(part => [part.type, part.value]));
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

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);

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
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const source = await response.text();
  return JSON.parse(source.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n'));
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some(hole => pointInRing(point, hole));
}

function contains(feature, point) {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
}

function featureBounds(feature) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = value => {
    if (typeof value[0] === 'number') {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
    } else value.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  return bounds;
}

function aggregatePrefectures(points, geojson) {
  const counts = new Map();
  const features = geojson.features.map(feature => ({feature, bounds: featureBounds(feature)}));
  for (const row of points) {
    const point = [Number(row.lon), Number(row.lat)];
    const match = features.find(candidate => point[0] >= candidate.bounds[0] && point[0] <= candidate.bounds[2] && point[1] >= candidate.bounds[1] && point[1] <= candidate.bounds[3] && contains(candidate.feature, point));
    const name = match?.feature?.properties?.P || '日本国外・判定不能';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({name, count})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
}

function categoryName(row) {
  return categoryRules[row.type]?.[row.value] || row.value || '不明';
}

function renderTable(target, rows, label, linkBuilder) {
  target.innerHTML = rows.slice(0, 100).map((row, index) => {
    const text = escapeHtml(label(row));
    const display = linkBuilder ? `<a class="account-link" href="${linkBuilder(row)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    return `<tr><td>${index + 1}</td><td>${display}</td><td>${Number(row.count).toLocaleString('ja-JP')}</td></tr>`;
  }).join('');
}

function renderChart(id, rows, label) {
  charts[id]?.destroy();
  const top = rows.slice(0, 10);
  charts[id] = new Chart(document.getElementById(id), {
    type: 'bar',
    data: {labels: top.map(label), datasets: [{label: '更新ノード数', data: top.map(row => Number(row.count)), backgroundColor: '#16856b'}]},
    options: {
      indexAxis: 'y', maintainAspectRatio: false, responsive: true,
      plugins: {legend: {display: false}, tooltip: {callbacks: {label: context => `${context.raw.toLocaleString('ja-JP')}件`}}},
      scales: {x: {beginAtZero: true, ticks: {precision: 0}}, y: {grid: {display: false}}},
    },
  });
}

function renderDailyChart(rows) {
  charts['daily-chart']?.destroy();
  const chronological = [...rows].sort((left, right) => String(left.date).localeCompare(String(right.date)));
  charts['daily-chart'] = new Chart(document.getElementById('daily-chart'), {
    type: 'bar',
    data: {
      labels: chronological.map(row => String(row.date).replace(/-/g, '/')),
      datasets: [{label: '更新ノード数', data: chronological.map(row => row.count), backgroundColor: '#16856b'}],
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: {legend: {display: false}, tooltip: {callbacks: {label: context => `${context.raw.toLocaleString('ja-JP')}件`}}},
      scales: {x: {grid: {display: false}}, y: {beginAtZero: true, ticks: {precision: 0}}},
    },
  });
}

async function loadRanking() {
  statusElement.textContent = '集計中…';
  periodElement.textContent = '';
  csvElement.hidden = true;
  try {
    if (!fromElement.value || !toElement.value || fromElement.value > toElement.value) {
      throw new Error('開始日と終了日を正しく選択してください。');
    }
    const query = new URLSearchParams({
      days: daysElement.value,
      from: fromElement.value,
      to: toElement.value,
    });
    const [data, prefectures, categories] = await Promise.all([
      fetchJson(`ranking-api.php?${query}`),
      fetchJson('data/prefectures.min.geojson'),
      fetchJsonc('data/category-ja.jsonc'),
    ]);
    categoryRules = categories.category || {};
    const prefectureRows = aggregatePrefectures(data.points, prefectures);
    const accountRows = data.accounts.map(row => ({...row, count: Number(row.count)}));
    const categoryRows = data.categories.map(row => ({...row, count: Number(row.count)}));
    const dailyRows = data.daily.map(row => ({...row, date: row.ranking_date, creates: Number(row.creates), modifies: Number(row.modifies), count: Number(row.count)}));

    renderChart('prefecture-chart', prefectureRows, row => row.name);
    renderChart('account-chart', accountRows, row => row.name);
    renderChart('category-chart', categoryRows, categoryName);
    renderDailyChart(dailyRows);
    renderTable(document.querySelector('#prefecture-table'), prefectureRows, row => row.name);
    renderTable(document.querySelector('#account-table'), accountRows, row => `${row.name}${row.uid ? ` (${row.uid})` : ''}`, row => row.name === '不明' ? '#' : `https://www.openstreetmap.org/user/${encodeURIComponent(row.name)}`);
    renderTable(document.querySelector('#category-table'), categoryRows, row => `${categoryName(row)} (${row.type}=${row.value})`);
    document.querySelector('#daily-table').innerHTML = dailyRows.map((row, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(String(row.date).replace(/-/g, '/'))}</td><td>${row.creates.toLocaleString('ja-JP')}</td><td>${row.modifies.toLocaleString('ja-JP')}</td><td>${row.count.toLocaleString('ja-JP')}</td></tr>`).join('');
    statusElement.textContent = `対象期間の更新ノード：${Number(data.total).toLocaleString('ja-JP')}件`;
    periodElement.textContent = `集計期間：${formatPeriodDate(data.periodStart)} ～ ${formatPeriodDate(data.periodEnd)}`;
    rankingCsvRows = [['区分', '順位', '名称', 'タグ・ID', '件数']];
    prefectureRows.forEach((row, index) => rankingCsvRows.push(['都道府県', index + 1, row.name, '', row.count]));
    accountRows.forEach((row, index) => rankingCsvRows.push(['編集アカウント', index + 1, row.name, row.uid || '', row.count]));
    categoryRows.forEach((row, index) => rankingCsvRows.push(['代表タグ', index + 1, categoryName(row), `${row.type}=${row.value}`, row.count]));
    dailyRows.forEach((row, index) => rankingCsvRows.push(['日付別', index + 1, row.date, `新規=${row.creates}; 変更=${row.modifies}`, row.count]));
    csvElement.hidden = false;
  } catch (error) {
    statusElement.textContent = `取得できませんでした: ${error.message}`;
    periodElement.textContent = '';
  }
}

function formatInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function applyPresetDates() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Number(daysElement.value));
  fromElement.value = formatInputDate(start);
  toElement.value = formatInputDate(end);
  fromElement.max = toElement.value;
}

daysElement.addEventListener('change', applyPresetDates);
fromElement.addEventListener('change', () => {
  if (fromElement.value > toElement.value) toElement.value = fromElement.value;
});
toElement.addEventListener('change', () => {
  fromElement.max = toElement.value;
  if (fromElement.value > toElement.value) fromElement.value = toElement.value;
});
applyPresetDates();

csvElement.addEventListener('click', event => {
  event.preventDefault();
  downloadCsv(`osm-ranking_${fromElement.value}_${toElement.value}.csv`, rankingCsvRows);
});

document.querySelector('#ranking-filter').addEventListener('submit', event => {
  event.preventDefault();
  loadRanking();
});
loadRanking();
