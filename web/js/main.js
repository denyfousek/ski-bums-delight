// Ski Bum's Delight — wiring of viewer, layers and panels.
import {
  AREA, HOME_VIEW, TERRAIN_URL, BASEMAPS, OVERLAYS, IDENTIFY_LAYERS, IDENTIFY_URL,
  ANALYSIS_SIZE_M, wmtsUrl, SWISSIMAGE_YEARS,
} from './config.js';
import { fetchBulletin, addBulletinLayer, bulletinAt, renderBulletin, criticalRules, PROBLEMS } from './bulletin.js';
import { loadDem, computeSlopeAspect, renderOverlay, sampleGrid } from './slope.js';
import { fetchImis, fetchMeteoSwissSnow, addStationEntities, compass } from './stations.js';
import { fetchWind, renderWind } from './weather.js';
import { searchScenes, loadScene } from './sentinel.js';
import { sunPosition, sunTimes } from './sun.js';
import {
  SHADE_CORE_M, SHADE_MARGIN_M, SHADE_CELL_M, gridAzimuth, computeShade, buildPixelMap, renderShade, shadeAt, CAST, AWAY, NIGHT,
} from './shade.js';
import { parseGpx, resample, terrainSlopes, stats, wildlifeZonesOnRoute, drawProfile } from './gpx.js';

const $ = (id) => document.getElementById(id);
const state = { bulletin: null, bulletinDs: null, slopeLayer: null, slopeGrid: null, s2Layer: null, gpx: null, stationsDs: null };

function text(el, s) { el.textContent = s; }

// ---------- viewer ----------
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL, { requestVertexNormals: true });
const viewer = new Cesium.Viewer('globe', {
  baseLayer: false,
  terrainProvider,
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false,
});
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.maximumScreenSpaceError = 1.5;
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#e9e4d6');
viewer.creditDisplay.addStaticCredit(new Cesium.Credit('© swisstopo', true));
text($('area-name'), `Test area: ${AREA.name}`);

function flyHome(duration = 0) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(HOME_VIEW.lon, HOME_VIEW.lat, HOME_VIEW.height),
    orientation: { heading: Cesium.Math.toRadians(HOME_VIEW.heading), pitch: Cesium.Math.toRadians(HOME_VIEW.pitch), roll: 0 },
    duration,
  });
}
flyHome();

function wmtsProvider(def, time) {
  return new Cesium.UrlTemplateImageryProvider({
    url: wmtsUrl(def.layer, def.ext, time),
    maximumLevel: def.maxLevel,
    rectangle: Cesium.Rectangle.fromDegrees(5.9, 45.8, 10.5, 47.85), // Switzerland; tiles outside return 400
    credit: new Cesium.Credit(def.layer.startsWith('ch.bafu') ? 'BAFU' : '© swisstopo'),
  });
}

// ---------- base maps ----------
let baseLayer = null;
let basemapId = 'winter';
function setBasemap(id) {
  basemapId = id;
  let def = BASEMAPS.find((b) => b.id === id);
  let time;
  const year = $('image-year').value;
  if (id === 'image' && year !== 'current') {
    def = { ...def, layer: 'ch.swisstopo.swissimage-product' };
    time = year;
  }
  const layer = new Cesium.ImageryLayer(wmtsProvider(def, time));
  if (baseLayer) viewer.imageryLayers.remove(baseLayer, true);
  viewer.imageryLayers.add(layer, 0);
  baseLayer = layer;
  for (const b of $('basemaps').children) b.classList.toggle('on', b.dataset.id === id);
  $('image-year-row').hidden = id !== 'image';
}
$('image-year').append(new Option('Latest (10 cm)', 'current'));
for (const y of SWISSIMAGE_YEARS) $('image-year').append(new Option(y, y));
$('image-year').onchange = () => setBasemap('image');
for (const b of BASEMAPS) {
  const btn = document.createElement('button');
  btn.textContent = b.label;
  btn.dataset.id = b.id;
  btn.onclick = () => setBasemap(b.id);
  $('basemaps').append(btn);
}
setBasemap('winter');

// ---------- overlays ----------
const overlayLayers = {};
for (const o of OVERLAYS) {
  const layer = viewer.imageryLayers.addImageryProvider(wmtsProvider(o));
  layer.alpha = o.alpha;
  layer.show = o.on;
  overlayLayers[o.id] = layer;
  const label = document.createElement('label');
  label.className = 'row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = o.on;
  cb.onchange = () => { layer.show = cb.checked; };
  label.append(cb, document.createTextNode(` ${o.label}`));
  $('overlays').append(label);
}

// ---------- terrain shading (sun) ----------
// Two modes: "time" puts the real sun for a date and time (Cesium SunLight, so cast shadows
// match the sky); "manual" sets azimuth/elevation freely for relief reading.
let sunMode = 'time';
viewer.clock.shouldAnimate = false;
viewer.shadowMap.maximumDistance = 20000;
viewer.shadowMap.softShadows = true;
viewer.shadowMap.darkness = 0.45;

function sunPlace() {
  const c = viewCenter();
  return c || [(AREA.west + AREA.east) / 2, (AREA.south + AREA.north) / 2];
}

function selectedDate() {
  const [y, m, d] = $('sun-date').value.split('-').map(Number);
  const mins = Number($('sun-time').value);
  return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60);
}

function setDateInputs(date) {
  const pad = (n) => String(n).padStart(2, '0');
  $('sun-date').value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  $('sun-time').value = String(Math.round((date.getHours() * 60 + date.getMinutes()) / 5) * 5);
}

function directionalFromSliders(lon, lat) {
  const az = Cesium.Math.toRadians(Number($('sun-az').value));
  const el = Cesium.Math.toRadians(Number($('sun-el').value));
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, 2000));
  const E = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4());
  const N = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4());
  const U = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian4());
  const a = Math.cos(el) * Math.sin(az);
  const b = Math.cos(el) * Math.cos(az);
  const u = Math.sin(el);
  const toSun = new Cesium.Cartesian3(a * E.x + b * N.x + u * U.x, a * E.y + b * N.y + u * U.y, a * E.z + b * N.z + u * U.z);
  return Cesium.Cartesian3.negate(Cesium.Cartesian3.normalize(toSun, toSun), new Cesium.Cartesian3());
}

function updateSun() {
  const [lon, lat] = sunPlace();
  const lightOn = $('light-toggle').checked;
  const timeMode = sunMode === 'time';
  $('sun-time-controls').hidden = !timeMode;
  $('sun-az').disabled = timeMode;
  $('sun-el').disabled = timeMode;

  if (timeMode) {
    const date = selectedDate();
    const pos = sunPosition(date, lon, lat);
    $('sun-az').value = String(Math.round(pos.azimuth));
    $('sun-el').value = String(Math.round(pos.elevation));
    text($('time-out'), date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    const { rise, set } = sunTimes(date, lon, lat);
    const hm = (d) => (d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–');
    text($('sun-info'), `${pos.elevation < 0 ? 'Sun below the horizon. ' : ''}Sunrise ${hm(rise)} · sunset ${hm(set)} (flat horizon, local time). Mountains shade earlier and longer.`);
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(date);
    viewer.scene.light = new Cesium.SunLight({ intensity: 2.2 });
  } else {
    viewer.scene.light = new Cesium.DirectionalLight({ direction: directionalFromSliders(lon, lat), intensity: 2.2 });
  }
  text($('az-out'), `${$('sun-az').value}° ${compass(Number($('sun-az').value))}`);
  text($('el-out'), `${$('sun-el').value}°`);
  viewer.scene.globe.enableLighting = lightOn;
  viewer.scene.globe.dynamicAtmosphereLighting = false;
  const shadows = lightOn && $('sun-shadows').checked && Number($('sun-el').value) > 0;
  viewer.shadows = shadows;
  viewer.terrainShadows = shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
  scheduleShade();
}

// ---------- sun & shade map ----------
const shadeState = { grid: null, map: null, layer: null, busy: false, again: false, last: null };

function shadeSun() {
  const g = shadeState.grid;
  if (sunMode === 'time') {
    const pos = sunPosition(selectedDate(), g.lon, g.lat);
    return { az: gridAzimuth(pos.azimuth, g.lon, g.lat), el: pos.elevation, trueAz: pos.azimuth };
  }
  const az = Number($('sun-az').value);
  return { az: gridAzimuth(az, g.lon, g.lat), el: Number($('sun-el').value), trueAz: az };
}

async function paintShade() {
  if (!shadeState.grid) return;
  if (shadeState.busy) { shadeState.again = true; return; }
  shadeState.busy = true;
  try {
    do {
      shadeState.again = false;
      const s = shadeSun();
      const shade = computeShade(shadeState.grid, s.az, s.el);
      shadeState.last = shade;
      const out = renderShade(shadeState.map, shade);
      const m = shadeState.map;
      const provider = await Cesium.SingleTileImageryProvider.fromUrl(out.canvas.toDataURL('image/png'), {
        rectangle: Cesium.Rectangle.fromDegrees(m.west, m.south, m.east, m.north),
      });
      if (!shadeState.grid) break; // cleared meanwhile
      const layer = viewer.imageryLayers.addImageryProvider(provider);
      if (shadeState.layer) viewer.imageryLayers.remove(shadeState.layer, true);
      shadeState.layer = layer;
      text($('shade-status'), s.el > 0
        ? `Sun ${Math.round(s.trueAz)}° ${compass(s.trueAz)}, ${s.el.toFixed(1)}° high · ${Math.round(out.sunlit * 100)} % of the square in sun. Dark = shade.`
        : 'Sun below the horizon: everything in shade.');
    } while (shadeState.again);
  } finally {
    shadeState.busy = false;
  }
}

let shadeFrame = 0;
function scheduleShade() {
  if (!shadeState.grid || shadeFrame) return;
  shadeFrame = requestAnimationFrame(() => { shadeFrame = 0; paintShade(); });
}

$('shade-run').onclick = async () => {
  const c = viewCenter();
  if (!c) { text($('shade-status'), 'Point the view at the terrain first.'); return; }
  $('shade-run').disabled = true;
  try {
    text($('shade-status'), 'Searching elevation tiles…');
    const t0 = performance.now();
    const grid = await loadDem(c[0], c[1], SHADE_CORE_M + 2 * SHADE_MARGIN_M,
      (d, n) => text($('shade-status'), `Loading elevation tiles ${d}/${n}…`), SHADE_CELL_M, 16);
    shadeState.grid = { ...grid, lon: c[0], lat: c[1] };
    shadeState.map = buildPixelMap(grid, c[0], c[1]);
    shadeState.loadMs = performance.now() - t0;
    await paintShade();
  } catch (err) {
    text($('shade-status'), `Shade map failed: ${err.message}`);
  } finally {
    $('shade-run').disabled = false;
  }
};
$('shade-clear').onclick = () => {
  if (shadeState.layer) viewer.imageryLayers.remove(shadeState.layer, true);
  Object.assign(shadeState, { grid: null, map: null, layer: null, last: null });
  text($('shade-status'), '');
};

for (const b of $('sun-mode').children) {
  b.onclick = () => {
    sunMode = b.dataset.mode;
    for (const x of $('sun-mode').children) x.classList.toggle('on', x === b);
    updateSun();
  };
}
$('sun-now').onclick = () => {
  setDateInputs(new Date());
  if (sunMode !== 'time') $('sun-mode').querySelector('[data-mode=time]').click();
  else updateSun();
};
['sun-az', 'sun-el', 'light-toggle', 'sun-date', 'sun-time', 'sun-shadows'].forEach((id) => $(id).addEventListener('input', updateSun));
setDateInputs(new Date());
updateSun();
// Moving the camera far changes the place the sun is computed for; refresh after each move.
viewer.camera.moveEnd.addEventListener(() => updateSun());

// ---------- bulletin ----------
const areaLon = (AREA.west + AREA.east) / 2;
const areaLat = (AREA.south + AREA.north) / 2;
async function initBulletin() {
  try {
    state.bulletin = await fetchBulletin();
    renderBulletin($('bulletin'), (bulletinAt(state.bulletin, areaLon, areaLat) || {}).properties || null);
    state.bulletinDs = await addBulletinLayer(viewer, state.bulletin);
    state.bulletinDs.show = $('bulletin-toggle').checked;
  } catch (err) {
    text($('bulletin'), `Bulletin could not be loaded: ${err.message}`);
  }
}
$('bulletin-toggle').onchange = () => { if (state.bulletinDs) state.bulletinDs.show = $('bulletin-toggle').checked; };

// ---------- stations ----------
async function initStations() {
  const [imis, ms] = await Promise.allSettled([fetchImis(AREA), fetchMeteoSwissSnow(AREA)]);
  const list = [...(imis.status === 'fulfilled' ? imis.value : []), ...(ms.status === 'fulfilled' ? ms.value : [])]
    .sort((a, b) => b.elevation - a.elevation);
  const el = $('stations');
  el.replaceChildren();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'station';
    const b = document.createElement('b');
    b.textContent = `${s.name} (${Math.round(s.elevation)} m)`;
    const parts = [];
    if (s.snowCm !== null) {
      let t = `snow ${Math.round(s.snowCm)} cm`;
      if (s.snowChange24h !== null && s.snowChange24h !== undefined && Math.abs(s.snowChange24h) >= 1) {
        t += ` (${s.snowChange24h > 0 ? '+' : ''}${Math.round(s.snowChange24h)} in 24 h)`;
      }
      parts.push(t);
    }
    if (s.windKmh !== null && s.windKmh !== undefined) parts.push(`wind ${Math.round(s.windKmh)} km/h ${compass(s.windDir)}, gusts ${Math.round(s.gustKmh)}`);
    if (s.airC !== null && s.airC !== undefined) parts.push(`${s.airC.toFixed(1)} °C`);
    const when = s.time ? new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    row.append(b, document.createElement('br'), document.createTextNode(`${parts.join(' · ') || 'no current values'} — ${s.source} ${when}`));
    el.append(row);
  }
  if (imis.status === 'rejected') {
    const warn = document.createElement('div');
    warn.className = 'zone';
    warn.textContent = `SLF stations unavailable: ${imis.reason.message}`;
    el.prepend(warn);
  }
  if (!list.length && imis.status === 'fulfilled') text(el, 'No stations in this area.');
  state.stationsDs = addStationEntities(viewer, list);
  state.stationsDs.show = $('stations-toggle').checked;
}
$('stations-toggle').onchange = () => { if (state.stationsDs) state.stationsDs.show = $('stations-toggle').checked; };

// ---------- slope analysis ----------
let slopeMode = 'critical';
for (const b of $('slope-mode').children) {
  b.onclick = () => {
    slopeMode = b.dataset.mode;
    for (const x of $('slope-mode').children) x.classList.toggle('on', x === b);
    if (state.slopeGrid) paintSlope();
  };
}

function viewCenter() {
  const canvas = viewer.scene.canvas;
  const mid = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = viewer.camera.getPickRay(mid);
  // Terrain pick needs loaded tiles; fall back to the ellipsoid (a few hundred metres off in the Alps).
  const pos = viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(mid);
  if (!pos) return null;
  const c = Cesium.Cartographic.fromCartesian(pos);
  return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
}

function legend(items) {
  const el = $('slope-legend');
  el.replaceChildren();
  for (const [color, label] of items) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = color;
    s.append(i, document.createTextNode(label));
    el.append(s);
  }
}

async function paintSlope() {
  const g = state.slopeGrid;
  const cLon = (g.west + g.east) / 2;
  const cLat = (g.south + g.north) / 2;
  const b = state.bulletin ? bulletinAt(state.bulletin, cLon, cLat) : null;
  const rules = b ? criticalRules(b.properties) : [];
  if (slopeMode === 'critical' && !b) {
    text($('slope-status'), 'No bulletin for this point — showing slope classes instead.');
  }
  const mode = slopeMode === 'critical' && b ? 'critical' : 'classes';
  const out = renderOverlay(g, mode, rules);
  if (state.slopeLayer) viewer.imageryLayers.remove(state.slopeLayer, true);
  const provider = await Cesium.SingleTileImageryProvider.fromUrl(out.canvas.toDataURL('image/png'), {
    rectangle: Cesium.Rectangle.fromDegrees(out.west, out.south, out.east, out.north),
  });
  state.slopeLayer = viewer.imageryLayers.addImageryProvider(provider);
  if (mode === 'critical') {
    legend([['rgba(200,16,46,.75)', 'critical ≥ 30°'], ['rgba(90,90,90,.35)', '≥ 30°, not named in bulletin']]);
    const names = rules.map((r) => PROBLEMS[r.type] || r.type).join(', ') || 'no aspect-specific problem';
    const share = out.steep ? Math.round((out.critical / out.steep) * 100) : 0;
    text($('slope-status'), `Rules from bulletin: ${names}. ${share} % of the slopes ≥ 30° in this square match.`);
  } else {
    legend([['#f5d400', '30–35°'], ['#f08a00', '35–40°'], ['#d7191c', '40–45°'], ['#8e2bb0', '≥ 45°']]);
  }
}

$('slope-run').onclick = async () => {
  const c = viewCenter();
  if (!c) { text($('slope-status'), 'Point the view at the terrain first.'); return; }
  $('slope-run').disabled = true;
  try {
    text($('slope-status'), 'Searching elevation tiles…');
    const grid = await loadDem(c[0], c[1], ANALYSIS_SIZE_M, (d, n) => text($('slope-status'), `Loading elevation tiles ${d}/${n}…`), undefined, 16);
    text($('slope-status'), 'Computing slope and aspect…');
    await new Promise((r) => setTimeout(r, 20));
    const g = computeSlopeAspect(grid);
    const e1 = g.e0 + g.cols * g.cell;
    const nB = g.nTop - g.rows * g.cell;
    const { lv95ToWgs } = await import('./proj.js');
    const sw = lv95ToWgs(g.e0, nB);
    const ne = lv95ToWgs(e1, g.nTop);
    state.slopeGrid = { ...g, west: sw[0], south: sw[1], east: ne[0], north: ne[1] };
    await paintSlope();
  } catch (err) {
    text($('slope-status'), `Analysis failed: ${err.message}`);
  } finally {
    $('slope-run').disabled = false;
  }
};
$('slope-clear').onclick = () => {
  if (state.slopeLayer) viewer.imageryLayers.remove(state.slopeLayer, true);
  state.slopeLayer = null;
  state.slopeGrid = null;
  $('slope-legend').replaceChildren();
  text($('slope-status'), '');
};

// ---------- Sentinel-2 ----------
let scenes = [];
async function initSentinel() {
  try {
    scenes = await searchScenes(AREA);
    const sel = $('s2-scenes');
    sel.replaceChildren();
    if (!scenes.length) {
      sel.append(new Option('No scenes in the last 3 weeks'));
      return;
    }
    // Earth Search may list the same acquisition twice (processing versions); keep the newest per date.
    const seen = new Set();
    scenes = scenes.filter((s) => { const k = s.date.slice(0, 10); if (seen.has(k)) return false; seen.add(k); return true; });
    scenes.forEach((s, i) => {
      const d = new Date(s.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      sel.append(new Option(`${d} · ${Math.round(s.cloud)} % cloud (whole tile)`, String(i)));
    });
    const clearest = scenes.reduce((best, s, i) => (s.cloud < scenes[best].cloud ? i : best), 0);
    sel.value = String(clearest);
  } catch (err) {
    text($('s2-status'), `Scene search failed: ${err.message}`);
  }
}
$('s2-load').onclick = async () => {
  const s = scenes[Number($('s2-scenes').value)];
  if (!s) return;
  $('s2-load').disabled = true;
  text($('s2-status'), 'Loading 10 m true colour for the area…');
  try {
    const out = await loadScene(s, AREA, { maskClouds: $('s2-mask').checked });
    if (state.s2Layer) viewer.imageryLayers.remove(state.s2Layer, true);
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(out.canvas.toDataURL('image/jpeg', 0.9), {
      rectangle: Cesium.Rectangle.fromDegrees(out.west, out.south, out.east, out.north),
      credit: new Cesium.Credit('Contains modified Copernicus Sentinel data'),
    });
    state.s2Layer = viewer.imageryLayers.addImageryProvider(provider, 1);
    state.s2Layer.alpha = Number($('s2-alpha').value) / 100;
    const maskNote = out.maskApplied
      ? `${Math.round(out.masked * 100)} % hidden as cloud or cloud shadow (the classifier can mistake snow for cloud).`
      : 'Clouds look like snow — compare with the national map.';
    text($('s2-status'), `Showing ${new Date(s.date).toLocaleDateString('en-GB')}. ${maskNote}`);
  } catch (err) {
    text($('s2-status'), `Could not load scene: ${err.message}`);
  } finally {
    $('s2-load').disabled = false;
  }
};
$('s2-alpha').oninput = () => { if (state.s2Layer) state.s2Layer.alpha = Number($('s2-alpha').value) / 100; };

// ---------- GPX ----------
async function loadGpxText(textContent) {
  const out = $('gpx-stats');
  out.replaceChildren();
  $('gpx-zones').replaceChildren();
  try {
    const gpx = parseGpx(textContent);
    text(out, 'Analysing route…');
    let pts = resample(gpx.points, 20);
    if (pts.length > 3000) pts = resample(gpx.points, Math.ceil(pts[pts.length - 1].dist / 3000));
    pts = await terrainSlopes(terrainProvider, pts);
    pts = pts.map((p) => ({ ...p, z: p.ele != null ? p.ele : p.terrainEle }));
    if (state.slopeGrid) {
      pts = pts.map((p) => { const c = sampleGrid(state.slopeGrid, p.lon, p.lat); return c && Number.isFinite(c.slope) ? { ...p, slope: c.slope } : p; });
    }
    const st = stats(pts);
    if (state.gpx) viewer.entities.remove(state.gpx);
    state.gpx = viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(pts.flatMap((p) => [p.lon, p.lat])),
        width: 4,
        material: new Cesium.PolylineOutlineMaterialProperty({ color: Cesium.Color.fromCssColorString('#c8102e'), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5 }),
        clampToGround: true,
      },
    });
    viewer.flyTo(state.gpx, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), 0) });

    const dl = document.createElement('dl');
    dl.className = 'kv';
    const add = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
    add('Route', gpx.name);
    add('Distance', `${(st.distance / 1000).toFixed(1)} km`);
    add('Ascent / descent', `${Math.round(st.up)} m / ${Math.round(st.down)} m`);
    add('Lowest / highest', `${Math.round(st.minZ)} m / ${Math.round(st.maxZ)} m`);
    add('Terrain ≥ 30°', `${Math.round(st.steepShare * 100)} % of the route (max ${Math.round(st.maxSlope)}°)`);
    add('Slope source', state.slopeGrid ? 'swissALTI3D where analysed, else 3D terrain' : 'swisstopo 3D terrain (±15 m)');
    out.replaceChildren(dl);

    $('gpx-profile').hidden = false;
    drawProfile($('gpx-profile'), pts);

    const zones = await wildlifeZonesOnRoute(pts);
    const zEl = $('gpx-zones');
    if (!zones.length) text(zEl, 'No wildlife rest zone or protection area on this route.');
    for (const z of zones) {
      const d = document.createElement('div');
      d.className = 'zone';
      d.textContent = `⚠ ${z.name}: km ${z.fromKm.toFixed(1)}–${z.toKm.toFixed(1)} · ${z.rule} · ${z.period} · ${z.binding}`;
      zEl.append(d);
    }
  } catch (err) {
    text(out, `GPX failed: ${err.message}`);
  }
}
const drop = $('gpx-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadGpxText(await f.text());
});
$('gpx-file').onchange = async () => { const f = $('gpx-file').files[0]; if (f) loadGpxText(await f.text()); };

// ---------- click: bulletin region, identify, wind ----------
async function identifyAt(lon, lat) {
  const d = 0.0012;
  const box = [lon - d, lat - d, lon + d, lat + d].join(',');
  const q = new URLSearchParams({
    geometryType: 'esriGeometryEnvelope', geometry: box, sr: '4326', imageDisplay: '1000,1000,96',
    mapExtent: box, tolerance: '0', returnGeometry: 'false', geometryFormat: 'geojson', lang: 'en',
    layers: `all:${IDENTIFY_LAYERS.join(',')}`,
  });
  const res = await fetch(`${IDENTIFY_URL}?${q}`);
  if (!res.ok) throw new Error(`Identify HTTP ${res.status}`);
  const seen = new Set();
  return ((await res.json()).results || []).filter((f) => {
    const k = `${f.layerBodId}:${f.featureId ?? f.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function describe(f) {
  const p = f.properties || {};
  switch (f.layerBodId) {
    case 'ch.swisstopo-karto.skitouren':
    case 'ch.swisstopo-karto.schneeschuhrouten':
    {
      const kind = f.layerBodId.includes('skitouren') ? 'Ski tour' : 'Snowshoe';
      const bits = [`Difficulty ${p.difficulty_de || p.difficulty_en || '?'}`];
      if (p.ascent_time_label) bits.push(`ascent ${p.ascent_time_label}`);
      if (p.ascent_altitude) bits.push(`↑ ${p.ascent_altitude} m`);
      if (p.descent_altitude) bits.push(`↓ ${p.descent_altitude} m`);
      return [`${kind}: ${p.target_name || ''} – ${p.name_en || p.name || p.name_de || ''}`, bits.join(' · '), p.url_sac_de || null];
    }
    case 'ch.bafu.wrz-wildruhezonen_portal':
    case 'ch.bafu.wrz-jagdbanngebiete_select':
      return [`Protected: ${p.wrz_name || p.label || ''}`, `${p.best_de || ''} · ${p.schutzzeit || ''} · ${p.schutzs_de || ''}`, null];
    case 'ch.bav.seilbahnen-bundeskonzession':
      return [`Cableway: ${p.anlagename || p.label || ''}`, `Installation ${p.anlagenr || ''}`, null];
    default:
      return [p.label || f.layerBodId, '', null];
  }
}

const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction(async (ev) => {
  const ray = viewer.camera.getPickRay(ev.position);
  const pos = viewer.scene.globe.pick(ray, viewer.scene) || viewer.camera.pickEllipsoid(ev.position);
  if (!pos) return;
  const c = Cesium.Cartographic.fromCartesian(pos);
  const lon = Cesium.Math.toDegrees(c.longitude);
  const lat = Cesium.Math.toDegrees(c.latitude);
  const info = $('info');
  info.replaceChildren();
  const head = document.createElement('div');
  let h = viewer.scene.globe.getHeight(c);
  if (!h) {
    try { [h] = (await Cesium.sampleTerrainMostDetailed(terrainProvider, [Cesium.Cartographic.fromRadians(c.longitude, c.latitude)])).map((x) => x.height); } catch { h = null; }
  }
  let headText = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${h ? Math.round(h) : '?'} m`;
  if (state.slopeGrid) {
    const s = sampleGrid(state.slopeGrid, lon, lat);
    if (s && Number.isFinite(s.slope)) headText += ` · ${Math.round(s.slope)}° ${compass(s.aspect)}`;
  }
  if (shadeState.last) {
    const v = shadeAt(shadeState.grid, shadeState.last, lon, lat);
    const label = { [CAST]: 'in terrain shadow', [AWAY]: 'faces away from the sun', [NIGHT]: 'sun down' }[v];
    if (v !== null) headText += ` · ${label || 'in sun'}`;
  }
  head.textContent = headText;
  info.append(head);

  if (state.bulletin) {
    const b = bulletinAt(state.bulletin, lon, lat);
    if (b) renderBulletin($('bulletin'), b.properties);
  }

  $('wind').textContent = 'Loading forecast…';
  fetchWind(lon, lat).then((d) => renderWind($('wind'), d)).catch((err) => { $('wind').textContent = `Forecast failed: ${err.message}`; });

  try {
    const results = await identifyAt(lon, lat);
    for (const f of results) {
      const [t, sub, url] = describe(f);
      const d = document.createElement('div');
      d.className = 'feature';
      const b = document.createElement('b');
      b.textContent = t;
      d.append(b);
      if (sub) d.append(document.createElement('br'), document.createTextNode(sub));
      if (url && /^https:\/\//.test(url)) {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' SAC route page';
        d.append(document.createElement('br'), a);
      }
      info.append(d);
    }
    if (!results.length) info.append(document.createTextNode('No route, zone or lift right here.'));
  } catch (err) {
    info.append(document.createTextNode(`Lookup failed: ${err.message}`));
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------- start ----------
initBulletin();
initStations();
initSentinel();
window.skiApp = { viewer, state }; // for debugging in the console
