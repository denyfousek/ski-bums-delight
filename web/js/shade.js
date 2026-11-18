// Sun and shade map from swissALTI3D: cast shadows of the real terrain, including
// mountains outside the shown square (a margin is loaded and swept, then cut away).
//
// Method: shadow-height propagation along the sun direction. Cells are processed column by
// column (or row by row) starting on the sun side; each cell takes the shadow height of the
// point one step towards the sun (linear interpolation between two neighbours), lowers it by
// step * tan(elevation) and is in shadow if the terrain lies below it. O(cells) per sun
// position, so the map follows the time slider. The interpolation blurs shadows by about one
// cell; isolated peaks therefore cast slightly short shadows.
import { lv95ToWgs, wgsToLv95 } from './proj.js';

export const SHADE_CORE_M = 8000;
export const SHADE_MARGIN_M = 4000; // a 700 m higher ridge still shades at 10° sun
export const SHADE_CELL_M = 8;

export const SUN = 0;
export const CAST = 1;  // terrain shadow from somewhere towards the sun
export const AWAY = 2;  // slope faces away from the sun
export const NIGHT = 3; // sun below the horizon

const BERN_LON = 7.43958333; // LV95 projection centre

// LV95 grid north differs from true north east and west of Bern (meridian convergence).
export function gridAzimuth(azDeg, lon, lat) {
  const gamma = (lon - BERN_LON) * Math.sin((lat * Math.PI) / 180);
  return azDeg - gamma;
}

export function computeShade(g, azDeg, elDeg) {
  const { z, cols, rows, cell } = g;
  const out = new Uint8Array(cols * rows);
  if (!(elDeg > 0)) { out.fill(NIGHT); return out; }
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const tanEl = Math.tan(el);
  const sx = Math.sin(az);  // towards the sun, + = east = +col
  const sy = -Math.cos(az); // towards the sun, + = south = +row
  const H = new Float32Array(cols * rows);
  const LOW = -1e9;

  if (Math.abs(sx) >= Math.abs(sy)) {
    const d = sx > 0 ? 1 : -1;            // neighbour column towards the sun
    const f = sy / Math.abs(sx);          // row offset per column step
    const drop = cell * Math.hypot(1, f) * tanEl;
    const start = d > 0 ? cols - 1 : 0;
    for (let step = 0; step < cols; step++) {
      const c = start - d * step;
      const cu = c + d;
      for (let r = 0; r < rows; r++) {
        const k = r * cols + c;
        const zz = z[k];
        if (!Number.isFinite(zz)) { H[k] = LOW; continue; }
        if (step === 0) { H[k] = zz; continue; }
        const rr = r + f;
        const r0 = Math.floor(rr);
        if (r0 < 0 || r0 >= rows) { H[k] = zz; continue; } // ray leaves the grid
        const r1 = Math.min(r0 + 1, rows - 1);
        const t = rr - r0;
        const ray = H[r0 * cols + cu] * (1 - t) + H[r1 * cols + cu] * t - drop;
        if (ray > zz + 0.5) { out[k] = CAST; H[k] = ray; } else H[k] = zz;
      }
    }
  } else {
    const d = sy > 0 ? 1 : -1;            // neighbour row towards the sun
    const f = sx / Math.abs(sy);          // column offset per row step
    const drop = cell * Math.hypot(1, f) * tanEl;
    const start = d > 0 ? rows - 1 : 0;
    for (let step = 0; step < rows; step++) {
      const r = start - d * step;
      const ru = r + d;
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        const zz = z[k];
        if (!Number.isFinite(zz)) { H[k] = LOW; continue; }
        if (step === 0) { H[k] = zz; continue; }
        const cc = c + f;
        const c0 = Math.floor(cc);
        if (c0 < 0 || c0 >= cols) { H[k] = zz; continue; }
        const c1 = Math.min(c0 + 1, cols - 1);
        const t = cc - c0;
        const ray = H[ru * cols + c0] * (1 - t) + H[ru * cols + c1] * t - drop;
        if (ray > zz + 0.5) { out[k] = CAST; H[k] = ray; } else H[k] = zz;
      }
    }
  }

  // Self-shading: slopes whose normal points away from the sun.
  const se = Math.cos(el) * Math.sin(az);
  const sn = Math.cos(el) * Math.cos(az);
  const su = Math.sin(el);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const k = r * cols + c;
      if (out[k] !== SUN) continue;
      const dzdx = (z[k + 1] - z[k - 1]) / (2 * cell);
      const dzdn = (z[k - cols] - z[k + cols]) / (2 * cell);
      if (-dzdx * se - dzdn * sn + su < 0) out[k] = AWAY;
    }
  }
  return out;
}

// Precomputes, for a WGS84 canvas over the core square, which grid cell each pixel shows.
export function buildPixelMap(g, centerLon, centerLat) {
  const [cE, cN] = wgsToLv95(centerLon, centerLat);
  const h = SHADE_CORE_M / 2;
  const corners = [lv95ToWgs(cE - h, cN - h), lv95ToWgs(cE + h, cN - h), lv95ToWgs(cE - h, cN + h), lv95ToWgs(cE + h, cN + h)];
  const west = Math.min(...corners.map((p) => p[0]));
  const east = Math.max(...corners.map((p) => p[0]));
  const south = Math.min(...corners.map((p) => p[1]));
  const north = Math.max(...corners.map((p) => p[1]));
  const W = Math.round(SHADE_CORE_M / SHADE_CELL_M);
  const H = Math.round(W * ((north - south) / (east - west)) / Math.cos(((north + south) / 2) * Math.PI / 180));
  const idx = new Int32Array(W * H).fill(-1);
  for (let j = 0; j < H; j++) {
    const lat = north - ((j + 0.5) / H) * (north - south);
    for (let i = 0; i < W; i++) {
      const lon = west + ((i + 0.5) / W) * (east - west);
      const [E, N] = wgsToLv95(lon, lat);
      if (Math.abs(E - cE) > h || Math.abs(N - cN) > h) continue;
      const c = Math.floor((E - g.e0) / g.cell);
      const r = Math.floor((g.nTop - N) / g.cell);
      if (c >= 0 && r >= 0 && c < g.cols && r < g.rows) idx[j * W + i] = r * g.cols + c;
    }
  }
  return { idx, W, H, west, south, east, north };
}

// Paints shade into the precomputed canvas layout. Returns { canvas, sunlit } (share 0..1).
export function renderShade(map, shade) {
  const canvas = document.createElement('canvas');
  canvas.width = map.W;
  canvas.height = map.H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(map.W, map.H);
  const px = img.data;
  let sun = 0;
  let total = 0;
  for (let p = 0; p < map.idx.length; p++) {
    const k = map.idx[p];
    if (k < 0) continue;
    total++;
    const s = shade[k];
    if (s === SUN) { sun++; continue; }
    const o = p * 4;
    px[o] = 24; px[o + 1] = 34; px[o + 2] = 72;
    px[o + 3] = s === NIGHT ? 150 : 120;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, sunlit: total ? sun / total : 0 };
}

export function shadeAt(g, shade, lon, lat) {
  const [E, N] = wgsToLv95(lon, lat);
  const c = Math.floor((E - g.e0) / g.cell);
  const r = Math.floor((g.nTop - N) / g.cell);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return null;
  return shade[r * g.cols + c];
}
