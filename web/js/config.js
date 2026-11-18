// Central configuration: area, data endpoints, layer IDs.

export const AREA = {
  name: 'Andermatt – Realp',
  west: 8.45, south: 46.55, east: 8.70, north: 46.68,
};

// Camera south of the Urseren valley, looking north.
export const HOME_VIEW = { lon: 8.575, lat: 46.515, height: 6800, heading: 0, pitch: -32 };

export const TERRAIN_URL = 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/';

const WMTS = 'https://wmts.geo.admin.ch/1.0.0/{layer}/default/{time}/3857/{z}/{x}/{y}.{ext}';
export function wmtsUrl(layer, ext, time = 'current') {
  return WMTS.replace('{layer}', layer).replace('{ext}', ext).replace('{time}', time);
}

// SWISSIMAGE year mosaics (ch.swisstopo.swissimage-product), all summer flights.
// Not every year covers every region; missing areas stay empty.
export const SWISSIMAGE_YEARS = Array.from({ length: 2025 - 1947 + 1 }, (_, i) => String(2025 - i));

export const BASEMAPS = [
  { id: 'winter', label: 'National map (winter)', layer: 'ch.swisstopo.pixelkarte-farbe-winter', ext: 'jpeg', maxLevel: 18 },
  { id: 'summer', label: 'National map', layer: 'ch.swisstopo.pixelkarte-farbe', ext: 'jpeg', maxLevel: 18 },
  { id: 'image', label: 'SWISSIMAGE aerial', layer: 'ch.swisstopo.swissimage', ext: 'jpeg', maxLevel: 19 },
];

export const OVERLAYS = [
  { id: 'slope', label: 'Slope ≥ 30° (swisstopo)', layer: 'ch.swisstopo.hangneigung-ueber_30', alpha: 0.55, on: false },
  { id: 'skitours', label: 'Ski touring routes', layer: 'ch.swisstopo-karto.skitouren', alpha: 1, on: true },
  { id: 'snowshoe', label: 'Snowshoe routes', layer: 'ch.swisstopo-karto.schneeschuhrouten', alpha: 1, on: false },
  { id: 'lifts', label: 'Lifts & cableways', layer: 'ch.swisstopo.bahnen-winter', alpha: 1, on: true },
  { id: 'wildlife', label: 'Wildlife rest zones', layer: 'ch.bafu.wrz-wildruhezonen_portal', alpha: 0.7, on: true },
  { id: 'hunting', label: 'Wildlife protection areas', layer: 'ch.bafu.wrz-jagdbanngebiete_select', alpha: 0.6, on: false },
].map((o) => ({ ...o, ext: 'png', maxLevel: 17 })); // level 18 returns 400 for some overlays

// Layers that answer a map click with feature details (geo.admin identify).
export const IDENTIFY_LAYERS = [
  'ch.swisstopo-karto.skitouren',
  'ch.swisstopo-karto.schneeschuhrouten',
  'ch.bafu.wrz-wildruhezonen_portal',
  'ch.bafu.wrz-jagdbanngebiete_select',
  'ch.bav.seilbahnen-bundeskonzession',
];

export const IDENTIFY_URL = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify';
export const BULLETIN_URL = 'https://aws.slf.ch/api/bulletin/caaml/en/geojson';
export const IMIS_PROXY = '/proxy/imis/';
export const METEOSWISS_SNOW_URL =
  'https://data.geo.admin.ch/ch.meteoschweiz.messwerte-schneehoehe-automatisch-10min/ch.meteoschweiz.messwerte-schneehoehe-automatisch-10min_en.json';
export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const ALTI3D_ITEMS_URL = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items';
export const EARTH_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';

// The analysis box for the slope filter (square, metres). 8 km at 4 m = 2000 x 2000 cells.
export const ANALYSIS_SIZE_M = 8000;
export const ANALYSIS_CELL_M = 4;

// Bulletin elevations may say "treeline" instead of a number. Assumption, no source:
// the treeline in the central Swiss Alps lies roughly at 2000 m.
export const TREELINE_M = 2000;

// swissTLM3D land cover (layer "landcover") in the geo.admin base vector tiles, CORS open.
export const FOREST_TILES_URL = 'https://vectortiles{s}.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf';

export const GEOLIB = {
  geotiff: 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm',
  vectorTile: 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.3/+esm',
  pbf: 'https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm',
};
