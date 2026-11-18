// Recent Sentinel-2 L2A scenes (Copernicus, free and open) via the keyless Earth Search STAC API.
// The true-colour COG (TCI, 10 m, UTM) is read for the area only and resampled to WGS84.
import { EARTH_SEARCH_URL, GEOLIB } from './config.js';
import { wgsToUtm } from './proj.js';

export async function searchScenes(box, days = 21) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400e3);
  const body = {
    collections: ['sentinel-2-l2a'],
    bbox: [box.west, box.south, box.east, box.north],
    datetime: `${start.toISOString()}/${end.toISOString()}`,
    limit: 40,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };
  const res = await fetch(EARTH_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Earth Search HTTP ${res.status}`);
  const fc = await res.json();
  return (fc.features || [])
    .filter((f) => f.assets && f.assets.visual)
    .map((f) => ({
      id: f.id,
      date: f.properties.datetime,
      cloud: f.properties['eo:cloud_cover'],
      epsg: f.properties['proj:epsg'] || Number(String(f.properties['proj:code'] || '').split(':')[1]),
      href: f.assets.visual.href,
    }));
}

// Returns { canvas, west, south, east, north } for the box, or throws.
export async function loadScene(scene, box, maxPx = 2400) {
  const epsg = scene.epsg;
  if (!(epsg >= 32601 && epsg <= 32660)) throw new Error(`Unsupported projection EPSG:${epsg}`);
  const zone = epsg - 32600;
  const corners = [[box.west, box.south], [box.east, box.south], [box.west, box.north], [box.east, box.north]]
    .map(([lon, lat]) => wgsToUtm(lon, lat, zone));
  const bx0 = Math.min(...corners.map((c) => c[0]));
  const bx1 = Math.max(...corners.map((c) => c[0]));
  const by0 = Math.min(...corners.map((c) => c[1]));
  const by1 = Math.max(...corners.map((c) => c[1]));
  const nativeW = Math.round((bx1 - bx0) / 10);
  const nativeH = Math.round((by1 - by0) / 10);
  const s = Math.min(1, maxPx / Math.max(nativeW, nativeH));
  const w = Math.round(nativeW * s);
  const h = Math.round(nativeH * s);

  const { fromUrl } = await import(GEOLIB.geotiff);
  const tiff = await fromUrl(scene.href);
  const rgb = await tiff.readRasters({ bbox: [bx0, by0, bx1, by1], width: w, height: h, interleave: true });

  const W = w;
  const H = Math.round(w * (box.north - box.south) / (box.east - box.west) / Math.cos(((box.north + box.south) / 2) * Math.PI / 180));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let j = 0; j < H; j++) {
    const lat = box.north - ((j + 0.5) / H) * (box.north - box.south);
    for (let i = 0; i < W; i++) {
      const lon = box.west + ((i + 0.5) / W) * (box.east - box.west);
      const [x, y] = wgsToUtm(lon, lat, zone);
      const c = Math.floor(((x - bx0) / (bx1 - bx0)) * w);
      const r = Math.floor(((by1 - y) / (by1 - by0)) * h);
      if (c < 0 || r < 0 || c >= w || r >= h) continue;
      const k = (r * w + c) * 3;
      const o = (j * W + i) * 4;
      if (rgb[k] === 0 && rgb[k + 1] === 0 && rgb[k + 2] === 0) continue; // no data
      px[o] = rgb[k]; px[o + 1] = rgb[k + 1]; px[o + 2] = rgb[k + 2]; px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, ...box };
}
