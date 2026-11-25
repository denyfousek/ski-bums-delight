// GPX import and analysis: distance, ascent/descent, elevation profile, terrain slope and
// aspect along the track, a traffic-light check against the bulletin, and wildlife rest
// zones the track crosses.
import { IDENTIFY_URL } from './config.js';
import { haversine, pointInGeometry, aspectSector } from './proj.js';

// "<ele></ele>" and non-numeric text count as "no elevation" (Number('') would be 0).
export function parseElevation(textContent) {
  const t = String(textContent ?? '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid GPX.');
  const nodes = [...doc.querySelectorAll('trkpt')];
  const pts = (nodes.length ? nodes : [...doc.querySelectorAll('rtept, wpt')]).map((n) => {
    const ele = n.querySelector('ele');
    return {
      lat: Number(n.getAttribute('lat')),
      lon: Number(n.getAttribute('lon')),
      ele: ele ? parseElevation(ele.textContent) : null,
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

// Slope (degrees) and aspect (direction the slope faces, N = 0, clockwise) from the
// elevations of a point's east, west, north and south neighbours `d` metres away.
export function slopeAspect(e, w, n, s, d) {
  const dzdx = (e - w) / (2 * d);
  const dzdy = (n - s) / (2 * d);
  if (!Number.isFinite(dzdx) || !Number.isFinite(dzdy)) return { slope: NaN, aspect: NaN };
  return {
    slope: (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI,
    aspect: ((Math.atan2(-dzdx, -dzdy) * 180) / Math.PI + 360) % 360,
  };
}

// Terrain elevation, slope and aspect at every point from the swisstopo 3D terrain:
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
    return { ...p, terrainEle: Number.isFinite(c) ? c : null, ...slopeAspect(e, w, n, s, d) };
  });
}

// Ascent and descent with a threshold: a change only counts once it exceeds `threshold`
// metres from the last turning point. Without this, GPS noise of a metre or two per point
// adds up to hundreds of metres over a long track.
export function ascentDescent(zs, threshold = 5) {
  let up = 0;
  let down = 0;
  let anchor = null;
  for (const z of zs) {
    if (!Number.isFinite(z)) continue;
    if (anchor === null) { anchor = z; continue; }
    const dz = z - anchor;
    if (dz >= threshold) { up += dz; anchor = z; } else if (dz <= -threshold) { down -= dz; anchor = z; }
  }
  return { up, down };
}

export function stats(pts, threshold = 5) {
  const zs = pts.map((p) => p.z).filter(Number.isFinite);
  const slopes = pts.map((p) => p.slope).filter(Number.isFinite);
  const { up, down } = ascentDescent(zs, threshold);
  return {
    distance: pts[pts.length - 1].dist,
    up, down,
    minZ: zs.length ? Math.min(...zs) : NaN,
    maxZ: zs.length ? Math.max(...zs) : NaN,
    steepShare: slopes.length ? slopes.filter((s) => s >= 30).length / slopes.length : 0,
    maxSlope: slopes.length ? Math.max(...slopes) : NaN,
  };
}

// ---------- traffic-light check against the bulletin ----------
export const GREEN = 'green';   // below 30°
export const YELLOW = 'yellow'; // 30° or steeper
export const RED = 'red';       // 30° or steeper, in an aspect and elevation the bulletin names
export const UNKNOWN = 'unknown';
export const CHECK_COLORS = { green: '#2e9d57', yellow: '#f2b600', red: '#c8102e', unknown: '#8a8f98' };

// rules: array of { aspects: Set, lower, upper } (see bulletin.criticalRules), or null
// where no bulletin covers the point.
export function classifyPoint(p, rules) {
  if (!Number.isFinite(p.slope)) return UNKNOWN;
  if (p.slope < 30) return GREEN;
  if (!rules || !Number.isFinite(p.aspect) || !Number.isFinite(p.z)) return YELLOW;
  const sector = aspectSector(p.aspect);
  const named = rules.some((r) => r.aspects.has(sector)
    && (r.lower === null || p.z >= r.lower)
    && (r.upper === null || p.z <= r.upper));
  return named ? RED : YELLOW;
}

// Adds `check` to every point and merges neighbours into sections. Sections shorter than
// `minLen` metres are absorbed by the section before them, except red ones: a short red
// stretch is still worth showing. rulesAt(lon, lat) -> rules or null.
export function routeCheck(pts, rulesAt, minLen = 40) {
  const points = pts.map((p) => ({ ...p, check: classifyPoint(p, rulesAt ? rulesAt(p.lon, p.lat) : null) }));
  const raw = [];
  for (let i = 0; i < points.length; i++) {
    const last = raw[raw.length - 1];
    if (last && last.check === points[i].check) last.to = i; else raw.push({ check: points[i].check, from: i, to: i });
  }
  const merged = [];
  for (const s of raw) {
    const len = points[s.to].dist - points[Math.max(0, s.from - 1)].dist;
    const prev = merged[merged.length - 1];
    if (prev && (prev.check === s.check || (s.check !== RED && len < minLen))) prev.to = s.to;
    else merged.push({ ...s });
  }
  const sections = merged.map((s) => {
    const part = points.slice(s.from, s.to + 1);
    const slopes = part.map((p) => p.slope).filter(Number.isFinite);
    const zs = part.map((p) => p.z).filter(Number.isFinite);
    const steepest = part.reduce((best, p) => (Number.isFinite(p.slope) && (!best || p.slope > best.slope) ? p : best), null);
    return {
      check: s.check, from: s.from, to: s.to,
      fromKm: points[Math.max(0, s.from - 1)].dist / 1000,
      toKm: points[s.to].dist / 1000,
      maxSlope: slopes.length ? Math.max(...slopes) : NaN,
      aspect: steepest && Number.isFinite(steepest.aspect) ? aspectSector(steepest.aspect) : '',
      minZ: zs.length ? Math.min(...zs) : NaN,
      maxZ: zs.length ? Math.max(...zs) : NaN,
    };
  });
  const total = points[points.length - 1].dist || 1;
  const share = (c) => sections.filter((s) => s.check === c).reduce((n, s) => n + (s.toKm - s.fromKm) * 1000, 0) / total;
  return { points, sections, share: { green: share(GREEN), yellow: share(YELLOW), red: share(RED), unknown: share(UNKNOWN) } };
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

// Elevation profile. With `sections` (from routeCheck) the line and a band behind it take
// the traffic-light colours; without, steep stretches (>= 30°) are shaded.
export function drawProfile(canvas, pts, sections = null) {
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
  const maxD = pts[pts.length - 1].dist || 1;
  const zs = pts.map((p) => p.z).filter(Number.isFinite);
  if (!zs.length) return;
  const z0 = Math.floor(Math.min(...zs) / 100) * 100;
  const z1 = Math.ceil(Math.max(...zs) / 100) * 100;
  const X = (d) => pad.l + (d / maxD) * W;
  const Y = (z) => pad.t + H - ((z - z0) / Math.max(1, z1 - z0)) * H;
  const css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, cssW, cssH);
  if (sections) {
    for (const s of sections) {
      if (s.check === GREEN) continue;
      ctx.fillStyle = `${CHECK_COLORS[s.check]}33`;
      ctx.fillRect(X(s.fromKm * 1000), pad.t, Math.max(1, X(s.toKm * 1000) - X(s.fromKm * 1000)), H);
    }
  } else {
    ctx.fillStyle = 'rgba(200,16,46,0.18)';
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].slope >= 30) ctx.fillRect(X(pts[i - 1].dist), pad.t, Math.max(1, X(pts[i].dist) - X(pts[i - 1].dist)), H);
    }
  }
  ctx.strokeStyle = css.getPropertyValue('--line').trim() || '#ccc';
  ctx.fillStyle = css.getPropertyValue('--muted').trim() || '#777';
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (let z = z0; z <= z1; z += Math.max(100, Math.round((z1 - z0) / 4 / 100) * 100)) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(z));
    ctx.lineTo(pad.l + W, Y(z));
    ctx.stroke();
    ctx.fillText(`${z}`, 2, Y(z) + 3);
  }
  ctx.fillText(`${(maxD / 1000).toFixed(1)} km`, pad.l + W - 34, cssH - 4);
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  const accent = css.getPropertyValue('--accent').trim() || '#8e2f3a';
  const stroke = (from, to, colour) => {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    let started = false;
    for (let i = from; i <= to; i++) {
      if (!Number.isFinite(pts[i].z)) continue;
      if (started) ctx.lineTo(X(pts[i].dist), Y(pts[i].z)); else { ctx.moveTo(X(pts[i].dist), Y(pts[i].z)); started = true; }
    }
    ctx.stroke();
  };
  if (sections) for (const s of sections) stroke(Math.max(0, s.from - 1), s.to, CHECK_COLORS[s.check]);
  else stroke(0, pts.length - 1, accent);
}
