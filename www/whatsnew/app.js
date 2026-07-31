const mapPageUrl = new URL(window.location.href);
const initialMapView = window.osmSharedMapView.read({
  fallbackCenter: [137.2, 36.2],
  fallbackZoom: 4.15,
  minZoom: 2,
  maxZoom: 22,
});
const initialLatitude = initialMapView.center[1];
const initialLongitude = initialMapView.center[0];
const initialZoom = initialMapView.zoom;
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
const requestedDaysValue = mapPageUrl.searchParams.get('days') || '';
const requestedDateFrom = mapPageUrl.searchParams.get('from') || '';
const requestedDateTo = mapPageUrl.searchParams.get('to') || '';
const requestedStepValue = STEP_PARAMETER_TO_VALUE[mapPageUrl.searchParams.get('step')] || '';
const rawPrefectureCode = (mapPageUrl.searchParams.get('pref') || '').toUpperCase();
const requestedPrefectureCode = /^JP-\d{2}$/.test(rawPrefectureCode) ? rawPrefectureCode : '';
const requestedTimeValue = Date.parse(mapPageUrl.searchParams.get('time') || '');
let pendingSharedTime = Number.isFinite(requestedTimeValue) ? requestedTimeValue : null;
if (mapPageUrl.search) {
  const cleanUrl = new URL(mapPageUrl);
  cleanUrl.search = '';
  window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.hash);
}

const map = new maplibregl.Map({
  container: 'map',
  center: [initialLongitude, initialLatitude],
  zoom: initialZoom,
  minZoom: 2,
  maxBounds: [[118, 18], [158, 60]],
  pitchWithRotate: true,
  touchPitch: true,
  fadeDuration: 0,
  style: './tiles/osmfj_nopoi.json',
});
map.addControl(new maplibregl.NavigationControl({visualizePitch: true}), 'bottom-right');
window.osmSharedMapView.bind(map);


const status = document.querySelector('#status');
const list = document.querySelector('#list');
const listScroller = list;
const poiTypeSelect = document.querySelector('#poi-type');
const timeline = document.querySelector('#timeline');
const range = document.querySelector('#time-range');
const timelineSummaryPrefecture = document.querySelector('#timeline-summary-prefecture');
const timelineSummaryDatetime = document.querySelector('#timeline-summary-datetime');
const timelineSummaryCount = document.querySelector('#timeline-summary-count');
const timelineDetails = document.querySelector('#timeline-details');
const timelineToggle = document.querySelector('#timeline-toggle');
const summaryPlayButton = document.querySelector('#summary-play-timeline');
const timeStart = document.querySelector('#time-start');
const timeEnd = document.querySelector('#time-end');
const prefectureFilter = document.querySelector('#prefecture-filter');
const prefectureFilterToggle = document.querySelector('#prefecture-filter-toggle');
const timelineStep = document.querySelector('#timeline-step');
const days = document.querySelector('#days');
if ([...days.options].some(option => option.value === requestedDaysValue)) days.value = requestedDaysValue;
const dateFrom = document.querySelector('#date-from');
const dateTo = document.querySelector('#date-to');
const prefectureFilterReset = document.querySelector('#prefecture-filter-reset');
const shareButton = document.querySelector('#share-view');
const downloadButton = document.querySelector('#download-data');
const downloadCsvButton = document.querySelector('#download-csv');
const mobilePrefectureFilterMedia = window.matchMedia('(max-width: 700px) and (max-aspect-ratio: 1/1)');
const guide = window.osmWhatsNewGuide;
const guideDialog = guide?.dialog;

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
let activeListEntryIndex = -1;
const VIRTUAL_LIST_ROW_HEIGHT = 72;
const VIRTUAL_LIST_OVERSCAN = 10;
const RENDER_CHUNK_SIZE = 1000;
let virtualListStart = -1;
let virtualListEnd = -1;
let virtualListFrame = null;
let activeLoadController = null;
let loadVersion = 0;
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
let listTargetVisibleCount = 0;
let listScrollAnimationFrame = null;
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
let resumePlaybackAfterGuide = false;
let automaticPlaybackPending = false;
let apiUrl = '';
let configurationPromise = null;

function setPrefectureFilterExpanded(expanded) {
  prefectureFilterToggle.setAttribute('aria-expanded', String(expanded));
  prefectureFilter.hidden = !expanded;
  document.body.classList.toggle('is-mobile-prefecture-selecting', expanded && mobilePrefectureFilterMedia.matches);
  renderVirtualList(true);
  if (expanded) requestAnimationFrame(() => prefectureMiniMap?.resize());
}

function closeMobilePrefectureFilter() {
  if (mobilePrefectureFilterMedia.matches) setPrefectureFilterExpanded(false);
}

mobilePrefectureFilterMedia.addEventListener('change', () => {
  const expanded = prefectureFilterToggle.getAttribute('aria-expanded') === 'true';
  document.body.classList.toggle('is-mobile-prefecture-selecting', expanded && mobilePrefectureFilterMedia.matches);
  if (expanded) requestAnimationFrame(() => prefectureMiniMap?.resize());
});

const PREFECTURE_MINI_SOURCE = 'mini-prefectures';
const PREFECTURE_MINI_FILL_LAYER = 'mini-prefectures-fill';
const PREFECTURE_MINI_SELECTED_LAYER = 'mini-prefectures-selected';
const PREFECTURE_MAIN_SOURCE = 'selected-prefecture-boundary';
const PREFECTURE_MAIN_CASING_LAYER = 'selected-prefecture-boundary-casing';
const PREFECTURE_MAIN_LINE_LAYER = 'selected-prefecture-boundary-line';
const PREFECTURE_NAME_EXPRESSION = ['coalesce', ['get', 'name:ja'], ['get', 'name']];
const prefectureName = feature => String(feature?.properties?.['name:ja'] || feature?.properties?.name || '');
const prefectureCode = feature => String(feature?.properties?.['ISO3166-2'] || '').toUpperCase();

function updateTimelineSummary() {
  timelineSummaryPrefecture.textContent = selectedPrefecture || '全国';
  if (!markerEntries.length) {
    timelineSummaryDatetime.textContent = '—';
    timelineSummaryDatetime.removeAttribute('datetime');
    timelineSummaryDatetime.removeAttribute('title');
  }
  timelineSummaryCount.textContent = '更新0件（累積0件）';
}

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
const fmtTimelineSummary = fmt;
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

function downloadCurrentCsv() {
  const rows = markerEntries.map(entry => entry.item).map(item => {
    const longitude = Number(item.lon);
    const latitude = Number(item.lat);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
    return [
      item.name || '',
      item.prefecture || '',
      item.action || '',
      item.action === 'create' ? '新規' : '更新',
      item.date || '',
      fmt(item.date),
      item.type || '',
      item.kind || '',
      item.categoryName || '',
      item.osmType || 'node',
      String(item.id ?? ''),
      String(item.changeset ?? ''),
      item.editorName || '',
      String(item.editorUid ?? ''),
      latitude,
      longitude,
      JSON.stringify(Object.fromEntries(
        Object.entries(item.tags || {}).sort(([left], [right]) => left.localeCompare(right)),
      )),
    ];
  }).filter(Boolean);
  if (!rows.length) return;

  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const headers = [
    'name', 'prefecture', 'update_action', 'update_action_label',
    'updated_at', 'updated_at_jst', 'category', 'category_value',
    'category_name', 'osm_type', 'osm_id', 'changeset',
    'editor_name', 'editor_uid', 'latitude', 'longitude', 'tags',
  ];
  const csv = '\uFEFF' + [headers, ...rows]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a');
  const area = (selectedPrefecture || 'japan').replace(/[\\/:*?"<>|]/g, '_');
  link.href = url;
  link.download = `osm-whatsnew_${area}_${dateFrom.value}_${dateTo.value}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function json(url, signal) {
  const response = await fetch(url, {signal});
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

function buildCurrentViewUrl({includeTime = false} = {}) {
  const url = new URL(window.location.href);
  const center = map.getCenter();
  url.searchParams.set('lat', center.lat.toFixed(5));
  url.searchParams.set('lon', center.lng.toFixed(5));
  url.searchParams.set('zoom', map.getZoom().toFixed(2));

  const code = prefectureCode(selectedPrefectureFeature());
  if (code) url.searchParams.set('pref', code);
  else if (!prefectureStateReady && requestedPrefectureCode) url.searchParams.set('pref', requestedPrefectureCode);
  else url.searchParams.delete('pref');

  if (days.value) url.searchParams.set('days', days.value);
  else url.searchParams.delete('days');

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
  return url;
}

function resetSharedTimelineTime() {
  pendingSharedTime = null;
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
  updateTimelineSummary();
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
  'disused:amenity',
  'disused:shop',
  'disused:tourism',
  'disused:emergency',
  'disused:office',
  'brand',
  'name',
  'ele',
  'addr:block_number',
  'source',
  'access',
  'check_date',
  'cuisine',
  'bath:type',
]);

const OTHER_POI_TYPE_KEY = '__other__';
const poiTypeOptionKey = item => (
  excludedPoiTypeTags.has(String(item.type ?? '').trim())
    ? OTHER_POI_TYPE_KEY
    : poiTypeKey(item)
);

function updatePoiTypeOptions(items) {
  const optionsByKey = new Map();
  items.forEach(item => {
    const key = poiTypeOptionKey(item);
    const current = optionsByKey.get(key);
    if (current) {
      current.count++;
      return;
    }
    if (key === OTHER_POI_TYPE_KEY) {
      optionsByKey.set(key, {
        key,
        label: 'その他',
        tag: '',
        count: 1,
        isOther: true,
      });
      return;
    }
    const tag = `${item.type || '—'}=${item.kind || '—'}`;
    optionsByKey.set(key, {
      key,
      label: item.categoryName || tag,
      tag,
      count: 1,
      isOther: false,
    });
  });

  const options = [...optionsByKey.values()].sort((left, right) => (
    Number(left.isOther) - Number(right.isOther)
      || left.label.localeCompare(right.label, 'ja')
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
    option.textContent = entry.isOther
      ? `${entry.label}（${entry.count.toLocaleString('ja-JP')}件）`
      : `${entry.label}（${entry.tag}・${entry.count.toLocaleString('ja-JP')}件）`;
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
    ? areaItems.filter(item => poiTypeOptionKey(item) === selectedPoiType)
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
    style: './tiles/osmfj_nopoi.json',
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
      closeMobilePrefectureFilter();
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

async function loadAllPois(daysValue, fromValue, toValue, prefectureValue = '', signal) {
  const pageSize = 5000;
  const maximumRequests = 10;
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
    const data = await json(`${apiUrl}?${query}`, signal);
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

function loadConfiguration() {
  if (!configurationPromise) {
    configurationPromise = jsonc('data/config.jsonc').then(configuration => {
      const configuredApiUrl = String(configuration.apiUrl || '').trim();
      if (!/^https?:\/\//.test(configuredApiUrl)) {
        throw new Error('data/config.jsonc の apiUrl に絶対URLを指定してください。');
      }
      apiUrl = configuredApiUrl;
    });
  }
  return configurationPromise;
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
    if (key === '*' || key === 'building' || !tags[key]) continue;
    if (values[tags[key]]) return values[tags[key]];
    if (values['*']) return values['*'];
  }
  const buildingRules = rules.building;
  if (buildingRules && tags.building) {
    if (buildingRules[tags.building]) return buildingRules[tags.building];
    if (buildingRules['*']) return buildingRules['*'];
  }
  return rules['*']?.['*'] || fallback;
}

function lookupPrimaryRule(rules, tags, primaryKey, primaryValue, fallback) {
  const primaryRules = rules[primaryKey];
  if (primaryKey !== 'building' && primaryRules && primaryValue) {
    if (primaryRules[primaryValue]) return primaryRules[primaryValue];
    if (primaryRules['*']) return primaryRules['*'];
  }
  return lookupRule(rules, tags, fallback);
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
    icon: lookupPrimaryRule(markerRules, tags, item.type, item.kind, 'marker-stroked.png'),
    categoryName: lookupPrimaryRule(categoryRules, tags, item.type, item.kind, item.kind || '—'),
  };
}

function clearMarkers() {
  pauseTimeline();
  osmPopup.remove();
  activeListItem = null;
  activeListEntryIndex = -1;
  if (map.getSource(POI_SOURCE)) {
    map.getSource(POI_SOURCE).setData({type: 'FeatureCollection', features: []});
  }
  if (map.getSource(CLUSTER_SOURCE)) {
    map.getSource(CLUSTER_SOURCE).setData({type: 'FeatureCollection', features: []});
  }
  markerEntries = [];
  poiFeatures = [];
  updateTimelineSummary();
  downloadButton.disabled = true;
  downloadCsvButton.disabled = true;
  visibleListCount = 0;
  clusterVisibleCount = -1;
  highlightedListStart = 0;
  highlightedListEnd = 0;
  listTargetVisibleCount = 0;
  if (listScrollAnimationFrame !== null) {
    cancelAnimationFrame(listScrollAnimationFrame);
    listScrollAnimationFrame = null;
  }
  resetVirtualList();
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
  summaryPlayButton.textContent = '再生';
  summaryPlayButton.setAttribute('aria-label', 'タイムラインを再生');
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
  if (guideDialog?.open) return;
  pauseTimeline();
  if (Number(range.value) >= Number(range.max)) range.value = range.min;
  isPlaying = true;
  summaryPlayButton.textContent = '停止';
  summaryPlayButton.setAttribute('aria-label', 'タイムラインを停止');
  updateHighlight();
  playNextStep();
}


function startPendingAutomaticPlayback() {
  if (!automaticPlaybackPending || guideDialog?.open || timeline.hidden || !markerEntries.length) return;
  automaticPlaybackPending = false;
  if (playbackStartTimer !== null) return;
  playbackStartTimer = setTimeout(() => {
    playbackStartTimer = null;
    if (guideDialog?.open) {
      automaticPlaybackPending = true;
      return;
    }
    playTimeline();
  }, 500);
}

function requestAutomaticPlayback() {
  automaticPlaybackPending = true;
  startPendingAutomaticPlayback();
}

function handleGuideBeforeOpen(event) {
  const mode = event.detail?.mode || 'manual';
  resumePlaybackAfterGuide = mode === 'manual' && isPlaying;
  if (mode === 'manual') automaticPlaybackPending = false;
  pauseTimeline();
}

function handleGuideClosed(event) {
  const mode = event.detail?.mode || '';
  const shouldResume = mode === 'manual' && resumePlaybackAfterGuide;
  resumePlaybackAfterGuide = false;

  if (mode === 'automatic') {
    startPendingAutomaticPlayback();
  } else if (mode === 'manual') {
    automaticPlaybackPending = false;
    if (shouldResume && !timeline.hidden && markerEntries.length) playTimeline();
  }
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

const waitForNextPaint = () => new Promise(resolve => requestAnimationFrame(resolve));

function resetVirtualList() {
  if (virtualListFrame !== null) {
    cancelAnimationFrame(virtualListFrame);
    virtualListFrame = null;
  }
  virtualListStart = -1;
  virtualListEnd = -1;
  list.replaceChildren();
  list.scrollTop = 0;
}

function createVirtualListSpacer(height) {
  const spacer = document.createElement('li');
  spacer.className = 'virtual-list-spacer';
  spacer.style.height = `${Math.max(0, height)}px`;
  spacer.setAttribute('aria-hidden', 'true');
  return spacer;
}

function createListItem(entry, index) {
  const {item} = entry;
  const li = document.createElement('li');
  li.dataset.entryIndex = String(index);
  const editorLabel = item.editorName
    ? `${item.editorName}${item.editorUid ? ` (${item.editorUid})` : ''}`
    : '編集者不明';
  const editor = item.editorName
    ? `<a class="editor-link" href="https://www.openstreetmap.org/user/${encodeURIComponent(item.editorName)}" target="_blank" rel="noopener noreferrer">${escapeHtml(editorLabel)}</a>`
    : editorLabel;
  li.innerHTML = `<div class="list-title"><img class="list-icon" src="icon/${encodeURIComponent(item.icon)}" alt=""><strong>${escapeHtml(item.name)}</strong></div><span>${escapeHtml(item.categoryName)} · ${fmt(item.date)} · ${editor}</span>`;
  li.classList.toggle('is-highlighted', index >= highlightedListStart && index < highlightedListEnd);
  li.classList.toggle('is-selected', index === activeListEntryIndex);
  entry.listItem = li;
  if (index === activeListEntryIndex) activeListItem = li;
  return li;
}

function renderVirtualList(force = false) {
  virtualListFrame = null;
  const visible = Math.min(visibleListCount, markerEntries.length);
  if (visible <= 0) {
    for (let index = virtualListStart; index < virtualListEnd; index++) {
      if (markerEntries[index]) markerEntries[index].listItem = null;
    }
    activeListItem = null;
    list.replaceChildren();
    virtualListStart = 0;
    virtualListEnd = 0;
    return;
  }

  const viewportHeight = Math.max(list.clientHeight, VIRTUAL_LIST_ROW_HEIGHT * 8);
  const start = Math.max(0, Math.floor(list.scrollTop / VIRTUAL_LIST_ROW_HEIGHT) - VIRTUAL_LIST_OVERSCAN);
  const end = Math.min(
    visible,
    Math.ceil((list.scrollTop + viewportHeight) / VIRTUAL_LIST_ROW_HEIGHT) + VIRTUAL_LIST_OVERSCAN,
  );
  if (!force && start === virtualListStart && end === virtualListEnd) return;

  for (let index = virtualListStart; index < virtualListEnd; index++) {
    if (markerEntries[index]) markerEntries[index].listItem = null;
  }
  activeListItem = null;

  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.append(createVirtualListSpacer(start * VIRTUAL_LIST_ROW_HEIGHT));
  for (let index = start; index < end; index++) {
    fragment.append(createListItem(markerEntries[index], index));
  }
  if (end < visible) {
    fragment.append(createVirtualListSpacer((visible - end) * VIRTUAL_LIST_ROW_HEIGHT));
  }
  list.replaceChildren(fragment);
  virtualListStart = start;
  virtualListEnd = end;
}

function scheduleVirtualListRender() {
  if (virtualListFrame !== null) return;
  virtualListFrame = requestAnimationFrame(() => renderVirtualList(false));
}

function cancelListScrollAnimation() {
  if (listScrollAnimationFrame === null) return;
  cancelAnimationFrame(listScrollAnimationFrame);
  listScrollAnimationFrame = null;
}

function listAppendAnimationDuration(itemCount) {
  return Math.min(1400, 360 + Math.log2(Math.max(1, itemCount)) * 130);
}

function animateListToTarget() {
  cancelListScrollAnimation();
  const startCount = visibleListCount;
  const endCount = listTargetVisibleCount;
  if (endCount <= startCount) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    visibleListCount = endCount;
    scrollListToVisiblePoi(endCount);
    return;
  }

  const itemCount = endCount - startCount;
  const duration = listAppendAnimationDuration(itemCount);
  const startedAt = performance.now();
  const startScrollTop = Math.max(0, startCount * VIRTUAL_LIST_ROW_HEIGHT - listScroller.clientHeight);
  listScroller.scrollTop = startScrollTop;
  renderVirtualList(true);

  const frame = now => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const exactCount = startCount + itemCount * progress;
    const revealedCount = Math.min(endCount, Math.ceil(exactCount));
    if (revealedCount !== visibleListCount) {
      visibleListCount = revealedCount;
      renderVirtualList(true);
    }
    listScroller.scrollTop = Math.max(
      0,
      exactCount * VIRTUAL_LIST_ROW_HEIGHT - listScroller.clientHeight,
    );
    if (progress < 1) {
      listScrollAnimationFrame = requestAnimationFrame(frame);
      return;
    }
    visibleListCount = endCount;
    listScroller.scrollTop = Math.max(
      0,
      endCount * VIRTUAL_LIST_ROW_HEIGHT - listScroller.clientHeight,
    );
    renderVirtualList(true);
    listScrollAnimationFrame = null;
    if (listTargetVisibleCount > endCount) animateListToTarget();
  };
  listScrollAnimationFrame = requestAnimationFrame(frame);
}

function setListVisibleTarget(target) {
  if (target === listTargetVisibleCount) return;
  listTargetVisibleCount = target;
  cancelListScrollAnimation();
  if (target <= visibleListCount) {
    visibleListCount = target;
    scrollListToVisiblePoi(target);
    return;
  }
  animateListToTarget();
}

list.addEventListener('scroll', scheduleVirtualListRender, {passive: true});
list.addEventListener('click', event => {
  if (event.target.closest?.('a')) return;
  const listItem = event.target.closest?.('li[data-entry-index]');
  if (!listItem) return;
  const index = Number(listItem.dataset.entryIndex);
  const entry = markerEntries[index];
  if (!entry) return;
  map.jumpTo({center: [entry.item.lon, entry.item.lat], zoom: 16});
  showOsmMenu(entry, false);
});
list.addEventListener('error', event => {
  const image = event.target.closest?.('.list-icon');
  if (image && !image.src.endsWith('/marker-stroked.png')) image.src = 'icon/marker-stroked.png';
}, true);

function scrollListToEntry(index) {
  if (!listScroller || index < 0 || index >= listTargetVisibleCount) return;
  if (index >= visibleListCount) {
    cancelListScrollAnimation();
    visibleListCount = listTargetVisibleCount;
  }
  // Build the spacers first so scrollTop can reach an entry that was not
  // represented in the previous virtual window.
  renderVirtualList(true);
  const targetTop = index * VIRTUAL_LIST_ROW_HEIGHT
    - (listScroller.clientHeight - VIRTUAL_LIST_ROW_HEIGHT) / 2;
  listScroller.scrollTop = Math.max(0, targetTop);
  renderVirtualList(true);
}

function scrollListToVisiblePoi(visible) {
  if (!listScroller) return;
  if (visible <= 0) {
    listScroller.scrollTop = 0;
    renderVirtualList(true);
    return;
  }
  scrollListToEntry(visible - 1);
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

  const targetChanged = visible !== listTargetVisibleCount;
  highlightedListStart = highlightStart;
  highlightedListEnd = highlightEnd;
  if (targetChanged) setListVisibleTarget(visible);
  else renderVirtualList(true);

  const highlighted = Math.max(0, highlightEnd - highlightStart);
  timelineSummaryDatetime.textContent = fmtTimelineSummary(selected);
  timelineSummaryDatetime.dateTime = new Date(selected).toISOString();
  timelineSummaryDatetime.title = fmt(selected);
  timelineSummaryCount.textContent = `更新${highlighted.toLocaleString('ja-JP')}件（累積${visible.toLocaleString('ja-JP')}件）`;
  status.textContent = `${selectedPrefecture ? `${selectedPrefecture}：` : ''}${markerEntries.length}件中 ${visible}件を表示`;
}
function showOsmMenu(entry, syncList = true) {
  if (activeListItem) activeListItem.classList.remove('is-selected');
  activeListEntryIndex = entry.entryIndex;
  if (syncList) scrollListToEntry(entry.entryIndex);
  activeListItem = entry.listItem;
  if (activeListItem) activeListItem.classList.add('is-selected');

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
  updateHighlight();
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
  status.hidden = false;

  const ordered = [...items].sort((a, b) => parseUtcDate(a.date) - parseUtcDate(b.date));
  automaticPlaybackPending = false;
  if (!ordered.length) {
    setupTimeline([]);
    return;
  }

  status.textContent = `${ordered.length.toLocaleString('ja-JP')}件の一覧データを準備中…`;
  await waitForNextPaint();
  if (currentRender !== renderVersion) return;

  markerEntries = new Array(ordered.length);
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    markerEntries[index] = {
      item,
      time: parseUtcDate(item.date).getTime(),
      entryIndex: index,
      listItem: null,
    };
    if ((index + 1) % RENDER_CHUNK_SIZE === 0 && index + 1 < ordered.length) {
      status.textContent = `${(index + 1).toLocaleString('ja-JP')} / ${ordered.length.toLocaleString('ja-JP')}件の一覧データを準備中…`;
      await waitForNextPaint();
      if (currentRender !== renderVersion) return;
    }
  }
  updateTimelineSummary();
  renderVirtualList(true);

  status.textContent = `${markerEntries.length.toLocaleString('ja-JP')}件のアイコンを準備中…`;
  await waitForNextPaint();
  await loadMapIcons(markerEntries);
  if (currentRender !== renderVersion) return;
  ensurePoiLayers();

  poiFeatures = new Array(markerEntries.length);
  for (let entryIndex = 0; entryIndex < markerEntries.length; entryIndex++) {
    const entry = markerEntries[entryIndex];
    poiFeatures[entryIndex] = {
      type: 'Feature',
      geometry: {type: 'Point', coordinates: [Number(entry.item.lon), Number(entry.item.lat)]},
      properties: {entryIndex, timestamp: entry.time, icon: entry.item.mapIcon, action: entry.item.action},
    };
    if ((entryIndex + 1) % RENDER_CHUNK_SIZE === 0 && entryIndex + 1 < markerEntries.length) {
      status.textContent = `${(entryIndex + 1).toLocaleString('ja-JP')} / ${markerEntries.length.toLocaleString('ja-JP')}件の地図データを準備中…`;
      await waitForNextPaint();
      if (currentRender !== renderVersion) return;
    }
  }

  // Set the initial time filters before filling the source so an unfiltered
  // frame containing every POI can never be painted.
  setupTimeline(ordered);
  status.textContent = `${markerEntries.length.toLocaleString('ja-JP')}件の地図表示を準備中…`;
  await waitForNextPaint();
  if (currentRender !== renderVersion) return;
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
  downloadCsvButton.disabled = false;
  timeline.hidden = false;
  requestAutomaticPlayback();
}
async function load() {
  const currentLoad = ++loadVersion;
  if (activeLoadController) activeLoadController.abort();
  const controller = new AbortController();
  activeLoadController = controller;
  renderVersion++;
  status.hidden = false;
  status.textContent = '保存済みデータを読み込み中…';
  poiTypeSelect.disabled = true;
  timeline.hidden = true;
  clearMarkers();
  try {
    if (!dateFrom.value || !dateTo.value || dateFrom.value > dateTo.value) {
      throw new Error('開始日と終了日を正しく選択してください。');
    }
    await loadConfiguration();
    const [output] = await Promise.all([
      loadAllPois(days.value, dateFrom.value, dateTo.value, selectedPrefecture, controller.signal),
      loadDefinitions(),
    ]);
    if (controller.signal.aborted || currentLoad !== loadVersion) return;

    allPoiItems = new Array(output.length);
    for (let index = 0; index < output.length; index++) {
      const item = output[index];
      allPoiItems[index] = decorateItem({...item, osmType: item.type, type: item.type2});
      if ((index + 1) % RENDER_CHUNK_SIZE === 0 && index + 1 < output.length) {
        status.textContent = `${(index + 1).toLocaleString('ja-JP')} / ${output.length.toLocaleString('ja-JP')}件のデータを整理中…`;
        await waitForNextPaint();
        if (controller.signal.aborted || currentLoad !== loadVersion) return;
      }
    }
    await applyPrefectureFilter(false);
  } catch (error) {
    if (error.name === 'AbortError' || currentLoad !== loadVersion) return;
    timeline.hidden = true;
    status.hidden = false;
    status.textContent = `取得できませんでした: ${error.message}`;
  } finally {
    if (activeLoadController === controller) activeLoadController = null;
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
summaryPlayButton.addEventListener('click', () => {
  if (isPlaying) pauseTimeline();
  else playTimeline();
});
prefectureFilterToggle.addEventListener('click', () => {
  const expanded = prefectureFilterToggle.getAttribute('aria-expanded') === 'true';
  setPrefectureFilterExpanded(!expanded);
});
timelineToggle.addEventListener('click', () => {
  const expanded = timelineToggle.getAttribute('aria-expanded') !== 'true';
  timelineToggle.setAttribute('aria-expanded', String(expanded));
  timelineToggle.textContent = expanded ? '閉じる' : '詳細';
  timelineDetails.hidden = !expanded;
});
timelineStep.addEventListener('change', () => {
  pauseTimeline();
  timeStep = Number(timelineStep.value);
  highlightRadius = timeStep;
  if (!markerEntries.length) {
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
  closeMobilePrefectureFilter();
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
  const url = buildCurrentViewUrl().toString();
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
downloadCsvButton.addEventListener('click', downloadCurrentCsv);
shareButton?.addEventListener('click', copyCurrentViewUrl);
guideDialog?.addEventListener('osm-guide-before-open', handleGuideBeforeOpen);
guideDialog?.addEventListener('osm-guide-closed', handleGuideClosed);

function startInitialLoadWhenReady() {
  if (initialLoadStarted || !mainMapReady || !prefectureStateReady) return;
  initialLoadStarted = true;
  updatePrefectureMiniMapSelection();
  load();
}

if (guide && !guide.hasSeen()) guide.open({mode: 'automatic', focusTarget: map.getCanvas()});

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

if (map.isStyleLoaded()) handleMainMapReady();
else map.once('load', handleMainMapReady);
