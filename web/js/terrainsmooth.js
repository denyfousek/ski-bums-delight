// Smoothing of the finest swisstopo terrain tiles.
// At level 18, the finest, the mesh has a vertex every 0.4 to 0.9 m and the heights jitter
// by a few decimetres from one vertex to the next (measured on a steep face above
// Andermatt). Under low sun this reads as terraces.
//
// Method: around every vertex a plane is fitted to the heights nearby, weighted by a
// Gaussian of the distance (moving least squares, degree 1). The vertex gets the plane's
// height (moved by 0.3 m at most), and its normal is the plane's normal. A plane fit reproduces any tilted plane
// exactly. At a tile's border the vertices of the neighbouring tiles are part of the fit.
// (Averaging each vertex with its mesh neighbours was tried first and dropped: on an
// irregular mesh it bends a steep, perfectly even slope and so adds bumps of its own.)
//
// The fit runs on a grid of sums: every vertex adds its weight, coordinates and height to
// its cell, the nine sums are blurred with the Gaussian, and each cell solves a 3 x 3 system.
// The first part is pure maths (tested in Node); the Cesium wiring is at the bottom.

// One-dimensional Gaussian weights for a blur of standard deviation `sigmaCells`.
function kernel(sigmaCells) {
  const r = Math.max(1, Math.ceil(sigmaCells * 3));
  const k = new Float64Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigmaCells * sigmaCells));
  return { k, r };
}

// Separable blur without normalisation: cells outside the grid simply contribute nothing.
function blur(src, cols, rows, { k, r }) {
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let s = 0;
      const lo = Math.max(0, i - r);
      const hi = Math.min(cols - 1, i + r);
      for (let x = lo; x <= hi; x++) s += src[j * cols + x] * k[x - i + r];
      tmp[j * cols + i] = s;
    }
  }
  for (let j = 0; j < rows; j++) {
    const lo = Math.max(0, j - r);
    const hi = Math.min(rows - 1, j + r);
    for (let i = 0; i < cols; i++) {
      let s = 0;
      for (let y = lo; y <= hi; y++) s += tmp[y * cols + i] * k[y - j + r];
      out[j * cols + i] = s;
    }
  }
  return out;
}

// Fits the planes. x, y, z: vertex coordinates in metres, x in [0, width], y in [0, height].
// Returns per vertex z (fitted height), gx, gy (its slope towards east and north) and
// ok (0 where too few points were near for a fit; those vertices keep their own height
// and get slope 0).
export function fitPlanes(x, y, z, width, height, sigma, cell = 0.5) {
  const n = x.length;
  const cols = Math.max(2, Math.ceil(width / cell) + 1);
  const rows = Math.max(2, Math.ceil(height / cell) + 1);
  const size = cols * rows;
  const z0 = n ? z[0] : 0; // heights relative to one vertex keep the sums small
  // Sums per cell: w, x, y, xx, xy, yy, z, xz, yz (coordinates from the tile's corner).
  const A = Array.from({ length: 9 }, () => new Float64Array(size));
  for (let i = 0; i < n; i++) {
    const ci = Math.min(cols - 1, Math.max(0, Math.round(x[i] / cell)));
    const cj = Math.min(rows - 1, Math.max(0, Math.round(y[i] / cell)));
    const k = cj * cols + ci;
    const dz = z[i] - z0;
    A[0][k] += 1; A[1][k] += x[i]; A[2][k] += y[i];
    A[3][k] += x[i] * x[i]; A[4][k] += x[i] * y[i]; A[5][k] += y[i] * y[i];
    A[6][k] += dz; A[7][k] += x[i] * dz; A[8][k] += y[i] * dz;
  }
  const kern = kernel(sigma / cell);
  const B = A.map((a) => blur(a, cols, rows, kern));

  // Plane per cell, centred on the cell: height c at the centre, slopes a (east), b (north).
  const pc = new Float64Array(size);
  const pa = new Float64Array(size);
  const pb = new Float64Array(size);
  const good = new Uint8Array(size);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const w = B[0][k];
      if (w < 2.5) continue; // fewer than about three points in reach
      // Shift the sums so that the cell centre (X, Y) is the origin.
      const X = i * cell; const Y = j * cell;
      const sx = B[1][k] - X * w; const sy = B[2][k] - Y * w;
      const sxx = B[3][k] - 2 * X * B[1][k] + X * X * w;
      const sxy = B[4][k] - X * B[2][k] - Y * B[1][k] + X * Y * w;
      const syy = B[5][k] - 2 * Y * B[2][k] + Y * Y * w;
      const sz = B[6][k]; const sxz = B[7][k] - X * sz; const syz = B[8][k] - Y * sz;
      // Solve [w sx sy; sx sxx sxy; sy sxy syy] [c a b]' = [sz sxz syz]'
      const det = w * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
      // Points nearly on one line (or one spot) give no plane: compare with the spread they
      // would have if they filled the Gaussian evenly.
      if (!(det > 1e-4 * w * w * w * sigma ** 4)) continue;
      pc[k] = (sz * (sxx * syy - sxy * sxy) - sx * (sxz * syy - sxy * syz) + sy * (sxz * sxy - sxx * syz)) / det;
      pa[k] = (w * (sxz * syy - syz * sxy) - sz * (sx * syy - sxy * sy) + sy * (sx * syz - sxz * sy)) / det;
      pb[k] = (w * (sxx * syz - sxy * sxz) - sx * (sx * syz - sxz * sy) + sz * (sx * sxy - sxx * sy)) / det;
      good[k] = 1;
    }
  }

  // Each vertex takes the planes of the four cells around it, blended by distance.
  const out = { z: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n), ok: new Uint8Array(n) };
  for (let v = 0; v < n; v++) {
    const fx = Math.min(cols - 1.000001, Math.max(0, x[v] / cell));
    const fy = Math.min(rows - 1.000001, Math.max(0, y[v] / cell));
    const i0 = Math.floor(fx); const j0 = Math.floor(fy);
    let ws = 0; let zz = 0; let ga = 0; let gb = 0;
    for (let dj = 0; dj <= 1; dj++) {
      for (let di = 0; di <= 1; di++) {
        const i = i0 + di; const j = j0 + dj;
        const k = j * cols + i;
        if (!good[k]) continue;
        const wt = (di ? fx - i0 : 1 - (fx - i0)) * (dj ? fy - j0 : 1 - (fy - j0));
        if (wt <= 0) continue;
        ws += wt;
        zz += wt * (pc[k] + pa[k] * (x[v] - i * cell) + pb[k] * (y[v] - j * cell));
        ga += wt * pa[k]; gb += wt * pb[k];
      }
    }
    if (ws > 1e-6) { out.z[v] = zz / ws + z0; out.gx[v] = ga / ws; out.gy[v] = gb / ws; out.ok[v] = 1; } else out.z[v] = z[v];
  }
  return out;
}

// What is done per terrain level. sigma: reach of the plane fit in metres; maxShift: the
// most a height may move (the jitter is a few decimetres; real steps such as rock bands,
// walls and road cuts must stay). Only level 18 is touched; level 17 (a vertex every ~2 m)
// is smooth as delivered.
export const SMOOTHING = { 18: { sigma: 1.6, maxShift: 0.3 } };

// ---------- worker ----------
// The fit costs 10 to 25 ms per tile, too much for the frame it would land in. It runs in a
// worker; the tile is handed to Cesium when the answer is back. Without workers (or if the
// worker fails to start) the fit runs on the main thread.
let worker = null;
let workerFailed = false;
let nextJob = 1;
const jobs = new Map();
function fitInWorker(xs, ys, hs, widthM, heightM, sigma) {
  if (workerFailed || typeof Worker === 'undefined') return Promise.resolve(fitPlanes(xs, ys, hs, widthM, heightM, sigma));
  if (!worker) {
    try {
      worker = new Worker(new URL('./terrainsmooth.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => { const job = jobs.get(e.data.id); jobs.delete(e.data.id); if (job) job.resolve(e.data.fit); };
      worker.onerror = () => {
        // Finish everything that is waiting on the main thread and stop using the worker.
        workerFailed = true;
        for (const job of jobs.values()) job.resolve(fitPlanes(job.xs, job.ys, job.hs, job.widthM, job.heightM, job.sigma));
        jobs.clear();
      };
    } catch {
      workerFailed = true;
      return Promise.resolve(fitPlanes(xs, ys, hs, widthM, heightM, sigma));
    }
  }
  return new Promise((resolve) => {
    const id = nextJob++;
    jobs.set(id, { resolve, xs, ys, hs, widthM, heightM, sigma });
    worker.postMessage({ id, xs, ys, hs, widthM, heightM, sigma }); // copies; the originals stay for the fallback
  });
}

// ---------- neighbouring tiles ----------
// A fit that sees one tile only has data on one side at the tile's border, so two tiles
// would light their shared edge differently and the tile grid would show. Each tile is
// therefore fitted together with a strip of every neighbour's vertices.

// The vertices within `margin` metres of a tile's border.
export function edgeBand(xs, ys, hs, widthM, heightM, margin) {
  const keep = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < margin || xs[i] > widthM - margin || ys[i] < margin || ys[i] > heightM - margin) keep.push(i);
  }
  const band = { x: new Float32Array(keep.length), y: new Float32Array(keep.length), h: new Float32Array(keep.length) };
  keep.forEach((i, k) => { band.x[k] = xs[i]; band.y[k] = ys[i]; band.h[k] = hs[i]; });
  return band;
}

// A tile's vertices followed by those neighbour vertices that lie within `margin` outside
// it. neighbours: [{ band, offX, offY }], the offset of the neighbour's south-west corner
// from this tile's. The result is shifted by `margin` so that all coordinates are positive;
// the tile's own vertices come first and keep their order.
export function withNeighbours(xs, ys, hs, widthM, heightM, margin, neighbours) {
  const ex = []; const ey = []; const eh = [];
  const eps = 0.02; // vertices on the shared edge exist in both tiles; take this tile's
  for (const { band, offX, offY } of neighbours) {
    for (let i = 0; i < band.x.length; i++) {
      const px = band.x[i] + offX; const py = band.y[i] + offY;
      if (px < -margin || px > widthM + margin || py < -margin || py > heightM + margin) continue;
      if (px >= -eps && px <= widthM + eps && py >= -eps && py <= heightM + eps) continue;
      ex.push(px); ey.push(py); eh.push(band.h[i]);
    }
  }
  const n = xs.length; const total = n + ex.length;
  const x = new Float32Array(total); const y = new Float32Array(total); const z = new Float32Array(total);
  for (let i = 0; i < n; i++) { x[i] = xs[i] + margin; y[i] = ys[i] + margin; z[i] = hs[i]; }
  for (let i = 0; i < ex.length; i++) { x[n + i] = ex[i] + margin; y[n + i] = ey[i] + margin; z[n + i] = eh[i]; }
  return { x, y, z, width: widthM + 2 * margin, height: heightM + 2 * margin };
}

const EARTH = 6378137;
const BAND_CACHE_MAX = 256;       // about 100 kB each
const NEIGHBOUR_WAIT_MS = 4000;   // after that the tile is shown without the missing neighbours
const bands = new Map();          // 'level/x/y' -> Promise of a band, or of null

function tileMetrics(provider, x, y, level) {
  const rect = provider.tilingScheme.tileXYToRectangle(x, y, level);
  const lat = (rect.south + rect.north) / 2;
  return { rect, lat, widthM: (rect.east - rect.west) * EARTH * Math.cos(lat), heightM: (rect.north - rect.south) * EARTH };
}

// Vertex positions in metres from the tile's south-west corner, heights above the ellipsoid.
function tileArrays(data, m) {
  const q = data && data._quantizedVertices;
  if (!q) return null;
  const range = data._maximumHeight - data._minimumHeight;
  if (!(range >= 0)) return null;
  const n = q.length / 3;
  const xs = new Float32Array(n); const ys = new Float32Array(n); const hs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (q[i] / 32767) * m.widthM;
    ys[i] = (q[n + i] / 32767) * m.heightM;
    hs[i] = data._minimumHeight + (q[2 * n + i] / 32767) * range;
  }
  return { xs, ys, hs, n, range };
}

function remember(key, promise) {
  bands.set(key, promise);
  if (bands.size > BAND_CACHE_MAX) bands.delete(bands.keys().next().value);
}

// The border strip of tile x/y as delivered, fetched if it is not known yet.
function neighbourBand(provider, original, x, y, level, margin) {
  const key = `${level}/${x}/${y}`;
  let pending = bands.get(key);
  if (!pending) {
    const scheme = provider.tilingScheme;
    if (x < 0 || y < 0 || x >= scheme.getNumberOfXTilesAtLevel(level) || y >= scheme.getNumberOfYTilesAtLevel(level)) return Promise.resolve(null);
    if (typeof provider.getTileDataAvailable === 'function' && provider.getTileDataAvailable(x, y, level) === false) return Promise.resolve(null);
    pending = Promise.resolve()
      .then(() => original(x, y, level)) // no Request object: not throttled, not cancelled
      .then((data) => {
        const m = tileMetrics(provider, x, y, level);
        const a = tileArrays(data, m);
        return a ? edgeBand(a.xs, a.ys, a.hs, m.widthM, m.heightM, margin) : null;
      })
      .catch(() => { bands.delete(key); return null; }); // may work next time
    remember(key, pending);
  }
  return Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), NEIGHBOUR_WAIT_MS))]);
}

// ---------- Cesium wiring ----------
// Wraps the provider's requestTileGeometry. It relies on the private fields of
// QuantizedMeshTerrainData as they are in CesiumJS 1.121 (the version index.html pins);
// if a field is missing the tile is passed through untouched.
export function smoothTerrain(Cesium, provider, settings = SMOOTHING) {
  const original = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, request) => {
    const pending = original(x, y, level, request);
    // Only the globe passes a Request object. Cesium's sampleTerrain calls with three
    // arguments; route analysis and click elevations keep the heights as delivered.
    if (!pending || !settings[level] || !request) return pending;
    return pending.then((data) => smoothTile(Cesium, provider, original, data, x, y, level, settings[level]).catch(() => {}).then(() => data));
  };
}

const AROUND = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

async function smoothTile(Cesium, provider, original, data, tx, ty, level, { sigma, maxShift }) {
  const q = data._quantizedVertices;
  const enc = data._encodedNormals;
  if (!q || !enc || data._sbdSmoothed) return;
  const m = tileMetrics(provider, tx, ty, level);
  const { rect, lat, widthM, heightM } = m;
  const own = tileArrays(data, m);
  if (!own || !(own.range > 0)) return;
  const { xs, ys, hs, n, range } = own;
  if (enc.length !== n * 2) return;
  const margin = 3 * sigma;
  const key = `${level}/${tx}/${ty}`;
  if (!bands.has(key)) remember(key, Promise.resolve(edgeBand(xs, ys, hs, widthM, heightM, margin))); // before the heights are changed

  // Tile y counts from north to south in Cesium's tiling schemes.
  const around = await Promise.all(AROUND.map(async ([ox, oy]) => {
    const band = await neighbourBand(provider, original, tx + ox, ty + oy, level, margin);
    if (!band) return { sx: ox, sy: -oy, band: null };
    const r = provider.tilingScheme.tileXYToRectangle(tx + ox, ty + oy, level);
    return { sx: ox, sy: -oy, band, offX: (r.west - rect.west) * EARTH * Math.cos(lat), offY: (r.south - rect.south) * EARTH };
  }));
  const all = withNeighbours(xs, ys, hs, widthM, heightM, margin, around.filter((a) => a.band));
  const missing = around.filter((a) => !a.band);
  const fit = await fitInWorker(all.x, all.y, all.z, all.width, all.height, sigma);
  if (data._quantizedVertices !== q || data._sbdSmoothed) return; // Cesium has moved on with this tile

  // Normals: the fitted plane's. Where a neighbour is missing the fit is one-sided there,
  // so towards that border the normal blends into the delivered one, which agrees with
  // whatever is drawn on the other side.
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromRadians((rect.west + rect.east) / 2, lat, 0));
  const E = Cesium.Matrix4.getColumn(frame, 0, new Cesium.Cartesian4());
  const N = Cesium.Matrix4.getColumn(frame, 1, new Cesium.Cartesian4());
  const U = Cesium.Matrix4.getColumn(frame, 2, new Cesium.Cartesian4());
  const world = new Cesium.Cartesian3();
  const delivered = new Cesium.Cartesian3();
  const oct = new Cesium.Cartesian2();
  for (let i = 0; i < n; i++) {
    if (!fit.ok[i]) continue; // keeps the delivered normal
    const e = -fit.gx[i]; const nn = -fit.gy[i];
    const l = Math.hypot(e, nn, 1);
    world.x = (E.x * e + N.x * nn + U.x) / l;
    world.y = (E.y * e + N.y * nn + U.y) / l;
    world.z = (E.z * e + N.z * nn + U.z) / l;
    let d = 1; // 0 on a border without neighbour, 1 from 2 sigma inward
    for (const { sx, sy } of missing) {
      const dx = sx < 0 ? xs[i] : widthM - xs[i];
      const dy = sy < 0 ? ys[i] : heightM - ys[i];
      const dist = sx && sy ? Math.max(dx, dy) : (sx ? dx : dy);
      d = Math.min(d, dist / (2 * sigma));
    }
    if (d < 1) {
      const k = d <= 0 ? 0 : d * d * (3 - 2 * d);
      Cesium.AttributeCompression.octDecode(enc[i * 2], enc[i * 2 + 1], delivered);
      world.x = delivered.x + (world.x - delivered.x) * k;
      world.y = delivered.y + (world.y - delivered.y) * k;
      world.z = delivered.z + (world.z - delivered.z) * k;
      Cesium.Cartesian3.normalize(world, world);
    }
    Cesium.AttributeCompression.octEncode(world, oct);
    enc[i * 2] = oct.x;
    enc[i * 2 + 1] = oct.y;
  }

  // Heights: towards the fitted plane, but never further than maxShift. Border vertices
  // stay exactly where they are: the neighbouring tile, often of a coarser level, has to meet them.
  const border = new Uint8Array(n);
  for (const edge of [data._westIndices, data._southIndices, data._eastIndices, data._northIndices]) {
    for (const i of edge || []) border[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (border[i] || !fit.ok[i]) continue;
    const shift = Math.max(-maxShift, Math.min(maxShift, fit.z[i] - hs[i]));
    q[2 * n + i] = Math.max(0, Math.min(32767, Math.round(((hs[i] + shift - data._minimumHeight) / range) * 32767)));
  }
  data._sbdSmoothed = true;
}
