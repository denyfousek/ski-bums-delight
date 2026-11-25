// Areas: named boxes (WGS84 degrees) the stations, satellite scenes and snow line are
// loaded for. Presets, a box around the current view, or a box around the user's position.

export const SWITZERLAND = { west: 5.9, south: 45.8, east: 10.5, north: 47.85 };

// Default box size: about 19 x 14.5 km (as the original Andermatt–Realp test area).
export const BOX_LON = 0.25;
export const BOX_LAT = 0.13;

export const PRESETS = [
  { id: 'andermatt', name: 'Andermatt – Realp', west: 8.45, south: 46.55, east: 8.70, north: 46.68 },
  { id: 'engelberg', name: 'Engelberg – Titlis', west: 8.30, south: 46.74, east: 8.55, north: 46.87 },
  { id: 'davos', name: 'Davos – Klosters', west: 9.72, south: 46.74, east: 9.97, north: 46.87 },
  { id: 'praettigau', name: 'Prättigau – Grüsch-Danusa', west: 9.55, south: 46.93, east: 9.80, north: 47.06 },
  { id: 'lenzerheide', name: 'Arosa – Lenzerheide', west: 9.50, south: 46.70, east: 9.75, north: 46.83 },
  { id: 'disentis', name: 'Disentis – Oberalp', west: 8.68, south: 46.63, east: 8.93, north: 46.76 },
  { id: 'bernina', name: 'St. Moritz – Bernina', west: 9.78, south: 46.38, east: 10.03, north: 46.51 },
  { id: 'grindelwald', name: 'Grindelwald – Jungfrau', west: 7.90, south: 46.53, east: 8.15, north: 46.66 },
  { id: 'verbier', name: 'Verbier – Val de Bagnes', west: 7.15, south: 46.02, east: 7.40, north: 46.15 },
  { id: 'zermatt', name: 'Zermatt', west: 7.62, south: 45.93, east: 7.87, north: 46.06 },
  { id: 'saas', name: 'Saas-Fee', west: 7.82, south: 46.04, east: 8.07, north: 46.17 },
  { id: 'glarus', name: 'Elm – Glarus Süd', west: 9.05, south: 46.85, east: 9.30, north: 46.98 },
];

export const DEFAULT_AREA = PRESETS[0];

export function centre(box) {
  return [(box.west + box.east) / 2, (box.south + box.north) / 2];
}

export function inSwitzerland(lon, lat) {
  return lon >= SWITZERLAND.west && lon <= SWITZERLAND.east && lat >= SWITZERLAND.south && lat <= SWITZERLAND.north;
}

// Box of the default size around a point, clamped so it stays inside the tile coverage.
export function boxAround(lon, lat, name, id = 'custom') {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const cLon = clamp(lon, SWITZERLAND.west + BOX_LON / 2, SWITZERLAND.east - BOX_LON / 2);
  const cLat = clamp(lat, SWITZERLAND.south + BOX_LAT / 2, SWITZERLAND.north - BOX_LAT / 2);
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return {
    id,
    name: name || `Around ${lat.toFixed(3)}° N, ${lon.toFixed(3)}° E`,
    west: r(cLon - BOX_LON / 2), south: r(cLat - BOX_LAT / 2),
    east: r(cLon + BOX_LON / 2), north: r(cLat + BOX_LAT / 2),
  };
}

// Camera south of the box, looking north across it.
export function homeView(box) {
  const [lon] = centre(box);
  return { lon, lat: box.south - (box.north - box.south) * 0.27, height: 6800, heading: 0, pitch: -32 };
}

// True for an object that can be used as an area (also guards what comes out of storage).
export function isArea(a) {
  return Boolean(a) && typeof a.name === 'string' && a.name.length <= 80
    && ['west', 'south', 'east', 'north'].every((k) => Number.isFinite(a[k]))
    && a.west < a.east && a.south < a.north
    && a.east - a.west <= 1 && a.north - a.south <= 1
    && inSwitzerland(a.west, a.south) && inSwitzerland(a.east, a.north);
}

const KEY = 'sbd-area';

export function loadArea(storage) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return DEFAULT_AREA;
    const a = JSON.parse(raw);
    const preset = PRESETS.find((p) => p.id === a.id);
    if (preset) return preset;
    return isArea(a) ? { id: 'custom', name: a.name, west: a.west, south: a.south, east: a.east, north: a.north } : DEFAULT_AREA;
  } catch {
    return DEFAULT_AREA;
  }
}

export function saveArea(storage, area) {
  try {
    storage.setItem(KEY, JSON.stringify(area));
  } catch { /* private window: the choice is just not remembered */ }
}
