const mapPageUrl = new URL(window.location.href);
const readMapParameter = (name, minimum, maximum, fallback) => {
  const raw = mapPageUrl.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
};
const initialLatitude = readMapParameter('lat', -85, 85, 36.2);
const initialLongitude = readMapParameter('lon', -180, 180, 137.2);
const initialZoom = readMapParameter('zoom', 0, 24, 4.15);

const map = new maplibregl.Map({
  container: 'map',
  center: [initialLongitude, initialLatitude],
  zoom: initialZoom,
  fadeDuration: 0,
  style: './tiles/osmfj_poi.json',
});
map.addControl(new maplibregl.NavigationControl());

const saveMapViewToUrl = () => {
  const center = map.getCenter();
  const url = new URL(window.location.href);
  url.searchParams.set('lat', center.lat.toFixed(5));
  url.searchParams.set('lon', center.lng.toFixed(5));
  url.searchParams.set('zoom', map.getZoom().toFixed(2));
  window.history.replaceState(null, '', url);
};
map.on('moveend', saveMapViewToUrl);
map.once('load', saveMapViewToUrl);

const status = document.querySelector('#status');
const list = document.querySelector('#list');
const listScroller = list.closest('aside');
const timeline = document.querySelector('#timeline');
const range = document.querySelector('#time-range');
const timelineLabel = document.querySelector('#timeline-label');
const timeStart = document.querySelector('#time-start');
const timeEnd = document.querySelector('#time-end');
const playButton = document.querySelector('#play-timeline');
const pauseButton = document.querySelector('#pause-timeline');
const timelineStep = document.querySelector('#timeline-step');
const days = document.querySelector('#days');
const dateFrom = document.querySelector('#date-from');
const dateTo = document.querySelector('#date-to');

let markerEntries = [];
let poiFeatures = [];
let highlightRadius = 10 * 60 * 1000;
let playbackTimer = null;
let playbackStartTimer = null;
let playbackFrame = null;
let isPlaying = false;
let activeListItem = null;
const osmPopup = new maplibregl.Popup({offset: 20, closeButton: true, closeOnClick: true});
let timeStep = Number(timelineStep.value);
const MOVE_DURATION = 350;
const HOLD_DURATION = 100;
let markerRules = {};
let categoryRules = {};
const POI_SOURCE = 'new-pois';
const POI_LAYER = 'new-pois-symbol';
const POI_HIGHLIGHT_LAYER = 'new-pois-highlight';
const CLUSTER_SOURCE = 'cluster-pois';
const CLUSTER_CIRCLE_LAYER = 'cluster-pois-circle';
const CLUSTER_COUNT_LAYER = 'cluster-pois-count';
const CLUSTER_POINT_LAYER = 'cluster-pois-point';
const CLUSTER_MAX_ZOOM = 5;
const LAYER_SWITCH_ZOOM = 5.01;
let mapLayerEventsReady = false;
let visibleListCount = 0;
let clusterVisibleCount = -1;
let highlightedListStart = 0;
let highlightedListEnd = 0;
let dateReloadTimer = null;

const parseUtcDate = value => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
};
const fmt = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Tokyo',
  }).formatToParts(parseUtcDate(value)).map(part => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute} (JST)`;
};
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[character]);

async function json(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(response.ok ? 'api.php がJSONを返していません。' : `API error ${response.status}`);
  }
  if (!response.ok) throw new Error(data.error || `API error ${response.status}`);
  return data;
}

async function loadAllPois(daysValue, fromValue, toValue) {
  const pageSize = 1000;
  const maximumPages = 50;
  const rows = [];
  for (let page = 1; page <= maximumPages; page++) {
    const query = new URLSearchParams({
      days: daysValue,
      from: fromValue,
      to: toValue,
      limit: String(pageSize),
      page: String(page),
    });
    const batch = await json(`api.php?${query}`);
    rows.push(...batch);
    status.textContent = `${rows.length.toLocaleString('ja-JP')}件を読み込み中…`;
    if (batch.length < pageSize) return rows;
  }
  status.textContent = '表示上限の50,000件まで読み込みました。';
  return rows;
}

async function jsonc(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const source = await response.text();
  const withoutComments = source.split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
  return JSON.parse(withoutComments);
}

async function loadDefinitions() {
  const language = document.documentElement.lang.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const [markers, categories] = await Promise.all([
    jsonc('data/marker.jsonc'),
    jsonc(`data/category-${language}.jsonc`),
  ]);
  markerRules = markers.marker?.tag || {};
  categoryRules = categories.category || {};
}

function lookupRule(rules, tags, fallback) {
  for (const [key, values] of Object.entries(rules)) {
    if (key === '*' || !tags[key]) continue;
    if (values[tags[key]]) return values[tags[key]];
    if (values['*']) return values['*'];
  }
  return rules['*']?.['*'] || fallback;
}

function decorateItem(item) {
  let tags = item.tags || {};
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { tags = {}; }
  }
  if (!tags[item.type]) tags[item.type] = item.kind;
  return {
    ...item,
    tags,
    icon: lookupRule(markerRules, tags, 'marker-stroked.png'),
    categoryName: lookupRule(categoryRules, tags, item.kind || '—'),
  };
}

function clearMarkers() {
  pauseTimeline();
  osmPopup.remove();
  activeListItem = null;
  if (map.getSource(POI_SOURCE)) {
    map.getSource(POI_SOURCE).setData({type: 'FeatureCollection', features: []});
  }
  if (map.getSource(CLUSTER_SOURCE)) {
    map.getSource(CLUSTER_SOURCE).setData({type: 'FeatureCollection', features: []});
  }
  markerEntries = [];
  poiFeatures = [];
  visibleListCount = 0;
  clusterVisibleCount = -1;
  highlightedListStart = 0;
  highlightedListEnd = 0;
}

function pauseTimeline() {
  isPlaying = false;
  if (playbackStartTimer !== null) {
    clearTimeout(playbackStartTimer);
    playbackStartTimer = null;
  }
  if (playbackTimer !== null) {
    clearTimeout(playbackTimer);
    playbackTimer = null;
  }
  if (playbackFrame !== null) {
    cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
  }
  playButton.disabled = false;
  pauseButton.disabled = true;
}

function animateRange(from, to, duration, done) {
  const startedAt = performance.now();
  const frame = now => {
    if (!isPlaying) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    range.value = String(from + (to - from) * eased);
    if (progress < 1) {
      playbackFrame = requestAnimationFrame(frame);
    } else {
      playbackFrame = null;
      range.value = String(to);
      updateHighlight();
      waitForMapIdle(done);
    }
  };
  playbackFrame = requestAnimationFrame(frame);
}

function waitForMapIdle(done) {
  let finished = false;
  const startedAt = performance.now();
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    map.off('idle', finish);
    done(performance.now() - startedAt);
  };
  const timeout = setTimeout(finish, 1500);
  map.once('idle', finish);
  map.triggerRepaint();
}

function playNextStep() {
  if (!isPlaying) return;
  const from = Number(range.value);
  const maximum = Number(range.max);
  const to = Math.min(from + timeStep, maximum);
  if (from >= maximum) {
    pauseTimeline();
    return;
  }
  animateRange(from, to, MOVE_DURATION, renderDuration => {
    if (!isPlaying) return;
    const remainingHold = Math.max(0, HOLD_DURATION - renderDuration);
    if (to >= maximum) {
      playbackTimer = setTimeout(pauseTimeline, remainingHold);
    } else {
      playbackTimer = setTimeout(playNextStep, remainingHold);
    }
  });
}

function playTimeline() {
  pauseTimeline();
  if (Number(range.value) >= Number(range.max)) range.value = range.min;
  isPlaying = true;
  playButton.disabled = true;
  pauseButton.disabled = false;
  updateHighlight();
  playNextStep();
}

function lowerBound(value) {
  let low = 0;
  let high = markerEntries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (markerEntries[middle].time < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(value) {
  let low = 0;
  let high = markerEntries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (markerEntries[middle].time <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function updateClusterData(visible, force = false) {
  const source = map.getSource(CLUSTER_SOURCE);
  if (!source || map.getZoom() > LAYER_SWITCH_ZOOM) return;
  if (!force && visible === clusterVisibleCount) return;
  source.setData({
    type: 'FeatureCollection',
    features: poiFeatures.slice(0, visible),
  });
  clusterVisibleCount = visible;
}

function scrollListToVisiblePoi(visible) {
  if (!listScroller) return;
  if (visible <= 0) {
    listScroller.scrollTop = 0;
    return;
  }
  const target = markerEntries[visible - 1]?.listItem;
  if (!target) return;
  const scrollerRect = listScroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetTop = listScroller.scrollTop
    + targetRect.top - scrollerRect.top
    - (listScroller.clientHeight - targetRect.height) / 2;
  listScroller.scrollTop = Math.max(0, targetTop);
}

function updateHighlight() {
  const selected = Number(range.value);
  const visible = upperBound(selected);
  const highlightStart = lowerBound(selected - highlightRadius);
  const highlightEnd = visible;

  if (map.getLayer(POI_LAYER)) {
    map.setFilter(POI_LAYER, ['<=', ['get', 'timestamp'], selected]);
    map.setFilter(POI_HIGHLIGHT_LAYER, ['all', ['<=', ['get', 'timestamp'], selected], ['>=', ['get', 'timestamp'], selected - highlightRadius]]);
  }
  updateClusterData(visible);

  if (visible !== visibleListCount) {
    const start = Math.min(visible, visibleListCount);
    const end = Math.max(visible, visibleListCount);
    for (let index = start; index < end; index++) {
      markerEntries[index].listItem.classList.toggle('is-future', index >= visible);
    }
    scrollListToVisiblePoi(visible);
    visibleListCount = visible;
  }

  if (highlightStart !== highlightedListStart || highlightEnd !== highlightedListEnd) {
    for (let index = highlightedListStart; index < highlightedListEnd; index++) {
      if (index < highlightStart || index >= highlightEnd) markerEntries[index]?.listItem.classList.remove('is-highlighted');
    }
    for (let index = highlightStart; index < highlightEnd; index++) {
      if (index < highlightedListStart || index >= highlightedListEnd) markerEntries[index].listItem.classList.add('is-highlighted');
    }
    highlightedListStart = highlightStart;
    highlightedListEnd = highlightEnd;
  }

  const highlighted = Math.max(0, highlightEnd - highlightStart);
  timelineLabel.textContent = `${fmt(selected)} 差分${highlighted}件/累積${visible}件`;
  status.textContent = `${markerEntries.length}件中 ${visible}件を表示`;
}

function showOsmMenu(entry, syncList = true) {
  if (activeListItem) activeListItem.classList.remove('is-selected');
  activeListItem = entry.listItem;
  activeListItem.classList.add('is-selected');
  if (syncList) activeListItem.scrollIntoView({behavior: 'smooth', block: 'center'});

  const menu = document.createElement('div');
  menu.className = 'osm-menu';
  const title = document.createElement('strong');
  title.textContent = entry.item.name;
  menu.append(title);

  const details = document.createElement('dl');
  details.className = 'osm-menu-details';
  const addDetail = (label, value) => {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    if (value instanceof Node) description.append(value);
    else description.textContent = value || '—';
    details.append(term, description);
  };

  addDetail('種別', `${entry.item.categoryName}（${entry.item.type}=${entry.item.kind || '—'}）`);
  addDetail('更新時間', fmt(entry.item.date));

  if (entry.item.editorName) {
    const editorLink = document.createElement('a');
    editorLink.href = `https://www.openstreetmap.org/user/${encodeURIComponent(entry.item.editorName)}`;
    editorLink.target = '_blank';
    editorLink.rel = 'noopener noreferrer';
    editorLink.textContent = `${entry.item.editorName}${entry.item.editorUid ? ` (${entry.item.editorUid})` : ''}`;
    addDetail('更新者', editorLink);
  } else {
    addDetail('更新者', '編集者不明');
  }
  menu.append(details);

  const tagsTitle = document.createElement('div');
  tagsTitle.className = 'osm-menu-tags-title';
  tagsTitle.textContent = 'タグ';
  menu.append(tagsTitle);

  const tags = document.createElement('div');
  tags.className = 'osm-menu-tags';
  const tagTable = document.createElement('table');
  Object.entries(entry.item.tags || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => {
      const row = tagTable.insertRow();
      const keyCell = row.insertCell();
      const valueCell = row.insertCell();
      keyCell.textContent = key;
      valueCell.textContent = String(value);
    });
  if (!tagTable.rows.length) tags.textContent = 'タグなし';
  else tags.append(tagTable);
  menu.append(tags);

  const links = document.createElement('div');
  links.className = 'osm-menu-links';
  const osmType = entry.item.osmType || 'node';
  const targets = [
    ['OSMで表示', `https://www.openstreetmap.org/${osmType}/${entry.item.id}`],
    ['変更セット', `https://www.openstreetmap.org/changeset/${entry.item.changeset}`],
  ];
  targets.forEach(([label, href]) => {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    links.append(link);
  });
  menu.append(links);

  osmPopup
    .setLngLat([entry.item.lon, entry.item.lat])
    .setDOMContent(menu)
    .addTo(map);
}

function setupTimeline(items) {
  if (!items.length) {
    timeline.hidden = true;
    return;
  }
  const times = items.map(item => parseUtcDate(item.date).getTime()).filter(Number.isFinite);
  const selectedMin = new Date(`${dateFrom.value}T00:00:00`).getTime();
  const selectedMax = new Date(`${dateTo.value}T23:59:59`).getTime();
  const min = Number.isFinite(selectedMin) ? selectedMin : Math.floor(Math.min(...times) / timeStep) * timeStep;
  const max = Number.isFinite(selectedMax) ? selectedMax : Math.ceil(Math.max(...times) / timeStep) * timeStep;
  highlightRadius = timeStep;
  range.min = String(min);
  range.max = String(Math.max(min + timeStep, max));
  // Playback moves continuously; logical destinations remain 10-minute steps.
  range.step = 'any';
  range.value = String(min);
  timeStart.textContent = fmt(min);
  timeEnd.textContent = fmt(max);
  timeline.hidden = false;
  range.disabled = false;
  playButton.disabled = false;
  pauseButton.disabled = true;
  updateHighlight();
}

function createPinImage(source, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 80;
  const context = canvas.getContext('2d');
  context.scale(2, 2);
  context.beginPath();
  context.moveTo(16, 39);
  context.bezierCurveTo(13, 34, 3, 25, 3, 16);
  context.bezierCurveTo(3, 8.8, 8.8, 3, 16, 3);
  context.bezierCurveTo(23.2, 3, 29, 8.8, 29, 16);
  context.bezierCurveTo(29, 25, 19, 34, 16, 39);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#fff';
  context.stroke();
  context.drawImage(source, 7, 7, 18, 18);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function loadMapIcons(entries) {
  const fallback = await map.loadImage('icon/marker-stroked.png');
  const sourceImages = new Map();
  const iconNames = new Set(entries.map(entry => entry.item.icon));
  await Promise.all([...iconNames].map(async name => {
    try {
      const image = await map.loadImage(`icon/${encodeURIComponent(name)}`);
      sourceImages.set(name, image.data);
    } catch {
      sourceImages.set(name, fallback.data);
    }
  }));
  entries.forEach(entry => {
    const imageId = `poi-${entry.item.type}-${entry.item.icon}`;
    entry.item.mapIcon = imageId;
    if (!map.hasImage(imageId)) {
      const color = entry.item.type === 'shop' ? '#f97316' : '#12b981';
      map.addImage(imageId, createPinImage(sourceImages.get(entry.item.icon), color), {pixelRatio: 2});
    }
  });
}

function ensurePoiLayers() {
  if (!map.getSource(POI_SOURCE)) map.addSource(POI_SOURCE, {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
  if (!map.getLayer(POI_HIGHLIGHT_LAYER)) {
    map.addLayer({id: POI_HIGHLIGHT_LAYER,type: 'circle',source: POI_SOURCE,minzoom: LAYER_SWITCH_ZOOM,paint: {'circle-radius': 18,'circle-color': '#ffe45e','circle-opacity': 0.75,'circle-blur': 0.7}});
  }
  if (!map.getLayer(POI_LAYER)) {
    map.addLayer({id: POI_LAYER,type: 'symbol',source: POI_SOURCE,minzoom: LAYER_SWITCH_ZOOM,layout: {'icon-image': ['get', 'icon'],'icon-size': 1,'icon-anchor': 'bottom','icon-allow-overlap': true,'icon-ignore-placement': true}});
  }
  if (!map.getSource(CLUSTER_SOURCE)) {
    map.addSource(CLUSTER_SOURCE, {
      type: 'geojson',
      data: {type: 'FeatureCollection', features: []},
      cluster: true,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterRadius: 52,
    });
  }
  if (!map.getLayer(CLUSTER_CIRCLE_LAYER)) {
    map.addLayer({
      id: CLUSTER_CIRCLE_LAYER,
      type: 'circle',
      source: CLUSTER_SOURCE,
      maxzoom: LAYER_SWITCH_ZOOM,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#65cdb0', 25, '#20a67f', 100, '#08705a'],
        'circle-radius': ['step', ['get', 'point_count'], 18, 25, 23, 100, 29],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
  }
  if (!map.getLayer(CLUSTER_COUNT_LAYER)) {
    map.addLayer({
      id: CLUSTER_COUNT_LAYER,
      type: 'symbol',
      source: CLUSTER_SOURCE,
      maxzoom: LAYER_SWITCH_ZOOM,
      filter: ['has', 'point_count'],
      layout: {'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12},
      paint: {'text-color': '#ffffff'},
    });
  }
  if (!map.getLayer(CLUSTER_POINT_LAYER)) {
    map.addLayer({
      id: CLUSTER_POINT_LAYER,
      type: 'circle',
      source: CLUSTER_SOURCE,
      maxzoom: LAYER_SWITCH_ZOOM,
      filter: ['!', ['has', 'point_count']],
      paint: {'circle-color': '#12b981', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2},
    });
  }
  if (!mapLayerEventsReady) {
    map.on('click', POI_LAYER, event => {
      const index = Number(event.features?.[0]?.properties?.entryIndex);
      if (Number.isInteger(index) && markerEntries[index]) showOsmMenu(markerEntries[index], true);
    });
    map.on('mouseenter', POI_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', POI_LAYER, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', CLUSTER_CIRCLE_LAYER, async event => {
      const feature = event.features?.[0];
      const clusterId = feature?.properties?.cluster_id;
      if (clusterId === undefined) return;
      const zoom = await map.getSource(CLUSTER_SOURCE).getClusterExpansionZoom(clusterId);
      map.easeTo({center: feature.geometry.coordinates, zoom});
    });
    map.on('click', CLUSTER_POINT_LAYER, event => {
      const index = Number(event.features?.[0]?.properties?.entryIndex);
      if (Number.isInteger(index) && markerEntries[index]) showOsmMenu(markerEntries[index], true);
    });
    [CLUSTER_CIRCLE_LAYER, CLUSTER_POINT_LAYER].forEach(layer => {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
    });
    map.on('zoomend', () => {
      if (map.getZoom() <= LAYER_SWITCH_ZOOM && markerEntries.length) {
        updateClusterData(upperBound(Number(range.value)), true);
      }
    });
    mapLayerEventsReady = true;
  }
}

function waitForPoiSourceReady() {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      map.off('sourcedata', onSourceData);
      resolve();
    };
    const onSourceData = event => {
      if (event.sourceId === POI_SOURCE && event.isSourceLoaded) finish();
    };
    const timeout = setTimeout(finish, 60000);
    map.on('sourcedata', onSourceData);
  });
}

async function show(items) {
  clearMarkers();
  list.innerHTML = '';

  const ordered = [...items].sort((a, b) => parseUtcDate(a.date) - parseUtcDate(b.date));
  markerEntries = ordered.map(item => {
    const li = document.createElement('li');
    const editorLabel = item.editorName
      ? `${item.editorName}${item.editorUid ? ` (${item.editorUid})` : ''}`
      : '編集者不明';
    const editor = item.editorName
      ? `<a class="editor-link" href="https://www.openstreetmap.org/user/${encodeURIComponent(item.editorName)}" target="_blank" rel="noopener noreferrer">${escapeHtml(editorLabel)}</a>`
      : editorLabel;
    li.innerHTML = `<div class="list-title"><img class="list-icon" src="icon/${encodeURIComponent(item.icon)}" alt=""><strong>${escapeHtml(item.name)}</strong></div><span>${escapeHtml(item.categoryName)} · ${escapeHtml(item.type)}=${escapeHtml(item.kind || '—')} · ${fmt(item.date)} · ${editor}</span>`;
    const listIcon = li.querySelector('.list-icon');
    listIcon.addEventListener('error', () => {
      if (!listIcon.src.endsWith('/marker-stroked.png')) listIcon.src = 'icon/marker-stroked.png';
    });
    li.classList.add('is-future');
    li.onclick = () => {
      map.jumpTo({center: [item.lon, item.lat], zoom: 16});
      showOsmMenu(markerEntries.find(entry => entry.listItem === li), false);
    };
    list.append(li);
    return {item, time: parseUtcDate(item.date).getTime(), listItem: li};
  });

  await loadMapIcons(markerEntries);
  ensurePoiLayers();
  status.textContent = `${markerEntries.length.toLocaleString('ja-JP')}件の地図表示を準備中…`;
  const sourceReady = waitForPoiSourceReady();
  poiFeatures = markerEntries.map((entry, entryIndex) => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [Number(entry.item.lon), Number(entry.item.lat)]},
      properties: {entryIndex, timestamp: entry.time, icon: entry.item.mapIcon},
    }));
  map.getSource(POI_SOURCE).setData({
    type: 'FeatureCollection',
    features: poiFeatures,
  });
  await sourceReady;

  setupTimeline(ordered);
  await new Promise(resolve => waitForMapIdle(resolve));
  playbackStartTimer = setTimeout(() => {
    playbackStartTimer = null;
    playTimeline();
  }, 500);
}

async function load() {
  status.textContent = '保存済みデータを読み込み中…';
  list.innerHTML = '';
  timeline.hidden = true;
  clearMarkers();
  try {
    if (!dateFrom.value || !dateTo.value || dateFrom.value > dateTo.value) {
      throw new Error('開始日と終了日を正しく選択してください。');
    }
    const [output] = await Promise.all([
      loadAllPois(days.value, dateFrom.value, dateTo.value),
      loadDefinitions(),
    ]);
    await show(output.map(item => decorateItem({...item, osmType: item.type, type: item.type2})));
  } catch (error) {
    status.textContent = `取得できませんでした: ${error.message}`;
  }
}

range.addEventListener('input', () => {
  pauseTimeline();
  updateHighlight();
});
range.addEventListener('change', () => {
  const minimum = Number(range.min);
  const snapped = minimum + Math.round((Number(range.value) - minimum) / timeStep) * timeStep;
  range.value = String(Math.min(Number(range.max), Math.max(minimum, snapped)));
  updateHighlight();
});
playButton.addEventListener('click', playTimeline);
pauseButton.addEventListener('click', pauseTimeline);
timelineStep.addEventListener('change', () => {
  pauseTimeline();
  timeStep = Number(timelineStep.value);
  highlightRadius = timeStep;
  if (!markerEntries.length) return;

  const current = Number(range.value);
  const times = markerEntries.map(entry => entry.time);
  const selectedMin = new Date(`${dateFrom.value}T00:00:00`).getTime();
  const selectedMax = new Date(`${dateTo.value}T23:59:59`).getTime();
  const minimum = Number.isFinite(selectedMin) ? selectedMin : Math.floor(Math.min(...times) / timeStep) * timeStep;
  const maximum = Number.isFinite(selectedMax) ? selectedMax : Math.ceil(Math.max(...times) / timeStep) * timeStep;
  range.min = String(minimum);
  range.max = String(Math.max(minimum + timeStep, maximum));
  range.value = String(Math.min(Number(range.max), Math.max(minimum, current)));
  timeStart.textContent = fmt(minimum);
  timeEnd.textContent = fmt(maximum);
  updateHighlight();
});
function formatInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function applyPresetDates() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - Number(days.value));
  dateFrom.value = formatInputDate(start);
  dateTo.value = formatInputDate(end);
  dateFrom.max = dateTo.value;
}

days.addEventListener('change', applyPresetDates);
function scheduleDateReload() {
  if (!dateFrom.value || !dateTo.value || dateFrom.value > dateTo.value) return;
  clearTimeout(dateReloadTimer);
  dateReloadTimer = setTimeout(load, 300);
}
dateFrom.addEventListener('change', () => {
  if (dateFrom.value > dateTo.value) dateTo.value = dateFrom.value;
  scheduleDateReload();
});
dateTo.addEventListener('change', () => {
  dateFrom.max = dateTo.value;
  if (dateFrom.value > dateTo.value) dateFrom.value = dateTo.value;
  scheduleDateReload();
});
applyPresetDates();
document.querySelector('#search').onsubmit = event => {
  event.preventDefault();
  applyPresetDates();
  load();
};
map.on('load', load);
