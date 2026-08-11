'use strict';

const numberFormat = new Intl.NumberFormat('ja-JP');
const dateFormat = new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: 'short', day: 'numeric'});
const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
  timeZone: 'Asia/Tokyo',
});
const monthFormat = new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: 'short'});
const statusElement = document.querySelector('#profile-status');
const contentElement = document.querySelector('#profile-content');
let apiUrl = '';
let categoryRules = {};
let activityMap = null;
let directoryMap = null;
let prefectureGeoJsonPromise = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function parseUtc(value) {
  return new Date(String(value).replace(' ', 'T') + 'Z');
}

function formatDate(value) {
  return value ? dateFormat.format(parseUtc(value)) : '—';
}

function formatDateTime(value) {
  return value ? dateTimeFormat.format(parseUtc(value)) : '—';
}

function formatMonth(value) {
  return value ? monthFormat.format(parseUtc(value)) : '—';
}

async function loadJsonc(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`設定ファイル: HTTP ${response.status}`);
  const source = await response.text();
  return JSON.parse(source.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n'));
}

async function loadConfiguration() {
  const [config, categories] = await Promise.all([
    loadJsonc('data/config.jsonc'),
    loadJsonc('data/category-ja.jsonc'),
  ]);
  const url = new URL(String(config.apiUrl || '').trim(), window.location.href);
  if (!/^https?:$/.test(url.protocol)) throw new Error('API URLが不正です。');
  apiUrl = url.href;
  categoryRules = categories.category || {};
}

function renderSummary(profile) {
  const summary = profile.monthlySummary || {
    total_count: 0, create_count: 0, modify_count: 0, active_day_count: 0,
  };
  const target = document.querySelector('#profile-summary');
  const total = element('article', 'summary-item summary-item-highlight');
  const totalValue = element('strong');
  totalValue.append(
    element('span', 'summary-total-main', `${numberFormat.format(summary.total_count)}件`),
    element('span', 'summary-total-detail', `（新規${numberFormat.format(summary.create_count)}件/更新${numberFormat.format(summary.modify_count)}件）`),
  );
  total.append(element('span', '', '更新地物'), totalValue);
  const activeDays = element('article', 'summary-item');
  const activeDaysValue = element('strong');
  activeDaysValue.append(
    element('span', 'summary-total-main', `${numberFormat.format(summary.active_day_count)}日`),
    element('span', 'summary-total-detail', `（累積：${numberFormat.format(profile.active_day_count || 0)}日）`),
  );
  activeDays.append(element('span', '', '活動日数'), activeDaysValue);
  target.replaceChildren(
    total,
    activeDays,
  );
}

function monthlyLevelPanel(level) {
  const panel = element('article', 'summary-item summary-item-highlight');
  const levelText = element('strong');
  levelText.append(
    element('span', 'summary-total-main', `Lv.${level.level}`),
    element('span', 'summary-total-detail', level.name || '—'),
    element('span', 'summary-total-detail', `今月 ${numberFormat.format(level.total)}件`),
  );
  panel.append(element('span', '', '月間'), levelText);
  return panel;
}

function renderStreaks(profile) {
  const cumulative = element('article', 'summary-item');
  const levelText = element('strong');
  levelText.append(
    element('span', 'summary-total-main', `Lv.${profile.cumulativeLevel.level}`),
    element('span', 'summary-total-detail', profile.cumulativeLevel.name),
    element('span', 'summary-total-detail', `直近1年間 ${numberFormat.format(profile.total_count)}件`),
  );
  cumulative.append(element('span', '', '累積'), levelText);
  document.querySelector('#profile-streaks').replaceChildren(
    monthlyLevelPanel(profile.monthlyLevel),
    cumulative,
  );
}

function badgeCard(badge) {
  const card = element('article', 'profile-badge item-card');
  card.append(element('span', 'profile-badge-icon', badge.icon));
  const copy = element('div');
  copy.append(element('strong', '', badge.name), element('p', '', badge.description));
  const label = badge.acquisitionSource === 'backfill' ? '確認' : '取得';
  copy.append(element('small', '', `${formatMonth(badge.earnedAt)}${label}・${formatMonth(badge.progressUpdatedAt)}更新`));
  card.append(copy);
  return card;
}

function badgeGuideItem(definition, earnedKeys) {
  const item = element('article', `profile-badge-guide-item${earnedKeys.has(definition.badgeKey) ? ' is-earned' : ''}`);
  item.append(element('span', 'profile-badge-guide-icon', definition.icon));
  const copy = element('div');
  copy.append(element('strong', '', definition.name), element('p', '', definition.description));
  item.append(copy);
  if (earnedKeys.has(definition.badgeKey)) item.append(element('small', '', '取得済み'));
  return item;
}

function renderBadgeGuide(definitions, earnedBadges) {
  const list = document.querySelector('#profile-badge-guide-list');
  const earnedKeys = new Set(earnedBadges.map(badge => badge.badgeKey));
  const primaryDefinitions = definitions.filter(definition => !definition.badgeGroup || Number(definition.badgeLevel) <= 1);
  const advancedDefinitions = definitions.filter(definition => definition.badgeGroup && Number(definition.badgeLevel) > 1);
  const items = primaryDefinitions.map(definition => badgeGuideItem(definition, earnedKeys));
  if (advancedDefinitions.length) {
    const details = element('details', 'profile-badge-guide-all-levels disclosure-panel');
    details.append(element('summary', '', `Ⅱ・Ⅲを表示（${numberFormat.format(advancedDefinitions.length)}個）`));
    const levelItems = element('div');
    levelItems.append(...advancedDefinitions.map(definition => badgeGuideItem(definition, earnedKeys)));
    details.append(levelItems);
    items.push(details);
  }
  list.replaceChildren(...items);
}

function badgeFamily(badge) {
  if (badge.metric === 'all_prefectures' || badge.metric === 'prefecture_count' || badge.metric === 'region_prefectures') return 'region_coverage';
  if (badge.metric === 'prefecture_mapping_count') return 'prefecture';
  if (badge.metric === 'tag_group') return badge.badgeGroup || `badge:${badge.badgeKey}`;
  return badge.metric || `badge:${badge.badgeKey}`;
}

function prioritizedBadges(badges, visibleLimit = 6) {
  const familyPriorities = {
    total_count: 100,
    create_count: 90,
    modify_count: 80,
    active_day_count: 70,
    region_coverage: 60,
    category_count: 50,
    prefecture_active_day_count: 48,
    balanced_count: 40,
    prefecture: 30,
  };
  const familyPriority = badge => badge.metric === 'tag_group'
    ? 45
    : (familyPriorities[badgeFamily(badge)] || 0);
  const compareWithinFamily = (left, right) =>
    Number(right.threshold || 0) - Number(left.threshold || 0)
      || String(right.earnedAt || '').localeCompare(String(left.earnedAt || ''))
      || String(left.badgeKey || '').localeCompare(String(right.badgeKey || ''));
  const compareFamilies = (left, right) =>
    familyPriority(right) - familyPriority(left)
      || compareWithinFamily(left, right);
  const families = new Map();
  badges.forEach((badge) => {
    const family = badgeFamily(badge);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(badge);
  });
  const representatives = [];
  const lowerBadges = [];
  families.forEach((familyBadges) => {
    familyBadges.sort(compareWithinFamily);
    representatives.push(familyBadges[0]);
    lowerBadges.push(...familyBadges.slice(1));
  });
  representatives.sort(compareFamilies);
  lowerBadges.sort(compareFamilies);
  const visible = representatives.slice(0, visibleLimit);
  if (visible.length < visibleLimit) visible.push(...lowerBadges.slice(0, visibleLimit - visible.length));
  const visibleKeys = new Set(visible.map(badge => badge.badgeKey));
  const hidden = [...representatives.slice(visibleLimit), ...lowerBadges]
    .filter(badge => !visibleKeys.has(badge.badgeKey));
  return {visible, hidden};
}

function renderBadges(data) {
  renderBadgeGuide(data.badgeDefinitions || [], data.badges);
  document.querySelector('#profile-badge-count').textContent = `${data.badges.length}個獲得`;
  const badges = document.querySelector('#profile-badges');
  const sortedBadges = [...data.badges];
  const {visible: recentBadges, hidden: olderBadges} = prioritizedBadges(sortedBadges);
  badges.replaceChildren(...recentBadges.map(badgeCard));
  if (!sortedBadges.length) badges.append(element('p', 'profile-empty', '獲得済みバッジはまだありません。'));

  const older = document.querySelector('#profile-older-badges');
  older.replaceChildren();
  older.hidden = !olderBadges.length;
  if (olderBadges.length) {
    const summary = element('summary', '', `他のバッジを表示（${numberFormat.format(olderBadges.length)}個）`);
    const grid = element('div', 'profile-badges profile-older-badges-grid item-grid');
    grid.append(...olderBadges.map(badgeCard));
    older.append(summary, grid);
    older.addEventListener('toggle', () => {
      summary.textContent = older.open
        ? '他のバッジを閉じる'
        : `他のバッジを表示（${numberFormat.format(olderBadges.length)}個）`;
    }, {once: false});
  }

  const next = document.querySelector('#profile-next-badges');
  next.replaceChildren();
  if (!data.nextBadges.length) return;
  next.append(element('h4', '', '次のバッジ'));
  data.nextBadges.forEach(badge => {
    const row = element('div', 'profile-next-badge');
    const title = element('div');
    title.append(element('span', '', `${badge.icon} ${badge.name}`), element('strong', '', `${numberFormat.format(badge.progressValue)} / ${numberFormat.format(badge.threshold)}`));
    const progress = element('progress');
    progress.max = badge.threshold;
    progress.value = Math.min(badge.progressValue, badge.threshold);
    row.append(title, progress);
    next.append(row);
  });
}

const badgeGuideDialog = document.querySelector('#profile-badge-guide');
document.querySelector('#profile-badge-guide-open').addEventListener('click', () => {
  if (!badgeGuideDialog.open) {
    document.body.classList.add('is-badge-guide-open');
    badgeGuideDialog.showModal();
  }
});
document.querySelector('#profile-badge-guide-close').addEventListener('click', () => badgeGuideDialog.close());
badgeGuideDialog.addEventListener('click', event => {
  if (event.target === badgeGuideDialog) badgeGuideDialog.close();
});
badgeGuideDialog.addEventListener('close', () => document.body.classList.remove('is-badge-guide-open'));

function renderBars(selector, rows, label) {
  const target = document.querySelector(selector);
  const maximum = Math.max(1, ...rows.map(row => row.total));
  target.replaceChildren(...rows.map(row => {
    const item = element('div', 'profile-ranking-row');
    const heading = element('div');
    heading.append(element('span', '', label(row)), element('strong', '', `${numberFormat.format(row.total)}件`));
    const bar = element('span', 'profile-ranking-bar');
    bar.style.setProperty('--ratio', `${row.total / maximum * 100}%`);
    item.append(heading, bar);
    return item;
  }));
  if (!rows.length) target.append(element('p', 'profile-empty', '表示できるデータがありません。'));
}

function categoryLabel(row) {
  const value = row.value ?? row.categoryValue;
  const tag = `${row.category}${value ? `=${value}` : ''}`;
  const nestedName = Object.values(categoryRules).find(definition =>
    definition?.[row.category]?.[value])?.[row.category]?.[value];
  const name = categoryRules[row.category]?.[value]
    || nestedName
    || categoryRules[row.category]?.['*']
    || tag;
  return name === tag ? tag : `${name}（${tag}）`;
}

function representativePoint(feature) {
  const coordinates = feature?.geometry?.coordinates || [];
  const polygons = feature?.geometry?.type === 'Polygon' ? [coordinates] : coordinates;
  const ring = polygons.map(polygon => polygon[0]).filter(Boolean)
    .sort((left, right) => right.length - left.length)[0];
  if (!ring?.length) return null;
  let longitude = 0;
  let latitude = 0;
  let signedArea = 0;
  for (let index = 0; index < ring.length; index++) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    signedArea += cross;
    longitude += (current[0] + next[0]) * cross;
    latitude += (current[1] + next[1]) * cross;
  }
  if (Math.abs(signedArea) < Number.EPSILON) return ring[0];
  return [longitude / (3 * signedArea), latitude / (3 * signedArea)];
}

async function renderActivityMap(rows) {
  const container = document.querySelector('#profile-activity-map');
  if (activityMap) activityMap.remove();
  activityMap = null;
  if (!rows.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  if (!prefectureGeoJsonPromise) {
    prefectureGeoJsonPromise = fetch('data/prefectures.min.geojson').then(response => {
      if (!response.ok) throw new Error(`都道府県地図: HTTP ${response.status}`);
      return response.json();
    });
  }
  const geojson = await prefectureGeoJsonPromise;
  const features = new Map((geojson.features || []).map(feature => [
    String(feature.properties?.['name:ja'] || feature.properties?.name || ''), feature,
  ]));
  const locations = rows.map(row => ({...row, point: representativePoint(features.get(row.prefecture))}))
    .filter(row => row.point);
  if (!locations.length) {
    container.hidden = true;
    return;
  }
  activityMap = new maplibregl.Map({
    container,
    style: './tiles/osmfj_nopoi.json',
    ...(locations.length === 1
      ? {center: locations[0].point, zoom: 6.2}
      : {center: [137, 35.5], zoom: 3.2}),
    minZoom: 3,
    maxZoom: 12,
    attributionControl: true,
    locale: window.osmSharedMapControls.locale,
  });
  window.osmSharedMapControls.add(activityMap);
  activityMap.on('load', () => {
    activityMap.addSource('profile-prefectures', {type: 'geojson', data: geojson});
    activityMap.addLayer({
      id: 'profile-prefecture-fill',
      type: 'fill',
      source: 'profile-prefectures',
      paint: {'fill-color': '#dce8e3', 'fill-opacity': .35},
    });
    activityMap.addLayer({
      id: 'profile-active-prefecture-fill',
      type: 'fill',
      source: 'profile-prefectures',
      filter: ['in', ['get', 'name:ja'], ['literal', locations.map(row => row.prefecture)]],
      paint: {'fill-color': '#2aa47e', 'fill-opacity': .3},
    });
    activityMap.addLayer({
      id: 'profile-prefecture-outline',
      type: 'line',
      source: 'profile-prefectures',
      paint: {'line-color': '#64877a', 'line-width': 1, 'line-opacity': .7},
    });
  });
  locations.forEach(row => {
    const marker = element('div', 'profile-region-marker', numberFormat.format(row.total));
    marker.title = `${row.prefecture}：${numberFormat.format(row.total)}件`;
    marker.setAttribute('aria-label', marker.title);
    new maplibregl.Marker({element: marker, anchor: 'bottom'}).setLngLat(row.point).addTo(activityMap);
  });
}

function prefectureName(feature) {
  return String(feature?.properties?.['name:ja'] || feature?.properties?.name || '');
}

function featureBounds(feature) {
  const bounds = new maplibregl.LngLatBounds();
  const extendCoordinates = coordinates => {
    if (typeof coordinates?.[0] === 'number') bounds.extend(coordinates);
    else coordinates?.forEach(extendCoordinates);
  };
  extendCoordinates(feature?.geometry?.coordinates);
  return bounds;
}

function mapperListItem(row, index) {
  const item = element('li');
  const link = element('a');
  link.href = `profile.html?uid=${encodeURIComponent(row.uid)}`;
  const rank = element('span', 'profile-directory-rank', String(index + 1));
  const avatar = element('span', 'profile-related-avatar', String(row.name || '?').slice(0, 1).toUpperCase());
  const copy = element('span', 'profile-directory-mapper');
  copy.append(
    element('strong', '', row.name || '不明'),
    element('small', '', `新規 ${numberFormat.format(row.creates)}件・更新 ${numberFormat.format(row.modifies)}件`),
  );
  link.append(rank, avatar, copy, element('b', '', `${numberFormat.format(row.total)}件`));
  item.append(link);
  return item;
}

function renderDirectoryMappers(prefecture, rows) {
  const areaLabel = prefecture || '日本';
  const results = document.querySelector('#profile-directory-results');
  const list = document.querySelector('#profile-directory-list');
  document.querySelector('#profile-directory-title').textContent = `${areaLabel}のトップ100マッパー`;
  document.querySelector('#profile-directory-count').textContent = `${numberFormat.format(rows.length)}人`;
  document.querySelector('#profile-directory-status').textContent = rows.length
    ? '直近1年間に確認できた対象地物数の順です。'
    : '表示できるマッパーがいません。';
  list.replaceChildren(...rows.map(mapperListItem));
  results.hidden = false;
}

function renderMapperSearchResults(rows, query) {
  const target = document.querySelector('#profile-mapper-search-results');
  target.replaceChildren();
  target.hidden = false;
  if (!rows.length) {
    target.append(element('p', 'profile-mapper-search-message', `「${query}」で始まるマッパーは見つかりませんでした。`));
    return;
  }
  const list = element('ul');
  rows.forEach((row, index) => {
    const item = element('li');
    const link = element('a');
    link.id = `profile-mapper-suggestion-${index}`;
    link.setAttribute('role', 'option');
    link.setAttribute('aria-selected', 'false');
    link.href = `profile.html?uid=${encodeURIComponent(row.uid)}`;
    link.append(
      element('strong', '', row.name || '不明'),
      element('span', '', `直近1年間 ${numberFormat.format(row.total)}件`),
    );
    item.append(link);
    list.append(item);
  });
  target.append(list);
}

function initializeMapperSearch() {
  const form = document.querySelector('#profile-mapper-search-form');
  const input = document.querySelector('#profile-mapper-search-input');
  const results = document.querySelector('#profile-mapper-search-results');
  const searchPanel = form.closest('.profile-directory-search');
  const cache = new Map();
  let debounceTimer = 0;
  let controller = null;
  let activeIndex = -1;

  const suggestions = () => [...results.querySelectorAll('[role="option"]')];
  const closeSuggestions = () => {
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
  };
  const setActiveSuggestion = index => {
    const options = suggestions();
    if (!options.length) return;
    activeIndex = (index + options.length) % options.length;
    options.forEach((option, optionIndex) => {
      const active = optionIndex === activeIndex;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
    });
    input.setAttribute('aria-activedescendant', options[activeIndex].id);
    options[activeIndex].scrollIntoView({block: 'nearest'});
  };
  const showMessage = message => {
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    results.replaceChildren(element('p', 'profile-mapper-search-message', message));
    activeIndex = -1;
  };
  const search = async () => {
    const query = input.value.trim();
    if (query.length < 2) {
      closeSuggestions();
      return;
    }
    const cacheKey = query.toLocaleLowerCase();
    if (cache.has(cacheKey)) {
      renderMapperSearchResults(cache.get(cacheKey), query);
      input.setAttribute('aria-expanded', 'true');
      activeIndex = -1;
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const currentController = controller;
    showMessage('検索しています…');
    try {
      const parameters = new URLSearchParams({mode: 'mapper_search', q: query});
      const response = await fetch(`${apiUrl}?${parameters}`, {signal: currentController.signal});
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || `API: HTTP ${response.status}`);
      if (currentController !== controller || input.value.trim() !== query) return;
      const rows = Array.isArray(data.mappers) ? data.mappers : [];
      cache.set(cacheKey, rows);
      renderMapperSearchResults(rows, query);
      input.setAttribute('aria-expanded', 'true');
      activeIndex = -1;
    } catch (error) {
      if (error.name !== 'AbortError') showMessage(`検索できませんでした：${error.message}`);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    controller?.abort();
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    if (input.value.trim().length < 2) {
      closeSuggestions();
      return;
    }
    debounceTimer = window.setTimeout(search, 300);
  });
  input.addEventListener('keydown', event => {
    const options = suggestions();
    if (event.key === 'ArrowDown' && !results.hidden && options.length) {
      event.preventDefault();
      setActiveSuggestion(activeIndex + 1);
    } else if (event.key === 'ArrowUp' && !results.hidden && options.length) {
      event.preventDefault();
      setActiveSuggestion(activeIndex - 1);
    } else if (event.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) {
      event.preventDefault();
      options[activeIndex].click();
    } else if (event.key === 'Escape') {
      closeSuggestions();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearTimeout(debounceTimer);
    search();
  });
  document.addEventListener('click', event => {
    if (!searchPanel.contains(event.target)) closeSuggestions();
  });
}

async function loadDirectoryMappers(prefecture, {scroll = true} = {}) {
  const areaLabel = prefecture || '日本';
  const results = document.querySelector('#profile-directory-results');
  const status = document.querySelector('#profile-directory-status');
  document.querySelector('#profile-directory-title').textContent = `${areaLabel}のトップ100マッパー`;
  document.querySelector('#profile-directory-count').textContent = '';
  document.querySelector('#profile-directory-list').replaceChildren();
  status.textContent = 'マッパーを読み込んでいます…';
  results.hidden = false;
  if (scroll) results.scrollIntoView({behavior: 'smooth', block: 'start'});
  const query = new URLSearchParams({mode: 'profile_region_mappers'});
  if (prefecture) query.set('prefecture', prefecture);
  const response = await fetch(`${apiUrl}?${query}`);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `API: HTTP ${response.status}`);
  renderDirectoryMappers(prefecture, Array.isArray(data.mappers) ? data.mappers : []);
}

async function initializeDirectory() {
  const directory = document.querySelector('#profile-directory');
  directory.hidden = false;
  statusElement.hidden = true;
  initializeMapperSearch();
  loadDirectoryMappers('', {scroll: false}).catch(error => {
    document.querySelector('#profile-directory-status').textContent = `読み込めませんでした：${error.message}`;
  });
  if (!prefectureGeoJsonPromise) {
    prefectureGeoJsonPromise = fetch('data/prefectures.min.geojson').then(response => {
      if (!response.ok) throw new Error(`都道府県地図: HTTP ${response.status}`);
      return response.json();
    });
  }
  const geojson = await prefectureGeoJsonPromise;
  directoryMap = new maplibregl.Map({
    container: 'profile-directory-map',
    center: [137.2, 36.2],
    zoom: 4.15,
    maxZoom: 8,
    maxBounds: [[118, 18], [158, 50]],
    style: './tiles/osmfj_nopoi.json',
    locale: window.osmSharedMapControls.locale,
  });
  window.osmSharedMapControls.add(directoryMap);
  directoryMap.on('load', () => {
    directoryMap.addSource('profile-directory-prefectures', {type: 'geojson', data: geojson});
    const firstSymbolLayer = directoryMap.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
    directoryMap.addLayer({
      id: 'profile-directory-prefecture-fill',
      type: 'fill',
      source: 'profile-directory-prefectures',
      paint: {'fill-color': '#38a37d', 'fill-opacity': .18, 'fill-outline-color': '#35674f'},
    }, firstSymbolLayer);
    directoryMap.addLayer({
      id: 'profile-directory-prefecture-selected',
      type: 'fill',
      source: 'profile-directory-prefectures',
      filter: ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], ''],
      paint: {'fill-color': '#087f5b', 'fill-opacity': .5, 'fill-outline-color': '#075f47'},
    }, firstSymbolLayer);
    directoryMap.on('click', 'profile-directory-prefecture-fill', event => {
      const feature = event.features?.[0];
      const name = prefectureName(feature);
      if (!name) return;
      directoryMap.setFilter('profile-directory-prefecture-selected', ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], name]);
      const bounds = featureBounds(feature);
      if (!bounds.isEmpty()) directoryMap.fitBounds(bounds, {padding: 45, maxZoom: 7, duration: 500});
      loadDirectoryMappers(name).catch(error => {
        document.querySelector('#profile-directory-status').textContent = `読み込めませんでした：${error.message}`;
      });
    });
    directoryMap.on('mouseenter', 'profile-directory-prefecture-fill', () => { directoryMap.getCanvas().style.cursor = 'pointer'; });
    directoryMap.on('mouseleave', 'profile-directory-prefecture-fill', () => { directoryMap.getCanvas().style.cursor = ''; });
  });
}

function osmObjectUrl(row) {
  return `https://www.openstreetmap.org/${encodeURIComponent(row.type)}/${encodeURIComponent(row.id)}`;
}

function renderRecent(rows) {
  const target = document.querySelector('#profile-recent');
  target.replaceChildren(...rows.map(row => {
    const item = element('article');
    const action = element('span', `profile-action is-${row.action}`, row.action === 'create' ? '新規' : '更新');
    const copy = element('div');
    const link = element('a', '', row.name || categoryLabel(row));
    link.href = osmObjectUrl(row); link.target = '_blank'; link.rel = 'noopener noreferrer';
    copy.append(link, element('small', '', `${row.prefecture || '地域不明'}・${formatDateTime(row.date)}`));
    item.append(action, copy);
    return item;
  }));
}

function renderRelated(rows) {
  const target = document.querySelector('#profile-related');
  target.replaceChildren(...rows.map(mapperListItem));
  if (!rows.length) target.append(element('li', 'profile-empty', '関連するマッパーはまだ見つかりません。'));
}

function rememberSnapshot(data) {
  try {
    localStorage.setItem(`osm-profile-${data.profile.editor_uid}`, JSON.stringify({
      total: data.profile.total_count, badges: data.badges.length, calculatedAt: data.meta.calculatedAt,
    }));
  } catch { /* Storage is optional. */ }
}

function renderProfile(data) {
  const profile = data.profile;
  document.title = `${profile.editor_name}｜マッパープロフィール｜OSM What’s New Japan`;
  document.querySelector('#profile-name').textContent = profile.editor_name;
  const avatar = document.querySelector('#profile-avatar');
  const fallbackAvatar = () => {
    avatar.style.removeProperty('background-image');
    avatar.textContent = profile.editor_name.slice(0, 1).toUpperCase();
  };
  fallbackAvatar();
  if (profile.avatar_url) {
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      avatar.textContent = '';
      avatar.style.backgroundImage = `url("${String(profile.avatar_url).replace(/["\\]/g, '\\$&')}")`;
    };
    image.onerror = fallbackAvatar;
    image.src = profile.avatar_url;
  }
  const activityStart = profile.first_activity_at || profile.period_start;
  document.querySelector('#profile-period').textContent = `集計期間：${formatDate(activityStart)}〜${formatDate(profile.period_end)}`;
  const osmLink = document.querySelector('#osm-profile-link');
  osmLink.href = `https://www.openstreetmap.org/user/${encodeURIComponent(profile.editor_name)}`;
  document.querySelector('#profile-category-count').textContent = `${numberFormat.format(profile.category_count)}種類`;
  document.querySelector('#profile-region-count').textContent = `${numberFormat.format(profile.prefecture_count)}地域`;
  renderSummary(profile);
  renderStreaks(profile);
  renderBadges(data);
  renderBars('#profile-categories', data.categories, categoryLabel);
  renderRecent(data.recent);
  renderRelated(data.relatedMappers);
  rememberSnapshot(data);
}

async function loadProfile(uid) {
  statusElement.hidden = false;
  statusElement.textContent = 'プロフィールを読み込んでいます…';
  contentElement.hidden = true;
  const query = new URLSearchParams({mode: 'profile', editor_uid: uid});
  const response = await fetch(`${apiUrl}?${query}`);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `API: HTTP ${response.status}`);
  if (!data.profile) {
    statusElement.textContent = '直近1年間に対象となる活動が見つかりませんでした。';
    return;
  }
  renderProfile(data);
  statusElement.hidden = true;
  contentElement.hidden = false;
  try {
    await renderActivityMap(data.prefectures);
  } catch (error) {
    document.querySelector('#profile-activity-map').hidden = true;
    console.error('活動地域の地図を表示できませんでした:', error);
  }
}

async function initialize() {
  await loadConfiguration();
  const uid = new URLSearchParams(location.search).get('uid')?.trim() || '';
  if (!uid) {
    await initializeDirectory();
    return;
  }
  if (!/^[1-9]\d*$/.test(uid)) throw new Error('ユーザーIDが不正です。');
  await loadProfile(uid);
}

initialize().catch(error => {
  statusElement.hidden = false;
  statusElement.textContent = `読み込めませんでした：${error.message}`;
});
