// Snow depth and wind from measuring stations:
//  - SLF IMIS stations (CC BY 4.0) from the hourly snapshot data/imis.json (30-min values)
//  - MeteoSwiss automatic snow depth (Source: MeteoSwiss, GeoJSON in LV95)
import { METEOSWISS_SNOW_URL } from './config.js';
import { lv95ToWgs } from './proj.js';

// A snapshot older than this gets a warning. Setting, not a source: hourly run plus two missed.
export const SNAPSHOT_MAX_AGE_H = 3;

function inBox(lon, lat, box, margin) {
  return lon >= box.west - margin && lon <= box.east + margin && lat >= box.south - margin && lat <= box.north + margin;
}

// The SLF stations of one area from the snapshot file (scripts/fetch_imis.py). The age is
// always taken from the time stamp inside the file, also when the file comes from the
// service worker's cache.
export function imisFromSnapshot(snap, box, now = Date.now()) {
  if (!snap || !Array.isArray(snap.stations) || !snap.fetched) throw new Error('station snapshot unreadable');
  const fetched = Date.parse(snap.fetched);
  const ageH = Number.isFinite(fetched) ? (now - fetched) / 3600e3 : null;
  return {
    fetched: snap.fetched,
    ageH,
    stale: ageH === null || ageH > SNAPSHOT_MAX_AGE_H,
    note: snap.note || 'raw station data, unchecked',
    stations: snap.stations
      .filter((s) => inBox(s.lon, s.lat, box, 0.06))
      .map((s) => ({ ...s, source: 'SLF IMIS' })),
  };
}

export async function fetchImis(box) {
  // Relative path: works locally (serve.py builds it) and under the GitHub Pages sub-path.
  const res = await fetch('data/imis.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return imisFromSnapshot(await res.json(), box);
}

export async function fetchMeteoSwissSnow(box) {
  const res = await fetch(METEOSWISS_SNOW_URL);
  if (!res.ok) throw new Error(`MeteoSwiss HTTP ${res.status}`);
  const gj = await res.json();
  return gj.features.map((f) => {
    const [lon, lat] = lv95ToWgs(f.geometry.coordinates[0], f.geometry.coordinates[1]);
    return {
      source: 'MeteoSwiss',
      code: f.id,
      name: f.properties.station_name,
      lon, lat,
      elevation: Number(f.properties.altitude),
      time: f.properties.reference_ts,
      snowCm: typeof f.properties.value === 'number' ? f.properties.value : null,
      windKmh: null,
    };
  }).filter((s) => inBox(s.lon, s.lat, box, 0.06));
}

export function compass(deg) {
  if (deg === null || deg === undefined) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

export function stationLabel(s) {
  const parts = [`${s.name} ${Math.round(s.elevation)} m`];
  if (s.snowCm !== null) parts.push(`❄ ${Math.round(s.snowCm)} cm`);
  if (s.windKmh !== null) parts.push(`➶ ${Math.round(s.windKmh)} km/h ${compass(s.windDir)}`);
  return parts.join('\n');
}

export function addStationEntities(viewer, stations) {
  const ds = new Cesium.CustomDataSource('stations');
  for (const s of stations) {
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
      point: {
        pixelSize: 9,
        color: s.source === 'SLF IMIS' ? Cesium.Color.fromCssColorString('#1f5fbf') : Cesium.Color.fromCssColorString('#2a8a4a'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: stationLabel(s),
        font: '600 12px "Inter", system-ui, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#2b1a1c'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#f6f1e4').withAlpha(0.9),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
        pixelOffset: new Cesium.Cartesian2(0, -18),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000),
      },
      station: s,
    });
  }
  viewer.dataSources.add(ds);
  return ds;
}
