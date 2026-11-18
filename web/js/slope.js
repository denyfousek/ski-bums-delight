// Slope analysis from swissALTI3D (2 m COG tiles, read at their 4 m overview).
// Computes slope + aspect per cell and paints either swisstopo-style slope classes or
// "critical" slopes: >= 30° whose aspect and elevation match today's bulletin problems.
import { ALTI3D_ITEMS_URL, ANALYSIS_CELL_M, GEOLIB } from './config.js';
import { lv95ToWgs, wgsToLv95, aspectSector } from './proj.js';

let geotiffLib = null;
async function geotiff() {
  if (!geotiffLib) geotiffLib = await import(GEOLIB.geotiff);
  return geotiffLib;
}

const TILE_M = 1000;
const NATIVE_PX = 250; // 4 m overview of the 2 m COG tiles

async function findTiles(e0, n0, e1, n1) {
  const corners = [lv95ToWgs(e0, n0), lv95ToWgs(e1, n1), lv95ToWgs(e0, n1), lv95ToWgs(e1, n0)];
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(',');
  let url = `${ALTI3D_ITEMS_URL}?bbox=${bbox}&limit=100`;
  const byTile = new Map(); // "E-N" -> { e, n, versions: [{ year, href }] newest first }
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`swissALTI3D search HTTP ${res.status}`);
    const page = await res.json();
    for (const item of page.features || []) {
      const m = /swissalti3d_(\d{4})_(\d{4})-(\d{4})/.exec(item.id);
      if (!m) continue;
      const asset = Object.values(item.assets).find((a) => /_2_2056_\d+\.tif$/.test(a.href));
      if (!asset) continue;
      const key = `${m[2]}-${m[3]}`;
      if (!byTile.has(key)) byTile.set(key, { e: Number(m[2]), n: Number(m[3]), versions: [] });
      byTile.get(key).versions.push({ year: Number(m[1]), href: asset.href });
    }
    const next = (page.links || []).find((l) => l.rel === 'next');
    url = next ? next.href : null;
  }
  for (const t of byTile.values()) t.versions.sort((a, b) => b.year - a.year);
  return [...byTile.values()].filter((t) => t.e * 1000 >= e0 && t.e * 1000 < e1 && t.n * 1000 >= n0 && t.n * 1000 < n1);
}

async function readTile(href, TILE_PX) {
  const { fromUrl } = await geotiff();
  const tiff = await fromUrl(href);
  const count = await tiff.getImageCount();
  // Prefer the 250 px overview (4 m); coarser grids are block-averaged from it.
  let image = await tiff.getImage(0);
  for (let i = 1; i < count; i++) {
    const img = await tiff.getImage(i);
    if (img.getWidth() === NATIVE_PX) { image = img; break; }
  }
  const opts = { interleave: true };
  if (image.getWidth() !== NATIVE_PX) Object.assign(opts, { width: NATIVE_PX, height: NATIVE_PX, resampleMethod: 'bilinear' });
  const data = await image.readRasters(opts);
  if (TILE_PX === NATIVE_PX) return data;
  const k = NATIVE_PX / TILE_PX;
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let r = 0; r < TILE_PX; r++) {
    for (let c = 0; c < TILE_PX; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = 0; dr < k; dr++) {
        for (let dc = 0; dc < k; dc++) {
          const v = data[(r * k + dr) * NATIVE_PX + c * k + dc];
          if (v > -1000) { sum += v; n++; }
        }
      }
      out[r * TILE_PX + c] = n ? sum / n : -9999;
    }
  }
  return out;
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// Loads a DEM square (LV95, metres) centred on lon/lat. Returns a grid object.
// cellM: 4 m (native overview) or a multiple of it that divides 1000 (8, 20 ...).
export async function loadDem(lon, lat, sizeM, onProgress, cellM = ANALYSIS_CELL_M, parallel = 6) {
  const TILE_PX = TILE_M / cellM;
  const [cE, cN] = wgsToLv95(lon, lat);
  const half = sizeM / 2;
  const e0 = Math.floor((cE - half) / TILE_M) * TILE_M;
  const n0 = Math.floor((cN - half) / TILE_M) * TILE_M;
  const e1 = Math.ceil((cE + half) / TILE_M) * TILE_M;
  const n1 = Math.ceil((cN + half) / TILE_M) * TILE_M;
  const tiles = await findTiles(e0, n0, e1, n1);
  if (!tiles.length) throw new Error('No swissALTI3D tiles found here.');
  const cols = ((e1 - e0) / TILE_M) * TILE_PX;
  const rows = ((n1 - n0) / TILE_M) * TILE_PX;
  const z = new Float32Array(cols * rows).fill(NaN);
  let done = 0;
  let failed = 0;
  await pool(tiles, parallel, async (t) => {
    // Some published tiles cannot be decoded (seen: one 2022 tile); fall back to older years.
    let data = null;
    for (const v of t.versions) {
      try { data = await readTile(v.href, TILE_PX); break; } catch { /* try the next year */ }
    }
    done++;
    if (onProgress) onProgress(done, tiles.length);
    if (!data) { failed++; return; }
    const c0 = ((t.e * 1000 - e0) / TILE_M) * TILE_PX;
    const r0 = ((n1 - (t.n * 1000 + TILE_M)) / TILE_M) * TILE_PX;
    for (let r = 0; r < TILE_PX; r++) {
      for (let c = 0; c < TILE_PX; c++) {
        const v = data[r * TILE_PX + c];
        z[(r0 + r) * cols + c0 + c] = v < -1000 ? NaN : v;
      }
    }
  });
  return { z, cols, rows, e0, nTop: n1, cell: cellM, failedTiles: failed };
}

// Horn's method. Aspect = compass direction the slope faces (downhill), degrees.
export function computeSlopeAspect(grid) {
  const { z, cols, rows, cell } = grid;
  const slope = new Float32Array(cols * rows).fill(NaN);
  const aspect = new Float32Array(cols * rows).fill(NaN);
  const at = (r, c) => z[r * cols + c];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const a = at(r - 1, c - 1), b = at(r - 1, c), d = at(r - 1, c + 1);
      const e = at(r, c - 1), f = at(r, c + 1);
      const g = at(r + 1, c - 1), h = at(r + 1, c), i = at(r + 1, c + 1);
      const dzdx = ((d + 2 * f + i) - (a + 2 * e + g)) / (8 * cell); // towards east
      const dzdn = ((a + 2 * b + d) - (g + 2 * h + i)) / (8 * cell); // towards north (row 0 = north)
      if (!Number.isFinite(dzdx) || !Number.isFinite(dzdn)) continue;
      const k = r * cols + c;
      slope[k] = (Math.atan(Math.hypot(dzdx, dzdn)) * 180) / Math.PI;
      aspect[k] = ((Math.atan2(-dzdx, -dzdn) * 180) / Math.PI + 360) % 360;
    }
  }
  return { ...grid, slope, aspect };
}

export function sampleGrid(g, lon, lat) {
  const [E, N] = wgsToLv95(lon, lat);
  const c = Math.round((E - g.e0) / g.cell - 0.5);
  const r = Math.round((g.nTop - N) / g.cell - 0.5);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return null;
  const k = r * g.cols + c;
  return { elevation: g.z[k], slope: g.slope[k], aspect: g.aspect[k], forest: g.forest ? g.forest[k] === 1 : false };
}

const CLASS_COLORS = [
  [30, [245, 212, 0]],
  [35, [240, 138, 0]],
  [40, [215, 25, 28]],
  [45, [142, 43, 176]],
];

function classColor(s) {
  let col = null;
  for (const [min, rgb] of CLASS_COLORS) if (s >= min) col = rgb;
  return col;
}

export function isCritical(cell, rules) {
  if (!(cell.slope >= 30)) return false;
  const sector = aspectSector(cell.aspect);
  return rules.some((r) => r.aspects.has(sector)
    && (r.lower === null || cell.elevation >= r.lower)
    && (r.upper === null || cell.elevation <= r.upper));
}

// Paints the analysis into a WGS84-aligned canvas and returns it with its rectangle.
// mode: 'classes' | 'critical'. rules: from bulletin.criticalRules().
// forestProtects: critical cells inside closed forest are shown and counted separately.
export function renderOverlay(g, mode, rules, forestProtects = false) {
  const e1 = g.e0 + g.cols * g.cell;
  const nBottom = g.nTop - g.rows * g.cell;
  const corners = [lv95ToWgs(g.e0, g.nTop), lv95ToWgs(e1, g.nTop), lv95ToWgs(g.e0, nBottom), lv95ToWgs(e1, nBottom)];
  const west = Math.min(...corners.map((c) => c[0]));
  const east = Math.max(...corners.map((c) => c[0]));
  const south = Math.min(...corners.map((c) => c[1]));
  const north = Math.max(...corners.map((c) => c[1]));
  const scale = Math.min(1, 2048 / Math.max(g.cols, g.rows));
  const W = Math.round(g.cols * scale);
  const H = Math.round(g.rows * scale);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  let critical = 0;
  let forested = 0;
  let steep = 0;
  for (let j = 0; j < H; j++) {
    const lat = north - ((j + 0.5) / H) * (north - south);
    for (let i = 0; i < W; i++) {
      const lon = west + ((i + 0.5) / W) * (east - west);
      const cell = sampleGrid(g, lon, lat);
      if (!cell || !(cell.slope >= 30)) continue;
      steep++;
      const o = (j * W + i) * 4;
      if (mode === 'critical') {
        if (isCritical(cell, rules) && forestProtects && cell.forest) {
          forested++;
          px[o] = 30; px[o + 1] = 120; px[o + 2] = 60; px[o + 3] = 150;
        } else if (isCritical(cell, rules)) {
          critical++;
          px[o] = 200; px[o + 1] = 16; px[o + 2] = 46; px[o + 3] = 190;
        } else {
          px[o] = 90; px[o + 1] = 90; px[o + 2] = 90; px[o + 3] = 60;
        }
      } else {
        const rgb = classColor(cell.slope);
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 150;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, west, south, east, north, critical, forested, steep, total: W * H };
}
