// Snow depth and wind from measuring stations:
//  - SLF IMIS stations (CC BY 4.0, via the local proxy, 30-min values, last 24 h)
//  - MeteoSwiss automatic snow depth (Source: MeteoSwiss, GeoJSON in LV95)
import { IMIS_PROXY, METEOSWISS_SNOW_URL } from './config.js';
import { lv95ToWgs } from './proj.js';

// The IMIS API double-encodes UTF-8 in station labels ("BÃ¤rentÃ¤lli"). Repair when possible.
export function fixMojibake(s) {
  if (!/[ÃÂ]/.test(s || '')) return s;
  try {
    const bytes = Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 0xff));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function inBox(lon, lat, box, margin) {
  return lon >= box.west - margin && lon <= box.east + margin && lat >= box.south - margin && lat <= box.north + margin;
}

export async function fetchImis(box) {
  const res = await fetch(`${IMIS_PROXY}stations`);
  if (!res.ok) throw new Error(`IMIS stations HTTP ${res.status} (is serve.py running?)`);
  const stations = (await res.json()).filter((s) => inBox(s.lon, s.lat, box, 0.06));
  const out = [];
  await Promise.all(stations.map(async (s) => {
    try {
      const r = await fetch(`${IMIS_PROXY}station/${encodeURIComponent(s.code)}/measurements`);
      if (!r.ok) return;
      const series = await r.json();
      const last = [...series].reverse().find((m) => m.HS !== null || m.VW_30MIN_MEAN !== null) || null;
      const first = series.find((m) => m.HS !== null) || null;
      out.push({
        source: 'SLF IMIS',
        code: s.code,
        name: fixMojibake(s.label),
        lon: s.lon,
        lat: s.lat,
        elevation: s.elevation,
        type: s.type,
        time: last && last.measure_date,
        snowCm: last && last.HS != null ? last.HS : null,
        snowChange24h: last && first && last.HS != null && first.HS != null ? last.HS - first.HS : null,
        windKmh: last && last.VW_30MIN_MEAN != null ? last.VW_30MIN_MEAN * 3.6 : null,
        gustKmh: last && last.VW_30MIN_MAX != null ? last.VW_30MIN_MAX * 3.6 : null,
        windDir: last && last.DW_30MIN_MEAN != null ? last.DW_30MIN_MEAN : null,
        airC: last && last.TA_30MIN_MEAN != null ? last.TA_30MIN_MEAN : null,
      });
    } catch { /* one failing station must not break the rest */ }
  }));
  return out;
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
