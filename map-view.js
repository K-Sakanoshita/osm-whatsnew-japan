(() => {
  const STORAGE_KEY = 'osm-whatsnew-map-view-v1';

  const finiteInRange = (value, minimum, maximum) => {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum
      ? number
      : null;
  };

  function storedView() {
    try {
      const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      const latitude = finiteInRange(value.lat, -85, 85);
      const longitude = finiteInRange(value.lon, -180, 180);
      const zoom = finiteInRange(value.zoom, 0, 24);
      return latitude === null || longitude === null || zoom === null
        ? null
        : {latitude, longitude, zoom};
    } catch {
      return null;
    }
  }

  function read({
    fallbackCenter = [137.2, 36.2],
    fallbackZoom = 4.15,
    minZoom = 0,
    maxZoom = 24,
  } = {}) {
    const stored = storedView();
    const parameters = new URL(window.location.href).searchParams;
    const parameterLatitude = finiteInRange(parameters.get('lat'), -85, 85);
    const parameterLongitude = finiteInRange(parameters.get('lon'), -180, 180);
    const parameterZoom = finiteInRange(parameters.get('zoom'), minZoom, maxZoom);
    const latitude = parameterLatitude ?? stored?.latitude ?? fallbackCenter[1];
    const longitude = parameterLongitude ?? stored?.longitude ?? fallbackCenter[0];
    const zoom = Math.max(
      minZoom,
      Math.min(maxZoom, parameterZoom ?? stored?.zoom ?? fallbackZoom),
    );
    return {center: [longitude, latitude], zoom};
  }

  function save(map) {
    const center = map.getCenter();
    const view = {
      lat: Number(center.lat.toFixed(6)),
      lon: Number(center.lng.toFixed(6)),
      zoom: Number(map.getZoom().toFixed(2)),
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      // Storage may be unavailable in private or restricted browsing contexts.
    }
  }

  function bind(map) {
    save(map);
    map.on('moveend', () => save(map));
  }

  window.osmSharedMapView = {read, save, bind};
})();

(() => {
  const locale = Object.freeze({
    'GeolocateControl.FindMyLocation': '現在地へ移動',
    'GeolocateControl.LocationNotAvailable': '現在地を取得できません',
  });

  function add(map) {
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.addControl(new maplibregl.GeolocateControl({
      positionOptions: {enableHighAccuracy: true},
      trackUserLocation: false,
      showUserLocation: true,
      fitBoundsOptions: {maxZoom: 15},
    }), 'bottom-right');
  }

  window.osmSharedMapControls = {add, locale};
})();
