'use strict';

const numberFormat = new Intl.NumberFormat('ja-JP');
const dateFormat = new Intl.DateTimeFormat('ja-JP', {year: 'numeric', month: 'short', day: 'numeric'});
const yearMonthFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: 'long', timeZone: 'Asia/Tokyo',
});
const statusElement = document.querySelector('#profile-status');
const contentElement = document.querySelector('#profile-content');
let apiUrl = '';
let categoryRules = {};
let activityMap = null;
let directoryMap = null;
let prefectureGeoJsonPromise = null;
let newlyEarnedBadgeKeys = new Set();
let badgeEffectPlaying = false;

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

function formatYearMonth(value) {
  return value ? yearMonthFormat.format(parseUtc(value)) : '—';
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
  const total = element('article', 'summary-item');
  const totalValue = element('strong');
  totalValue.append(
    element('span', 'summary-total-main', `${numberFormat.format(summary.total_count)}件`),
    element('span', 'summary-total-detail', `（新規${numberFormat.format(summary.create_count)}件/更新${numberFormat.format(summary.modify_count)}件）`),
  );
  total.append(element('span', '', '編集'), totalValue);
  const activeDays = element('article', 'summary-item');
  const activeDaysValue = element('strong');
  activeDaysValue.append(
    element('span', 'summary-total-main', `${numberFormat.format(summary.active_day_count)}日`),
    element('span', 'summary-total-detail', `（累積：${numberFormat.format(profile.active_day_count || 0)}日）`),
  );
  activeDays.append(element('span', '', '活動'), activeDaysValue);
  target.replaceChildren(
    total,
    activeDays,
  );
}

function monthlyLevelPanel(level) {
  const panel = element('article', 'summary-item');
  const levelText = element('strong');
  levelText.append(
    element('span', 'summary-total-main', `Lv.${level.level}`),
    element('span', 'summary-total-detail', level.name || '—'),
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
  );
  cumulative.append(element('span', '', '累積'), levelText);
  document.querySelector('#profile-streaks').replaceChildren(
    monthlyLevelPanel(profile.monthlyLevel),
    cumulative,
  );
}

function badgeCard(badge, isNew = false) {
  const card = element('article', `profile-badge item-card${isNew ? ' is-new' : ''}`);
  card.dataset.badgeKey = badge.badgeKey;
  card.append(element('span', 'profile-badge-icon', badge.icon));
  const copy = element('div');
  const name = element('strong', '', badge.name);
  if (isNew) name.append(element('span', 'profile-badge-new-label', 'NEW'));
  copy.append(name, element('p', '', badge.description));
  card.append(copy);
  return card;
}

const badgeLevelNumerals = {1: 'Ⅰ', 2: 'Ⅱ', 3: 'Ⅲ'};

function badgeGuideItem(definition, earnedKeys) {
  const definitionKeys = definition.badgeKeys || [definition.badgeKey];
  const earnedLevels = definitionKeys
    .map((key, index) => earnedKeys.has(key) ? badgeLevelNumerals[index + 1] : '')
    .filter(Boolean);
  const isEarned = earnedLevels.length > 0;
  const item = element('article', `profile-badge-guide-item${isEarned ? ' is-earned' : ''}`);
  item.append(element('span', 'profile-badge-guide-icon', definition.icon));
  const copy = element('div');
  copy.append(element('strong', '', definition.name), element('p', '', definition.description));
  item.append(copy);
  if (isEarned) {
    const earnedLabel = definitionKeys.length > 1 ? `${earnedLevels.join('・')}取得済み` : '取得済み';
    item.append(element('small', '', earnedLabel));
  }
  return item;
}

function combinedBadgeDescription(definitions) {
  const parsed = definitions.map(definition => String(definition.description || '')
    .match(/^(.*?)([\d,]+)(件.*)$/));
  if (parsed.every(Boolean)
    && parsed.every(parts => parts[1] === parsed[0][1] && parts[3] === parsed[0][3])) {
    const values = parsed.map(parts => parts[2]).join('件、');
    return `${parsed[0][1]}${values}${parsed[0][3]}`;
  }
  return definitions.map(definition => definition.description).join('／');
}

function consolidatedBadgeDefinitions(definitions) {
  const groups = new Map();
  definitions.forEach(definition => {
    const key = definition.badgeGroup || `badge:${definition.badgeKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(definition);
  });
  return [...groups.values()].map(group => {
    if (!group[0].badgeGroup || group.length === 1) return group[0];
    const ordered = [...group].sort((left, right) =>
      Number(left.badgeLevel || 0) - Number(right.badgeLevel || 0));
    const baseName = String(ordered[0].name || '').replace(/[ⅠⅡⅢ]+$/, '');
    const levels = ordered.map(definition =>
      badgeLevelNumerals[Number(definition.badgeLevel)] || definition.badgeLevel).join('・');
    return {
      ...ordered[0],
      name: `${baseName}${levels}`,
      description: combinedBadgeDescription(ordered),
      badgeKeys: ordered.map(definition => definition.badgeKey),
    };
  });
}

function renderBadgeGuide(definitions, earnedBadges) {
  const list = document.querySelector('#profile-badge-guide-list');
  const earnedKeys = new Set(earnedBadges.map(badge => badge.badgeKey));
  const consolidated = consolidatedBadgeDefinitions(definitions);
  list.replaceChildren(...consolidated.map(definition => badgeGuideItem(definition, earnedKeys)));
}

function badgeFamily(badge) {
  if (badge.metric === 'all_prefectures' || badge.metric === 'prefecture_count' || badge.metric === 'region_prefectures') return 'region_coverage';
  if (badge.metric === 'prefecture_mapping_count') return 'prefecture';
  if (badge.metric === 'tag_group') return badge.badgeGroup || `badge:${badge.badgeKey}`;
  return badge.metric || `badge:${badge.badgeKey}`;
}

function consolidatedBadgeSeries(badges, newBadgeKeys) {
  const groups = new Map();
  badges.forEach(badge => {
    const key = badge.badgeGroup || `badge:${badge.badgeKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(badge);
  });
  return [...groups.values()].map(group => {
    if (!group[0].badgeGroup || group.length === 1) {
      return {...group[0], isNew: newBadgeKeys.has(group[0].badgeKey)};
    }
    const ordered = [...group].sort((left, right) =>
      Number(left.badgeLevel || 0) - Number(right.badgeLevel || 0));
    const highest = ordered.at(-1);
    const baseName = String(ordered[0].name || '').replace(/[ⅠⅡⅢ]+$/, '');
    const levels = ordered.map(badge => badgeLevelNumerals[Number(badge.badgeLevel)] || badge.badgeLevel).join('・');
    return {
      ...highest,
      name: `${baseName}${levels}`,
      isNew: ordered.some(badge => newBadgeKeys.has(badge.badgeKey)),
    };
  });
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
  const familyPriority = badge => {
    if (badge.metric === 'tag_group') return 45;
    if (badge.metric === 'active_day_count' && Number(badge.threshold || 0) <= 30) return 25;
    return familyPriorities[badgeFamily(badge)] || 0;
  };
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

function renderBadges(data, newBadgeKeys = new Set()) {
  renderBadgeGuide(data.badgeDefinitions || [], data.badges);
  document.querySelector('#profile-badge-count').textContent = `${data.badges.length}個獲得`;
  const badges = document.querySelector('#profile-badges');
  const sortedBadges = consolidatedBadgeSeries(data.badges, newBadgeKeys);
  const prioritized = prioritizedBadges(sortedBadges);
  const newBadges = sortedBadges.filter(badge => badge.isNew);
  const remainingBadges = [...prioritized.visible, ...prioritized.hidden]
    .filter(badge => !badge.isNew);
  const recentBadges = [...newBadges, ...remainingBadges].slice(0, 6);
  const visibleKeys = new Set(recentBadges.map(badge => badge.badgeKey));
  const olderBadges = [...newBadges, ...remainingBadges].filter(badge => !visibleKeys.has(badge.badgeKey));
  badges.replaceChildren(...recentBadges.map(badge => badgeCard(badge, badge.isNew)));
  if (!sortedBadges.length) badges.append(element('p', 'profile-empty', '獲得済みバッジはまだありません。'));

  const older = document.querySelector('#profile-older-badges');
  older.replaceChildren();
  older.hidden = !olderBadges.length;
  if (olderBadges.length) {
    const summary = element('summary', '', `他のバッジを表示（${numberFormat.format(olderBadges.length)}個）`);
    const grid = element('div', 'profile-badges profile-older-badges-grid item-grid');
    grid.append(...olderBadges.map(badge => badgeCard(badge, badge.isNew)));
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

async function playNewBadgeEffect() {
  const cards = [...document.querySelectorAll('#profile-badges > .profile-badge.is-new')];
  if (!cards.length || badgeEffectPlaying) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  badgeEffectPlaying = true;
  const backdrop = element('div', 'profile-badge-effect-backdrop');
  backdrop.append(element('strong', 'profile-badge-effect-title', '新規バッチ獲得！'));
  document.body.append(backdrop);
  try {
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const clone = card.cloneNode(true);
      clone.classList.add('profile-badge-effect-clone');
      Object.assign(clone.style, {
        top: `${rect.top}px`, left: `${rect.left}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
      document.body.append(clone);
      card.style.visibility = 'hidden';
      const moveX = innerWidth / 2 - (rect.left + rect.width / 2);
      const moveY = innerHeight / 2 - (rect.top + rect.height / 2);
      const scale = Math.max(1, Math.min(
        1.75,
        (innerWidth - 40) / rect.width,
        (innerHeight - 40) / rect.height,
      ));
      const center = `translate(${moveX}px, ${moveY}px) scale(${scale})`;
      const animation = clone.animate([
        {transform: 'translate(0, 0) scale(.9)', opacity: .35, offset: 0, easing: 'cubic-bezier(.08,.8,.12,1)'},
        {transform: `${center} rotate(-.6deg)`, opacity: 1, offset: .22, easing: 'cubic-bezier(.2,.75,.25,1)'},
        {transform: `${center} rotate(.4deg)`, opacity: 1, offset: .58, easing: 'cubic-bezier(.55,.05,.72,.35)'},
        {transform: 'translate(0, 0) scale(.94)', opacity: 1, offset: .88, easing: 'cubic-bezier(.12,.75,.25,1)'},
        {transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 1},
      ], {duration: 1450, fill: 'both'});
      try { await animation.finished; } catch { /* A repeated navigation may cancel it. */ }
      clone.remove();
      card.style.removeProperty('visibility');
      await new Promise(resolve => window.setTimeout(resolve, 100));
    }
  } finally {
    backdrop.remove();
    document.querySelectorAll('.profile-badge-effect-clone').forEach(clone => clone.remove());
    document.querySelectorAll('.profile-badge.is-new').forEach(card => card.style.removeProperty('visibility'));
    badgeEffectPlaying = false;
  }
}

function replayNewBadgeEffect() {
  if (badgeEffectPlaying) return;
  document.querySelector('#profile-badges')?.scrollIntoView({behavior: 'smooth', block: 'center'});
  window.setTimeout(playNewBadgeEffect, 500);
}

document.querySelector('#profile-replay-badges').addEventListener('click', replayNewBadgeEffect);

function setupProfileGuideDialog(triggerSelector, dialogSelector, closeSelector) {
  const trigger = document.querySelector(triggerSelector);
  const dialog = document.querySelector(dialogSelector);
  const closeButton = document.querySelector(closeSelector);
  trigger.addEventListener('click', () => {
    if (!dialog.open) {
      document.body.classList.add('is-badge-guide-open');
      dialog.showModal();
    }
  });
  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => document.body.classList.remove('is-badge-guide-open'));
}

setupProfileGuideDialog('#profile-level-guide-open', '#profile-level-guide', '#profile-level-guide-close');
setupProfileGuideDialog('#profile-badge-guide-open', '#profile-badge-guide', '#profile-badge-guide-close');

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

function mapperListItem(row, index, showBreakdown = true) {
  const item = element('li');
  const link = element('a');
  link.href = `profile.html?uid=${encodeURIComponent(row.uid)}`;
  const rank = element('span', 'profile-directory-rank', String(index + 1));
  const avatar = element('span', 'profile-related-avatar', String(row.name || '?').slice(0, 1).toUpperCase());
  if (row.avatarUrl) {
    const image = element('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => avatar.classList.add('has-image'));
    image.addEventListener('error', () => image.remove());
    image.src = row.avatarUrl;
    avatar.append(image);
  }
  const copy = element('span', 'profile-directory-mapper');
  copy.append(element('strong', '', row.name || '不明'));
  if (showBreakdown) {
    copy.append(element('small', '', `新規 ${numberFormat.format(row.creates)}件・更新 ${numberFormat.format(row.modifies)}件`));
  }
  link.append(rank, avatar, copy, element('b', '', `${numberFormat.format(row.total)}件`));
  item.append(link);
  return item;
}

function renderDirectoryMappers(prefecture, rows) {
  const results = document.querySelector('#profile-directory-results');
  const list = document.querySelector('#profile-directory-list');
  document.querySelector('#profile-directory-title').textContent = '最近更新したマッパー';
  document.querySelector('#profile-directory-count').textContent = '';
  document.querySelector('#profile-directory-status').textContent = rows.length
    ? `${prefecture ? `${prefecture}で活動したマッパーを、` : ''}最終活動日時が新しい順に表示しています。`
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
  const results = document.querySelector('#profile-directory-results');
  const status = document.querySelector('#profile-directory-status');
  document.querySelector('#profile-directory-title').textContent = '最近更新したマッパー';
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
      id: 'profile-directory-prefecture-outline',
      type: 'line',
      source: 'profile-directory-prefectures',
      paint: {
        'line-color': '#285b47',
        'line-width': 1,
        'line-opacity': .9,
      },
    }, firstSymbolLayer);
    directoryMap.addLayer({
      id: 'profile-directory-prefecture-selected',
      type: 'fill',
      source: 'profile-directory-prefectures',
      filter: ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], ''],
      paint: {'fill-color': '#087f5b', 'fill-opacity': .5},
    }, firstSymbolLayer);
    directoryMap.addLayer({
      id: 'profile-directory-prefecture-selected-outline',
      type: 'line',
      source: 'profile-directory-prefectures',
      filter: ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], ''],
      paint: {
        'line-color': '#f05a24',
        'line-width': 2,
      },
    }, firstSymbolLayer);
    directoryMap.on('click', 'profile-directory-prefecture-fill', event => {
      const feature = event.features?.[0];
      const name = prefectureName(feature);
      if (!name) return;
      directoryMap.setFilter('profile-directory-prefecture-selected', ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], name]);
      directoryMap.setFilter('profile-directory-prefecture-selected-outline', ['==', ['coalesce', ['get', 'name:ja'], ['get', 'name']], name]);
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
  target.classList.remove('is-expanded');
  target.replaceChildren(...rows.map(row => {
    const item = element('article');
    const action = element('span', `profile-action is-${row.action}`, row.action === 'create' ? '新規' : '更新');
    const copy = element('div');
    const link = element('a', '', row.name || categoryLabel(row));
    link.href = osmObjectUrl(row); link.target = '_blank'; link.rel = 'noopener noreferrer';
    copy.append(link, element('small', '', `${row.prefecture || '地域不明'}・${formatYearMonth(row.date)}`));
    item.append(action, copy);
    return item;
  }));
  const morePanel = document.querySelector('#profile-recent-more');
  const hiddenCount = Math.max(0, rows.length - 6);
  morePanel.hidden = hiddenCount === 0;
  morePanel.open = false;
  morePanel.querySelector('summary').textContent = `続きを表示（${numberFormat.format(hiddenCount)}件）`;
}

document.querySelector('#profile-recent-more').addEventListener('toggle', event => {
  const target = document.querySelector('#profile-recent');
  const expanded = event.currentTarget.open;
  target.classList.toggle('is-expanded', expanded);
  event.currentTarget.querySelector('summary').textContent = expanded
    ? '閉じる'
    : `続きを表示（${numberFormat.format(Math.max(0, target.children.length - 6))}件）`;
});

function renderRelated(rows) {
  const target = document.querySelector('#profile-related');
  target.replaceChildren(...rows.map((row, index) => mapperListItem(row, index, false)));
  if (!rows.length) target.append(element('li', 'profile-empty', '関連するマッパーはまだ見つかりません。'));
}

function previousBadgeKeys(uid) {
  try {
    const snapshot = JSON.parse(localStorage.getItem(`osm-profile-${uid}`) || 'null');
    return Array.isArray(snapshot?.badgeKeys) ? new Set(snapshot.badgeKeys.map(String)) : null;
  } catch {
    return null;
  }
}

window.clearProfileBadgeHistory = function clearProfileBadgeHistory() {
  const uid = new URLSearchParams(location.search).get('uid')?.trim() || '';
  if (!/^[1-9]\d*$/.test(uid)) {
    console.warn('UIDを指定したプロフィールページで実行してください。');
    return false;
  }
  try {
    const key = `osm-profile-${uid}`;
    const snapshot = JSON.parse(localStorage.getItem(key) || '{}');
    snapshot.badgeKeys = [];
    snapshot.badges = 0;
    localStorage.setItem(key, JSON.stringify(snapshot));
    location.reload();
    return true;
  } catch (error) {
    console.error('バッジ所持情報をクリアできませんでした。', error);
    return false;
  }
};

function rememberSnapshot(data) {
  try {
    localStorage.setItem(`osm-profile-${data.profile.editor_uid}`, JSON.stringify({
      total: data.profile.total_count,
      badges: data.badges.length,
      badgeKeys: data.badges.map(badge => badge.badgeKey),
      calculatedAt: data.meta.calculatedAt,
    }));
  } catch { /* Storage is optional. */ }
}

function renderProfile(data) {
  const profile = data.profile;
  const previousKeys = previousBadgeKeys(profile.editor_uid);
  newlyEarnedBadgeKeys = previousKeys === null
    ? new Set()
    : new Set(data.badges.map(badge => badge.badgeKey).filter(key => !previousKeys.has(key)));
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
  renderBadges(data, newlyEarnedBadgeKeys);
  const replayButton = document.querySelector('#profile-replay-badges');
  replayButton.hidden = newlyEarnedBadgeKeys.size === 0;
  replayButton.textContent = newlyEarnedBadgeKeys.size > 1
    ? `もう一度見る（${numberFormat.format(newlyEarnedBadgeKeys.size)}個）`
    : 'もう一度見る';
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
  if (newlyEarnedBadgeKeys.size) window.setTimeout(playNewBadgeEffect, 150);
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
