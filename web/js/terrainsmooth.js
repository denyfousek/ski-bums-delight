// Smoothing of the finest swisstopo terrain tiles.
// At level 18, the finest, the mesh has a vertex every 0.4 to 0.9 m and the heights jitter
// by a few decimetres from one vertex to the next (measured on a steep face above
// Andermatt). Under low sun this reads as terraces.
//
// Method: around every vertex a plane is fitted to the heights nearby, weighted by a
// Gaussian of the distance (moving least squares, degree 1). The vertex gets the plane's
// height (moved by 0.3 m at most), and its normal is the plane's normal. A plane fit reproduces any tilted plane
// exactly, also at a tile's border where data exist on one side only.
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

// ---------- Cesium wiring ----------
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
    return pending.then((data) => smoothTile(Cesium, provider, data, x, y, level, settings[level]).catch(() => {}).then(() => data));
  };
}

async function smoothTile(Cesium, provider, data, tx, ty, level, { sigma, maxShift }) {
  const q = data._quantizedVertices;
  const enc = data._encodedNormals;
  if (!q || !enc || data._sbdSmoothed) return;
  const n = q.length / 3;
  if (enc.length !== n * 2) return;
  const rect = provider.tilingScheme.tileXYToRectangle(tx, ty, level);
  const lat = (rect.south + rect.north) / 2;
  const widthM = (rect.east - rect.west) * 6378137 * Math.cos(lat);
  const heightM = (rect.north - rect.south) * 6378137;
  const range = data._maximumHeight - data._minimumHeight;
  if (!(range > 0)) return;

  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const hs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (q[i] / 32767) * widthM;
    ys[i] = (q[n + i] / 32767) * heightM;
    hs[i] = (q[2 * n + i] / 32767) * range;
  }
  const fit = await fitInWorker(xs, ys, hs, widthM, heightM, sigma);
  if (data._quantizedVertices !== q || data._sbdSmoothed) return; // Cesium has moved on with this tile

  // Normals: the fitted plane's, blended towards the delivered normal near the tile border.
  // The neighbouring tile fits from its own vertices only and would light the shared edge
  // differently; the delivered normals agree across it.
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
    const d = Math.min(xs[i], widthM - xs[i], ys[i], heightM - ys[i]) / (2 * sigma); // 0 on the border, 1 from 2 sigma inward
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
    q[2 * n + i] = Math.max(0, Math.min(32767, Math.round(((hs[i] + shift) / range) * 32767)));
  }
  data._sbdSmoothed = true;
}
