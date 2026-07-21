const mapPageUrl = new URL(window.location.href);
const readMapParameter = (name, minimum, maximum, fallback) => {
  const raw = mapPageUrl.searchParams.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
};
const initialLatitude = readMapParameter('lat', -85, 85, 36.2);
const initialLongitude = readMapParameter('lon', -180, 180, 137.2);
const initialZoom = readMapParameter('zoom', 2, 24, 4.15);
const STEP_PARAMETER_TO_VALUE = Object.freeze({
  '10m': '600000', '30m': '1800000', '1h': '3600000', '2h': '7200000',
  '4h': '14400000', '1d': '86400000', '1w': '604800000', '2w': '1209600000',
});
const STEP_VALUE_TO_PARAMETER = Object.fromEntries(
  Object.entries(STEP_PARAMETER_TO_VALUE).map(([parameter, value]) => [value, parameter]),
);
const validDateParameter = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year
    && parsed.getMonth() === month - 1
    && parsed.getDate() === day;
};
const requestedDateFrom = mapPageUrl.searchParams.get('from') || '';
const requestedDateTo = mapPageUrl.searchParams.get('to') || '';
const requestedStepValue = STEP_PARAMETER_TO_VALUE[mapPageUrl.searchParams.get('step')] || '';
const rawPrefectureCode = (mapPageUrl.searchParams.get('pref') || '').toUpperCase();
const requestedPrefectureCode = /^JP-\d{2}$/.test(rawPrefectureCode) ? rawPrefectureCode : '';
const requestedTimeValue = Date.parse(mapPageUrl.searchParams.get('time') || '');
let pendingSharedTime = Number.isFinite(requestedTimeValue) ? requestedTimeValue : null;
let urlStateReady = false;

const map = new maplibregl.Map({
  container: 'map',
  center: [initialLongitude, initialLatitude],
  zoom: initialZoom,
  minZoom: 2,
  maxBounds: [[118, 18], [158, 60]],
  fadeDuration: 0,
  style: './tiles/osmfj_poi.json',
});
map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

const saveMapViewToUrl = () => {
  if (urlStateReady) syncViewStateToUrl();
};

const status = document.querySelector('#status');
const list = document.querySelector('#list');
const listScroller = list;
const poiTypeSelect = document.querySelector('#poi-type');
const timeline = document.querySelector('#timeline');
const range = document.querySelector('#time-range');
const timelineLabel = document.querySelector('#timeline-label');
const timelinePrefecture = document.querySelector('#timeline-prefecture');
const timeStart = document.querySelector('#time-start');
const timeEnd = document.querySelector('#time-end');
const playButton = document.querySelector('#play-timeline');
const pauseButton = document.querySelector('#pause-timeline');
const timelineStep = document.querySelector('#timeline-step');
const days = document.querySelector('#days');
const dateFrom = document.querySelector('#date-from');
const dateTo = document.querySelector('#date-to');
const prefectureFilterReset = document.querySelector('#prefecture-filter-reset');
const shareButton = document.querySelector('#share-view');
const downloadButton = document.querySelector('#download-data');

const shareStatus = document.querySelector('#share-status');
if (requestedStepValue) timelineStep.value = requestedStepValue;

let markerEntries = [];
let poiFeatures = [];
let highlightRadius = 10 * 60 * 1000;
let playbackTimer = null;
let playbackStartTimer = null;
let playbackFrame = null;
let isPlaying = false;
let activeListItem = null;
const POPUP_OFFSETS = {
  top: [0, 8],
  'top-left': [8, 8],
  'top-right': [-8, 8],
  bottom: [0, -50],
  'bottom-left': [8, -50],
  'bottom-right': [-8, -50],
  left: [10, -24],
  right: [-10, -24],
};
const osmPopup = new maplibregl.Popup({offset: POPUP_OFFSETS, maxWidth: 'min(370px, calc(100vw - 24px))', closeButton: true, closeOnClick: true});
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
const CREATE_COLOR = '#177866';
const MODIFY_COLOR = '#c45f32';
let mapLayerEventsReady = false;
let visibleListCount = 0;
let clusterVisibleCount = -1;
let highlightedListStart = 0;
let highlightedListEnd = 0;
let dateReloadTimer = null;
let allPoiItems = [];
let selectedPoiType = '';
let prefectureFeatures = [];
let prefectureMiniMap = null;
let selectedPrefecture = '';
let renderVersion = 0;
let mainMapReady = false;
let prefectureStateReady = false;
let initialLoadStarted = false;
let shareFeedbackTimer = null;
const PREFECTURE_MINI_SOURCE = 'mini-prefectures';
const PREFECTURE_MINI_FILL_LAYER = 'mini-prefectures-fill';
const PREFECTURE_MINI_SELECTED_LAYER = 'mini-prefectures-selected';
const PREFECTURE_MAIN_SOURCE = 'selected-prefecture-boundary';
const PREFECTURE_MAIN_CASING_LAYER = 'selected-prefecture-boundary-casing';
const PREFECTURE_MAIN_LINE_LAYER = 'selected-prefecture-boundary-line';
const PREFECTURE_NAME_EXPRESSION = ['coalesce', ['get', 'name:ja'], ['get', 'name']];
const prefectureName = feature => String(feature?.properties?.['name:ja'] || feature?.properties?.name || '');
const prefectureCode = feature => String(feature?.properties?.['ISO3166-2'] || '').toUpperCase();

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

function downloadCurrentData() {
  const items = markerEntries.map(entry => entry.item);
  if (!items.length) return;
  const features = items.map(item => {
    const longitude = Number(item.lon);
    const latitude = Number(item.lat);
    const osmType = item.osmType || 'node';
    return {
      type: 'Feature',
      id: `${osmType}/${item.id}`,
      geometry: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
      properties: {
        name: item.name || '',
        prefecture: item.prefecture || '',
        update_action: item.action || '',
        update_action_label: item.action === 'create' ? '新規' : '更新',
        updated_at: item.date || '',
        updated_at_jst: fmt(item.date),
        category: item.type || '',
        category_value: item.kind || '',
        category_name: item.categoryName || '',
        osm_type: osmType,
        osm_id: String(item.id ?? ''),
        changeset: String(item.changeset ?? ''),
        editor_name: item.editorName || '',
        editor_uid: String(item.editorUid ?? ''),
        tags: Object.fromEntries(
          Object.entries(item.tags || {}).sort(([left], [right]) => left.localeCompare(right)),
        ),
      },
    };
  }).filter(feature => feature.geometry.coordinates.every(Number.isFinite));
  if (!features.length) return;
  const geojson = {
    type: 'FeatureCollection',
    name: 'OSM What’s New Japan',
    metadata: {
      generated_at: new Date().toISOString(),
      period_from: dateFrom.value,
      period_to: dateTo.value,
      prefecture: selectedPrefecture || '',
      feature_count: features.length,
      license: 'Open Database License (ODbL) 1.0',
      license_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
      attribution: '© OpenStreetMap contributors',
      attribution_url: 'https://www.openstreetmap.org/copyright',
      attribution_required: true,
    },
    features,
  };
  const url = URL.createObjectURL(new Blob(
    [JSON.stringify(geojson, null, 2)],
    {type: 'application/geo+json;charset=utf-8'},
  ));
  const link = document.createElement('a');
  const area = (selectedPrefecture || 'japan').replace(/[\\/:*?"<>|]/g, '_');
  link.href = url;
  link.download = `osm-whatsnew_${area}_${dateFrom.value}_${dateTo.value}.geojson`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
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

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  return pointInRing(point, polygon[0])
    && !polygon.slice(1).some(hole => pointInRing(point, hole));
}

function prefectureContains(feature, point) {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return pointInPolygon(point, geometry.coordinates);
  return geometry.coordinates.some(polygon => pointInPolygon(point, polygon));
}

function prefectureBounds(feature) {
  if (feature._bounds) return feature._bounds;
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = value => {
    if (typeof value[0] === 'number') {
      result[0] = Math.min(result[0], value[0]);
      result[1] = Math.min(result[1], value[1]);
      result[2] = Math.max(result[2], value[0]);
      result[3] = Math.max(result[3], value[1]);
    } else value.forEach(visit);
  };
  visit(feature.geometry.coordinates);
  feature._bounds = result;
  return result;
}

function selectedPrefectureFeature() {
  return prefectureFeatures.find(feature => prefectureName(feature) === selectedPrefecture) || null;
}

function syncViewStateToUrl({includeTime = false, updateHistory = true} = {}) {
  const url = new URL(window.location.href);
  const center = map.getCenter();
  url.searchParams.set('lat', center.lat.toFixed(5));
  url.searchParams.set('lon', center.lng.toFixed(5));
  url.searchParams.set('zoom', map.getZoom().toFixed(2));

  const code = prefectureCode(selectedPrefectureFeature());
  if (code) url.searchParams.set('pref', code);
  else if (!prefectureStateReady && requestedPrefectureCode) url.searchParams.set('pref', requestedPrefectureCode);
  else url.searchParams.delete('pref');

  if (validDateParameter(dateFrom.value)) url.searchParams.set('from', dateFrom.value);
  else url.searchParams.delete('from');
  if (validDateParameter(dateTo.value)) url.searchParams.set('to', dateTo.value);
  else url.searchParams.delete('to');

  const stepParameter = STEP_VALUE_TO_PARAMETER[timelineStep.value];
  if (stepParameter) url.searchParams.set('step', stepParameter);
  else url.searchParams.delete('step');

  if (!includeTime) {
    url.searchParams.delete('time');
  } else if (pendingSharedTime !== null) {
    url.searchParams.set('time', new Date(pendingSharedTime).toISOString());
  } else if (!timeline.hidden && Number.isFinite(Number(range.value))) {
    url.searchParams.set('time', new Date(Number(range.value)).toISOString());
  } else {
    url.searchParams.delete('time');
  }
  if (updateHistory) window.history.replaceState(null, '', url);
  return url;
}

function resetSharedTimelineTime() {
  pendingSharedTime = null;
  syncViewStateToUrl({includeTime: false});
}

function ensureMainPrefectureLayers() {
  if (!prefectureFeatures.length || !map.isStyleLoaded()) return;
  const data = {type: 'FeatureCollection', features: prefectureFeatures};
  if (!map.getSource(PREFECTURE_MAIN_SOURCE)) {
    map.addSource(PREFECTURE_MAIN_SOURCE, {type: 'geojson', data});
  }
  const beforeLayer = map.getLayer(POI_HIGHLIGHT_LAYER) ? POI_HIGHLIGHT_LAYER : undefined;
  if (!map.getLayer(PREFECTURE_MAIN_CASING_LAYER)) {
    map.addLayer({
      id: PREFECTURE_MAIN_CASING_LAYER,
      type: 'line',
      source: PREFECTURE_MAIN_SOURCE,
      filter: ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture],
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 5, 8, 9, 14, 13],
        'line-opacity': 0.95,
      },
    }, beforeLayer);
  }
  if (!map.getLayer(PREFECTURE_MAIN_LINE_LAYER)) {
    map.addLayer({
      id: PREFECTURE_MAIN_LINE_LAYER,
      type: 'line',
      source: PREFECTURE_MAIN_SOURCE,
      filter: ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture],
      paint: {
        'line-color': '#f05a24',
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2.5, 8, 5.5, 14, 8],
        'line-opacity': 1,
      },
    }, beforeLayer);
  }
}

function updatePrefectureMiniMapSelection() {
  prefectureFilterReset.disabled = !selectedPrefecture;
  prefectureFilterReset.hidden = !selectedPrefecture;
  timelinePrefecture.textContent = selectedPrefecture || '全国';
  timelinePrefecture.hidden = false;
  timeline.classList.add('has-prefecture');
  if (prefectureMiniMap?.getLayer(PREFECTURE_MINI_SELECTED_LAYER)) {
    prefectureMiniMap.setFilter(PREFECTURE_MINI_SELECTED_LAYER, ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture]);
  }
  ensureMainPrefectureLayers();
  [PREFECTURE_MAIN_CASING_LAYER, PREFECTURE_MAIN_LINE_LAYER].forEach(layer => {
    if (map.getLayer(layer)) map.setFilter(layer, ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture]);
  });
}

function filterPoiItems(feature) {
  if (!feature) return allPoiItems;
  const box = prefectureBounds(feature);
  return allPoiItems.filter(item => {
    const storedPrefecture = String(item.prefecture ?? '').trim();
    if (storedPrefecture) return storedPrefecture === selectedPrefecture;
    const point = [Number(item.lon), Number(item.lat)];
    return point[0] >= box[0] && point[0] <= box[2]
      && point[1] >= box[1] && point[1] <= box[3]
      && prefectureContains(feature, point);
  });
}

const poiTypeKey = item => JSON.stringify([
  String(item.type ?? ''),
  String(item.kind ?? ''),
]);

const excludedPoiTypeTags = new Set([
  'name',
  'ele',
  'addr:block_number',
  'source',
  'access',
  'check_date',
  'cuisine',
  'bath:type',
]);

function updatePoiTypeOptions(items) {
  const optionsByKey = new Map();
  items.forEach(item => {
    if (excludedPoiTypeTags.has(String(item.type ?? '').trim())) return;
    const key = poiTypeKey(item);
    const current = optionsByKey.get(key);
    if (current) {
      current.count++;
      return;
    }
    const tag = `${item.type || '—'}=${item.kind || '—'}`;
    optionsByKey.set(key, {
      key,
      label: item.categoryName || tag,
      tag,
      count: 1,
    });
  });

  const options = [...optionsByKey.values()].sort((left, right) => (
    left.label.localeCompare(right.label, 'ja')
      || left.tag.localeCompare(right.tag)
  ));
  poiTypeSelect.replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = `すべての種別（${items.length.toLocaleString('ja-JP')}件）`;
  poiTypeSelect.append(allOption);
  options.forEach(entry => {
    const option = document.createElement('option');
    option.value = entry.key;
    option.textContent = `${entry.label}（${entry.tag}・${entry.count.toLocaleString('ja-JP')}件）`;
    poiTypeSelect.append(option);
  });

  if (!optionsByKey.has(selectedPoiType)) selectedPoiType = '';
  poiTypeSelect.value = selectedPoiType;
  poiTypeSelect.disabled = items.length === 0;
}

async function applyPrefectureFilter(fitMap = false) {
  const feature = selectedPrefectureFeature();
  updatePrefectureMiniMapSelection();
  if (fitMap && feature) {
    const box = prefectureBounds(feature);
    map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {padding: 42, duration: 350, maxZoom: 9});
  }
  const areaItems = filterPoiItems(feature);
  updatePoiTypeOptions(areaItems);
  const filteredItems = selectedPoiType
    ? areaItems.filter(item => poiTypeKey(item) === selectedPoiType)
    : areaItems;
  await show(filteredItems);
  if (!filteredItems.length) {
    const area = selectedPrefecture || '全国';
    status.textContent = `${area}：選択期間のPOIは0件です。`;
  }
}

async function initializePrefectureMiniMap() {
  const response = await fetch('data/prefectures.min.geojson');
  if (!response.ok) throw new Error(`都道府県地図: ${response.status}`);
  const geojson = await response.json();
  prefectureFeatures = geojson.features || [];
  if (requestedPrefectureCode) {
    const requestedFeature = prefectureFeatures.find(feature => prefectureCode(feature) === requestedPrefectureCode);
    if (requestedFeature) selectedPrefecture = prefectureName(requestedFeature);
  }
  ensureMainPrefectureLayers();
  prefectureMiniMap = new maplibregl.Map({
    container: 'prefecture-mini-map',
    center: [136.3, 35.5],
    zoom: 3.15,
    maxZoom: 7,
    maxBounds: [[118, 18], [158, 50]],
    pitch: 0,
    bearing: 0,
    antialias: true,
    fadeDuration: 0,
    attributionControl: false,
    dragPan: true,
    scrollZoom: true,
    boxZoom: true,
    dragRotate: false,
    keyboard: true,
    doubleClickZoom: true,
    touchZoomRotate: false,
    style: './tiles/osmfj_poi.json',
  });
  prefectureMiniMap.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-right');
  prefectureMiniMap.on('load', () => {
    prefectureMiniMap.setPitch(0);
    prefectureMiniMap.setBearing(0);
    prefectureMiniMap.addSource(PREFECTURE_MINI_SOURCE, {type: 'geojson', data: geojson});
    prefectureMiniMap.addLayer({
      id: PREFECTURE_MINI_FILL_LAYER,
      type: 'fill',
      source: PREFECTURE_MINI_SOURCE,
      paint: {
        'fill-color': '#8bc99a',
        'fill-opacity': 0.28,
        'fill-outline-color': '#285b47',
      },
    });
    prefectureMiniMap.addLayer({
      id: PREFECTURE_MINI_SELECTED_LAYER,
      type: 'fill',
      source: PREFECTURE_MINI_SOURCE,
      filter: ['==', PREFECTURE_NAME_EXPRESSION, selectedPrefecture],
      paint: {
        'fill-color': '#f08024',
        'fill-opacity': 0.72,
        'fill-outline-color': '#7b2d00',
      },
    });
    prefectureMiniMap.addLayer({
      id: 'mini-prefectures-outline',
      type: 'line',
      source: PREFECTURE_MINI_SOURCE,
      paint: {'line-color': '#285b47', 'line-width': 1.2, 'line-opacity': 0.9},
    });
    prefectureMiniMap.on('click', PREFECTURE_MINI_FILL_LAYER, event => {
      const name = prefectureName(event.features?.[0]);
      if (!name) return;
      selectedPrefecture = name;
      updatePrefectureMiniMapSelection();
      const box = prefectureBounds(selectedPrefectureFeature());
      map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {padding: 42, duration: 350, maxZoom: 9});
      resetSharedTimelineTime();
      load();
    });
    prefectureMiniMap.on('mouseenter', PREFECTURE_MINI_FILL_LAYER, () => {
      prefectureMiniMap.getCanvas().style.cursor = 'pointer';
    });
    prefectureMiniMap.on('mouseleave', PREFECTURE_MINI_FILL_LAYER, () => {
      prefectureMiniMap.getCanvas().style.cursor = '';
    });
    updatePrefectureMiniMapSelection();
  });
}

async function loadAllPois(daysValue, fromValue, toValue, prefectureValue = '') {
  const pageSize = 1000;
  const maximumRequests = 50;
  const rows = [];
  let cursor = '';
  for (let request = 1; request <= maximumRequests; request++) {
    const query = new URLSearchParams({
      mode: 'pois',
      days: daysValue,
      from: fromValue,
      to: toValue,
      limit: String(pageSize),
    });
    if (prefectureValue) query.set('prefecture', prefectureValue);
    if (cursor) query.set('cursor', cursor);
    const data = await json(`api.php?${query}`);
    const batch = Array.isArray(data.items) ? data.items : [];
    rows.push(...batch);
    status.textContent = `${rows.length.toLocaleString('ja-JP')}件を読み込み中…`;
    cursor = String(data.meta?.nextCursor || '');
    if (!cursor) return rows;
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
  downloadButton.disabled = true;
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
  status.textContent = `${selectedPrefecture ? `${selectedPrefecture}：` : ''}${markerEntries.length}件中 ${visible}件を表示`;
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
  addDetail('更新種別', entry.item.action === 'create' ? '新規' : '更新');
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
    pendingSharedTime = null;
    syncViewStateToUrl({includeTime: false});
    return false;
  }
  const times = items.map(item => parseUtcDate(item.date).getTime()).filter(Number.isFinite);
  const selectedMin = new Date(`${dateFrom.value}T00:00:00`).getTime();
  const selectedMax = new Date(`${dateTo.value}T23:59:59`).getTime();
  const min = Number.isFinite(selectedMin) ? selectedMin : Math.floor(Math.min(...times) / timeStep) * timeStep;
  const max = Number.isFinite(selectedMax) ? selectedMax : Math.ceil(Math.max(...times) / timeStep) * timeStep;
  const maximum = Math.max(min + timeStep, max);
  const restoredSharedTime = pendingSharedTime !== null;
  const initialTime = restoredSharedTime
    ? Math.min(maximum, Math.max(min, pendingSharedTime))
    : min;
  pendingSharedTime = null;
  highlightRadius = timeStep;
  range.min = String(min);
  range.max = String(maximum);
  // Playback moves continuously; logical destinations remain selected interval steps.
  range.step = 'any';
  range.value = String(initialTime);
  timeStart.textContent = fmt(min);
  timeEnd.textContent = fmt(max);
  // Keep the timeline hidden until the POI source has finished rendering.
  range.disabled = false;
  playButton.disabled = false;
  pauseButton.disabled = true;
  updateHighlight();
  syncViewStateToUrl();
  return restoredSharedTime;
}

function createPinImage(source, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 76;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.scale(2, 2);
  context.beginPath();
  context.moveTo(19, 47);
  context.bezierCurveTo(16, 41, 3, 30, 3, 19);
  context.bezierCurveTo(3, 10.2, 10.2, 3, 19, 3);
  context.bezierCurveTo(27.8, 3, 35, 10.2, 35, 19);
  context.bezierCurveTo(35, 30, 22, 41, 19, 47);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#fff';
  context.stroke();

  const iconCanvas = document.createElement('canvas');
  iconCanvas.width = 40;
  iconCanvas.height = 40;
  const iconContext = iconCanvas.getContext('2d');
  iconContext.drawImage(source, 0, 0, 40, 40);
  iconContext.globalCompositeOperation = 'source-in';
  iconContext.fillStyle = '#fff';
  iconContext.fillRect(0, 0, 40, 40);
  context.drawImage(iconCanvas, 9, 9, 20, 20);
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
    const action = entry.item.action === 'create' ? 'create' : 'modify';
    const imageId = `poi-${action}-${entry.item.icon}`;
    entry.item.mapIcon = imageId;
    if (!map.hasImage(imageId)) {
      const color = action === 'create' ? CREATE_COLOR : MODIFY_COLOR;
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
        'circle-color': ['step', ['get', 'point_count'], '#78909c', 25, '#607d8b', 100, '#455a64'],
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
      paint: {'circle-color': ['match', ['get', 'action'], 'create', CREATE_COLOR, MODIFY_COLOR], 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2},
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
  const currentRender = ++renderVersion;
  clearMarkers();
  list.innerHTML = '';

  const ordered = [...items].sort((a, b) => parseUtcDate(a.date) - parseUtcDate(b.date));
  if (!ordered.length) {
    setupTimeline([]);
    return;
  }
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
  if (currentRender !== renderVersion) return;
  ensurePoiLayers();
  status.textContent = `${markerEntries.length.toLocaleString('ja-JP')}件の地図表示を準備中…`;
  poiFeatures = markerEntries.map((entry, entryIndex) => ({
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [Number(entry.item.lon), Number(entry.item.lat)]},
      properties: {entryIndex, timestamp: entry.time, icon: entry.item.mapIcon, action: entry.item.action},
    }));
  // Set the initial time filters before filling the source so an unfiltered
  // frame containing every POI can never be painted.
  setupTimeline(ordered);
  status.textContent = `${markerEntries.length.toLocaleString('ja-JP')}件の地図表示を準備中…`;
  const sourceReady = waitForPoiSourceReady();
  map.getSource(POI_SOURCE).setData({
    type: 'FeatureCollection',
    features: poiFeatures,
  });
  await sourceReady;
  if (currentRender !== renderVersion) return;

  await new Promise(resolve => waitForMapIdle(resolve));
  if (currentRender !== renderVersion) return;
  status.hidden = true;
  downloadButton.disabled = false;
  timeline.hidden = false;
  syncViewStateToUrl();
  playbackStartTimer = setTimeout(() => {
    playbackStartTimer = null;
    playTimeline();
  }, 500);
}

async function load() {
  status.hidden = false;
  status.textContent = '保存済みデータを読み込み中…';
  list.innerHTML = '';
  poiTypeSelect.disabled = true;
  timeline.hidden = true;
  clearMarkers();
  try {
    if (!dateFrom.value || !dateTo.value || dateFrom.value > dateTo.value) {
      throw new Error('開始日と終了日を正しく選択してください。');
    }
    const [output] = await Promise.all([
      loadAllPois(days.value, dateFrom.value, dateTo.value, selectedPrefecture),
      loadDefinitions(),
    ]);
    allPoiItems = output.map(item => decorateItem({...item, osmType: item.type, type: item.type2}));
    await applyPrefectureFilter(false);
  } catch (error) {
    timeline.hidden = true;
    status.hidden = false;
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
  if (!markerEntries.length) {
    syncViewStateToUrl();
    return;
  }

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
  syncViewStateToUrl();
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

days.addEventListener('change', () => {
  applyPresetDates();
  resetSharedTimelineTime();
  load();
});
function scheduleDateReload() {
  if (!dateFrom.value || !dateTo.value || dateFrom.value > dateTo.value) return;
  clearTimeout(dateReloadTimer);
  resetSharedTimelineTime();
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
if (validDateParameter(requestedDateFrom)
  && validDateParameter(requestedDateTo)
  && requestedDateFrom <= requestedDateTo) {
  dateFrom.value = requestedDateFrom;
  dateTo.value = requestedDateTo;
  dateFrom.max = dateTo.value;
} else {
  applyPresetDates();
}

prefectureFilterReset.addEventListener('click', () => {
  selectedPrefecture = '';
  updatePrefectureMiniMapSelection();
  resetSharedTimelineTime();
  load();
});

poiTypeSelect.addEventListener('change', async () => {
  const currentTime = timeline.hidden ? NaN : Number(range.value);
  selectedPoiType = poiTypeSelect.value;
  if (Number.isFinite(currentTime)) pendingSharedTime = currentTime;
  try {
    await applyPrefectureFilter(false);
    pauseTimeline();
  } catch (error) {
    status.hidden = false;
    status.textContent = `種別を変更できませんでした: ${error.message}`;
  }
});

function showShareFeedback(label, stateClass, statusText, duration = 1800) {
  if (!shareButton || !shareStatus) return;
  clearTimeout(shareFeedbackTimer);
  shareButton.classList.remove('is-copied', 'is-error');
  shareButton.classList.add(stateClass);
  shareButton.title = statusText;
  shareButton.setAttribute('aria-label', statusText);
  shareStatus.textContent = statusText;
  shareFeedbackTimer = setTimeout(() => {
    shareButton.classList.remove('is-copied', 'is-error');
    shareButton.title = '現在の表示URLをコピー';
    shareButton.setAttribute('aria-label', '現在の表示URLをコピー');
    shareStatus.textContent = '';
  }, duration);
}

async function copyCurrentViewUrl() {
  const url = syncViewStateToUrl({updateHistory: false}).toString();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const input = document.createElement('textarea');
      input.value = url;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('copy failed');
    }
    showShareFeedback('コピー済み', 'is-copied', '現在の表示URLをコピーしました。');
  } catch {
    showShareFeedback('コピー失敗', 'is-error', 'URLをコピーできませんでした。', 2500);
    window.prompt('このURLをコピーしてください。', url);
  }
}
downloadButton.addEventListener('click', downloadCurrentData);
shareButton?.addEventListener('click', copyCurrentViewUrl);

function startInitialLoadWhenReady() {
  if (initialLoadStarted || !mainMapReady || !prefectureStateReady) return;
  initialLoadStarted = true;
  updatePrefectureMiniMapSelection();
  syncViewStateToUrl();
  load();
}

initializePrefectureMiniMap().catch(error => {
  status.textContent = `都道府県地図を読み込めませんでした: ${error.message}`;
  console.error(error);
}).finally(() => {
  prefectureStateReady = true;
  startInitialLoadWhenReady();
});
function handleMainMapReady() {
  if (mainMapReady) return;
  mainMapReady = true;
  ensureMainPrefectureLayers();
  updatePrefectureMiniMapSelection();
  startInitialLoadWhenReady();
}

urlStateReady = true;
map.on('moveend', saveMapViewToUrl);
saveMapViewToUrl();
if (map.isStyleLoaded()) handleMainMapReady();
else map.once('load', handleMainMapReady);
