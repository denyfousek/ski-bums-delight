// Current snow line for an area, estimated from snow depth against elevation.
// Inputs: Open-Meteo snow_depth (model MeteoSwiss ICON, ~1–2 km grid, so valleys and summits
// are smoothed) on a grid of points, plus measured station depths, which count four times.
// The result is an estimate with a date, not a measurement; the panel lets the user override it.
import { OPEN_METEO_URL } from './config.js';

export const SNOW_THRESHOLD_M = 0.05; // "snow-covered" from 5 cm

// n x n points spread over the box (cell centres).
export function samplePoints(box, n = 5) {
  const pts = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pts.push({
        lon: box.west + ((i + 0.5) / n) * (box.east - box.west),
        lat: box.south + ((j + 0.5) / n) * (box.north - box.south),
      });
    }
  }
  return pts;
}

// Model snow depth at the sample points. Returns [{ lon, lat, elevation, depthM, time }].
// Open-Meteo reports the terrain elevation of each point (90 m DEM); the depth itself comes
// from the model cell, whose own height can differ by a few hundred metres in steep terrain.
export async function fetchModelSnow(box, n = 5) {
  const pts = samplePoints(box, n);
  const q = new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(4)).join(','),
    longitude: pts.map((p) => p.lon.toFixed(4)).join(','),
    current: 'snow_depth',
    models: 'meteoswiss_icon_seamless',
    timezone: 'UTC',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${q}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return list.map((d, i) => ({
    lon: pts[i].lon,
    lat: pts[i].lat,
    elevation: d.elevation,
    depthM: d.current ? d.current.snow_depth : null,
    time: d.current ? `${d.current.time}Z` : null,
  })).filter((s) => Number.isFinite(s.elevation) && Number.isFinite(s.depthM));
}

// Station list (see stations.js) -> samples. Stations without a snow depth are dropped.
export function stationSamples(stations) {
  return stations
    .filter((s) => s.snowCm !== null && s.snowCm !== undefined && Number.isFinite(s.elevation))
    .map((s) => ({ lon: s.lon, lat: s.lat, elevation: s.elevation, depthM: s.snowCm / 100, time: s.time, weight: 4, station: s.name }));
}

// Elevation that best separates snow-covered from bare samples.
// Samples: [{ elevation, depthM, weight? }]. Returns
//   { line, method, n, covered, minElev, maxElev, misfit, gradient (cm per 100 m) | null }
// method: 'split'     the elevation with the fewest samples on the wrong side: bare ones
//                     above it, covered ones below it (weighted). Where a whole range of
//                     elevations is equally good, the middle of that range is taken.
//         'all-snow'  every sample is covered: the line is at or below the lowest sample
//         'no-snow'   no sample is covered: the line is above the highest sample
//         'none'      no usable samples
// A straight regression of depth against elevation was tried first and dropped: with the
// model's smooth depths it has almost no slope and puts the line hundreds of metres too low.
// The gradient is still reported, as information only.
export function fitSnowline(samples, threshold = SNOW_THRESHOLD_M) {
  const s = samples
    .filter((x) => Number.isFinite(x.elevation) && Number.isFinite(x.depthM))
    .map((x) => ({ elevation: x.elevation, snowy: x.depthM >= threshold, depthM: x.depthM, weight: x.weight || 1 }))
    .sort((a, b) => a.elevation - b.elevation);
  if (!s.length) return { line: null, method: 'none', n: 0, covered: 0, minElev: null, maxElev: null, misfit: 0, gradient: null };
  const minElev = s[0].elevation;
  const maxElev = s[s.length - 1].elevation;
  const covered = s.filter((x) => x.snowy).length;
  const base = { n: s.length, covered, minElev, maxElev, misfit: 0, gradient: depthGradient(s.filter((x) => x.snowy)) };
  if (!covered) return { ...base, line: Math.round(maxElev), method: 'no-snow' };
  if (covered === s.length) return { ...base, line: Math.round(minElev), method: 'all-snow' };

  // Cut k puts samples 0..k-1 below the line and k.. above it. Cost: covered below + bare above.
  const total = s.reduce((n, x) => n + x.weight, 0);
  // A bare sample high up counts half: summit stations are often blown clear, while snow
  // on a low sample is hard to explain away.
  const BARE = 0.5;
  let cost = s.reduce((n, x) => n + (x.snowy ? 0 : x.weight * BARE), 0); // k = 0: everything above
  let best = cost;
  let bestFrom = 0;
  let bestTo = 0;
  let lastCut = 0; // the last position where a cut was possible
  for (let k = 1; k <= s.length; k++) {
    const x = s[k - 1];
    cost += x.snowy ? x.weight : -x.weight * BARE;
    if (k < s.length && s[k].elevation === x.elevation) continue; // no line fits between two equal heights
    // Equally good cuts only count as one range while they are neighbours; otherwise the
    // middle of two separate optima could be a worse cut than either. The lowest range wins.
    if (cost < best - 1e-9) { best = cost; bestFrom = k; bestTo = k; lastCut = k; } else if (Math.abs(cost - best) <= 1e-9 && bestTo === lastCut) bestTo = k;
    lastCut = k;
  }
  const edge = (k) => (k === 0 ? minElev : k === s.length ? maxElev : (s[k - 1].elevation + s[k].elevation) / 2);
  const line = (edge(bestFrom) + edge(bestTo)) / 2;
  return { ...base, line: Math.round(line), method: 'split', misfit: best / total };
}

// Weighted least-squares slope of depth against elevation, in cm per 100 m. Null when
// there are too few points or they all sit at one height.
function depthGradient(snowy) {
  if (snowy.length < 3) return null;
  let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const x of snowy) {
    const w = x.weight;
    sw += w; sx += w * x.elevation; sy += w * x.depthM; sxx += w * x.elevation ** 2; sxy += w * x.elevation * x.depthM;
  }
  const den = sw * sxx - sx * sx;
  return den > 1e-6 ? ((sw * sxy - sx * sy) / den) * 1e4 : null;
}

// Snow line from a classified satellite scene: share of "snow" among clear pixels per
// 100 m elevation band; the line is the lowest band from which the share stays >= 50 %.
// Points: [{ elevation, cls }] with cls 'snow' | 'ground' (clouds etc. left out).
export function snowlineFromClasses(points, bandM = 100, minPerBand = 5) {
  const bands = new Map();
  for (const p of points) {
    if (!Number.isFinite(p.elevation) || (p.cls !== 'snow' && p.cls !== 'ground')) continue;
    const k = Math.floor(p.elevation / bandM);
    const b = bands.get(k) || { snow: 0, n: 0 };
    b.n++;
    if (p.cls === 'snow') b.snow++;
    bands.set(k, b);
  }
  const keys = [...bands.keys()].filter((k) => bands.get(k).n >= minPerBand).sort((a, b) => a - b);
  if (keys.length < 2) return { line: null, bands: keys.length, clear: 0 };
  // Start at the highest band that is mostly snow: one thin, wind-blown or shaded band at
  // the very top must not hide the snow below it.
  const share = (k) => bands.get(k).snow / bands.get(k).n;
  let top = keys.length - 1;
  while (top >= 0 && share(keys[top]) < 0.5) top--;
  let line = null;
  for (let i = top; i >= 0; i--) {
    const b = bands.get(keys[i]);
    if (b.snow / b.n >= 0.5) line = keys[i] * bandM; else break;
  }
  const clear = keys.reduce((n, k) => n + bands.get(k).n, 0);
  // No band reaches 50 %: the line is above the data.
  if (line === null) return { line: (keys[keys.length - 1] + 1) * bandM, bands: keys.length, clear, above: true };
  return { line, bands: keys.length, clear, below: line === keys[0] * bandM };
}

// One-line description for the panel.
export function describeFit(fit) {
  const grad = fit.gradient !== null && fit.gradient !== undefined ? ` Depth grows by about ${fit.gradient.toFixed(0)} cm per 100 m.` : '';
  switch (fit.method) {
    case 'split': {
      const off = fit.misfit > 0.005 ? ` ${Math.round(fit.misfit * 100)} % of the points contradict it.` : '';
      return `${fit.covered} of ${fit.n} points have snow; the line separates them best.${off}${grad}`;
    }
    case 'all-snow':
      return `All ${fit.n} points have snow, the lowest at ${Math.round(fit.minElev)} m: the line is at or below that.${grad}`;
    case 'no-snow':
      return `None of the ${fit.n} points has snow: the line is above ${Math.round(fit.maxElev)} m.`;
    default:
      return 'No snow data for this area.';
  }
}
