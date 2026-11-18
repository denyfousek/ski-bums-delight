// GPX import and analysis: distance, ascent/descent, elevation profile, terrain slope along
// the track and wildlife rest zones the track crosses.
import { IDENTIFY_URL } from './config.js';
import { haversine, pointInGeometry } from './proj.js';

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid GPX.');
  const nodes = [...doc.querySelectorAll('trkpt')];
  const pts = (nodes.length ? nodes : [...doc.querySelectorAll('rtept, wpt')]).map((n) => {
    const ele = n.querySelector('ele');
    return {
      lat: Number(n.getAttribute('lat')),
      lon: Number(n.getAttribute('lon')),
      ele: ele ? Number(ele.textContent) : null,
    };
  }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) throw new Error('The GPX file has fewer than two points.');
  const nameNode = doc.querySelector('trk > name, rte > name, metadata > name');
  return { name: nameNode ? nameNode.textContent.trim() : 'GPX route', points: pts };
}

// Resample to roughly one point every `step` metres so analysis cost stays bounded.
export function resample(points, step = 20) {
  const out = [{ ...points[0], dist: 0 }];
  let carried = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversine(a.lon, a.lat, b.lon, b.lat);
    let pos = step - carried;
    while (pos <= d) {
      const t = pos / d;
      out.push({
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
        ele: a.ele != null && b.ele != null ? a.ele + (b.ele - a.ele) * t : null,
        dist: total + pos,
      });
      pos += step;
    }
    carried = d - (pos - step);
    total += d;
  }
  const last = points[points.length - 1];
  out.push({ ...last, dist: total });
  return out;
}

// Terrain elevation and slope at every point from the swisstopo 3D terrain:
// sample the point plus four neighbours 15 m away (east, west, north, south).
export async function terrainSlopes(terrainProvider, pts) {
  const d = 15;
  const carto = [];
  for (const p of pts) {
    const dLat = d / 111320;
    const dLon = d / (111320 * Math.cos((p.lat * Math.PI) / 180));
    for (const [lo, la] of [[0, 0], [dLon, 0], [-dLon, 0], [0, dLat], [0, -dLat]]) {
      carto.push(Cesium.Cartographic.fromDegrees(p.lon + lo, p.lat + la));
    }
  }
  await Cesium.sampleTerrainMostDetailed(terrainProvider, carto);
  return pts.map((p, i) => {
    const [c, e, w, n, s] = carto.slice(i * 5, i * 5 + 5).map((x) => x.height);
    const dzdx = (e - w) / (2 * d);
    const dzdy = (n - s) / (2 * d);
    return { ...p, terrainEle: c, slope: (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI };
  });
}

export function stats(pts) {
  let up = 0;
  let down = 0;
  for (let i = 1; i < pts.length; i++) {
    const dz = pts[i].z - pts[i - 1].z;
    if (dz > 0) up += dz; else down -= dz;
  }
  const steep = pts.filter((p) => p.slope >= 30);
  const zs = pts.map((p) => p.z);
  return {
    distance: pts[pts.length - 1].dist,
    up, down,
    minZ: Math.min(...zs),
    maxZ: Math.max(...zs),
    steepShare: steep.length / pts.length,
    maxSlope: Math.max(...pts.map((p) => p.slope)),
  };
}

export async function wildlifeZonesOnRoute(pts) {
  const lons = pts.map((p) => p.lon);
  const lats = pts.map((p) => p.lat);
  const box = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(',');
  const q = new URLSearchParams({
    geometryType: 'esriGeometryEnvelope', geometry: box, sr: '4326',
    imageDisplay: '1000,1000,96', mapExtent: box, tolerance: '0',
    geometryFormat: 'geojson', returnGeometry: 'true', lang: 'en',
    layers: 'all:ch.bafu.wrz-wildruhezonen_portal,ch.bafu.wrz-jagdbanngebiete_select',
  });
  const res = await fetch(`${IDENTIFY_URL}?${q}`);
  if (!res.ok) throw new Error(`Identify HTTP ${res.status}`);
  const data = await res.json();
  const hits = [];
  for (const f of data.results || []) {
    const inside = pts.filter((p) => pointInGeometry(p.lon, p.lat, f.geometry));
    if (inside.length) {
      hits.push({
        layer: f.layerBodId,
        name: f.properties.wrz_name || f.properties.label || f.properties.name || 'Protected area',
        rule: f.properties.best_de || f.properties.bestimmung || '',
        period: f.properties.schutzzeit || '',
        binding: f.properties.schutzs_de || '',
        fromKm: inside[0].dist / 1000,
        toKm: inside[inside.length - 1].dist / 1000,
      });
    }
  }
  return hits;
}

// Elevation profile with steep sections (>= 30°) shaded.
export function drawProfile(canvas, pts) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pad = { l: 38, r: 8, t: 8, b: 18 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;
  const maxD = pts[pts.length - 1].dist;
  const zs = pts.map((p) => p.z);
  const z0 = Math.floor(Math.min(...zs) / 100) * 100;
  const z1 = Math.ceil(Math.max(...zs) / 100) * 100;
  const X = (d) => pad.l + (d / maxD) * W;
  const Y = (z) => pad.t + H - ((z - z0) / Math.max(1, z1 - z0)) * H;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = 'rgba(200,16,46,0.18)';
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].slope >= 30) ctx.fillRect(X(pts[i - 1].dist), pad.t, Math.max(1, X(pts[i].dist) - X(pts[i - 1].dist)), H);
  }
  ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#ccc';
  ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#777';
  ctx.font = '10px system-ui, sans-serif';
  for (let z = z0; z <= z1; z += Math.max(100, Math.round((z1 - z0) / 4 / 100) * 100)) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(z));
    ctx.lineTo(pad.l + W, Y(z));
    ctx.stroke();
    ctx.fillText(`${z}`, 2, Y(z) + 3);
  }
  ctx.fillText(`${(maxD / 1000).toFixed(1)} km`, pad.l + W - 34, cssH - 4);
  ctx.strokeStyle = css.getPropertyValue('--accent').trim() || '#8e2f3a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.dist), Y(p.z)) : ctx.moveTo(X(p.dist), Y(p.z))));
  ctx.stroke();
}
