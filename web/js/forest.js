// Closed-forest mask from the swissTLM3D land cover in the geo.admin base vector tiles.
// Only subclass "forest" counts; "loose_forest", "scrub" (e.g. green alder) and
// "woody_plant" give no protection here. The subclass-to-TLM mapping (forest = Wald,
// loose_forest = Wald offen ...) is inferred from the data, not documented.
// Works anywhere in Switzerland: z14 tiles, Web Mercator, rasterised onto the LV95 grid.
import { FOREST_TILES_URL, GEOLIB } from './config.js';
import { lv95ToWgs, wgsToLv95 } from './proj.js';

const Z = 14; // lower zooms drop small polygons

function lonToX(lon) { return ((lon + 180) / 360) * 2 ** Z; }
function latToY(lat) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z;
}
function xToLon(x) { return (x / 2 ** Z) * 360 - 180; }
function yToLat(y) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** Z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

let libs = null;
async function loadLibs() {
  if (!libs) {
    const [vt, pbf] = await Promise.all([import(GEOLIB.vectorTile), import(GEOLIB.pbf)]);
    libs = { VectorTile: vt.VectorTile, Pbf: pbf.default };
  }
  return libs;
}

// Returns Uint8Array (1 = closed forest) on the grid g ({cols, rows, e0, nTop, cell}).
export async function loadForestMask(g, onProgress) {
  const { VectorTile, Pbf } = await loadLibs();
  const e1 = g.e0 + g.cols * g.cell;
  const nB = g.nTop - g.rows * g.cell;
  const corners = [lv95ToWgs(g.e0, g.nTop), lv95ToWgs(e1, g.nTop), lv95ToWgs(g.e0, nB), lv95ToWgs(e1, nB)];
  const x0 = Math.floor(lonToX(Math.min(...corners.map((c) => c[0]))));
  const x1 = Math.floor(lonToX(Math.max(...corners.map((c) => c[0]))));
  const y0 = Math.floor(latToY(Math.max(...corners.map((c) => c[1]))));
  const y1 = Math.floor(latToY(Math.min(...corners.map((c) => c[1]))));

  const canvas = document.createElement('canvas');
  canvas.width = g.cols;
  canvas.height = g.rows;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';

  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  let done = 0;
  let i = 0;
  const worker = async () => {
    while (i < tiles.length) {
      const [x, y] = tiles[i++];
      const url = FOREST_TILES_URL.replace('{s}', String((x + y) % 5)).replace('{z}', Z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url);
      if (res.ok) {
        const tile = new VectorTile(new Pbf(await res.arrayBuffer()));
        const layer = tile.layers.landcover;
        for (let f = 0; layer && f < layer.length; f++) {
          const feat = layer.feature(f);
          if (feat.type !== 3 || feat.properties.class !== 'wood' || feat.properties.subclass !== 'forest') continue;
          const ext = layer.extent;
          ctx.beginPath();
          for (const ring of feat.loadGeometry()) {
            ring.forEach((p, k) => {
              const [E, N] = wgsToLv95(xToLon(x + p.x / ext), yToLat(y + p.y / ext));
              const cx = (E - g.e0) / g.cell;
              const cy = (g.nTop - N) / g.cell;
              if (k === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            });
            ctx.closePath();
          }
          ctx.fill('evenodd'); // holes (clearings) stay open
        }
      } else if (res.status !== 404 && res.status !== 204) {
        throw new Error(`Forest tiles HTTP ${res.status}`);
      }
      done++;
      if (onProgress) onProgress(done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tiles.length) }, worker));

  const alpha = ctx.getImageData(0, 0, g.cols, g.rows).data;
  const mask = new Uint8Array(g.cols * g.rows);
  for (let k = 0; k < mask.length; k++) mask[k] = alpha[k * 4 + 3] >= 128 ? 1 : 0;
  return mask;
}
