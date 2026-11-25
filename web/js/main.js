// Ski Bum's Delight — wiring of viewer, layers and panels.
import {
  TERRAIN_URL, BASEMAPS, OVERLAYS, IDENTIFY_LAYERS, IDENTIFY_URL,
  ANALYSIS_SIZE_M, wmtsUrl, SWISSIMAGE_YEARS,
} from './config.js';
import {
  PRESETS, SWITZERLAND, centre, boxAround, homeView, inSwitzerland, loadArea, saveArea,
} from './areas.js';
import {
  fetchBulletin, fetchHistory, addBulletinLayer, bulletinAt, renderBulletin, criticalRules, rulesLookup, maxLevel, PROBLEMS,
} from './bulletin.js';
import { fetchModelSnow, stationSamples, fitSnowline, snowlineFromClasses, describeFit } from './snowline.js';
import { createSnowMaterial, recentreSnowMaterial, updateSnowEye } from './snowlook.js';
import { applyQuality, patchShadowPass, setShadowTerminator } from './quality.js';
import { smoothTerrain } from './terrainsmooth.js';
import { loadDem, computeSlopeAspect, renderOverlay, sampleGrid } from './slope.js';
import { loadForestMask } from './forest.js';
import { fetchImis, fetchMeteoSwissSnow, addStationEntities, compass } from './stations.js';
import { fetchWind, renderWind } from './weather.js';
import { searchScenes, loadScene } from './sentinel.js';
import { sunPosition, sunTimes } from './sun.js';
import {
  SHADE_CORE_M, SHADE_MARGIN_M, SHADE_CELL_M, gridAzimuth, computeShade, buildPixelMap, renderShade, shadeAt, CAST, AWAY, NIGHT,
} from './shade.js';
import {
  parseGpx, resample, terrainSlopes, stats, routeCheck, wildlifeZonesOnRoute, drawProfile, CHECK_COLORS, GREEN, YELLOW, RED,
} from './gpx.js';

const $ = (id) => document.getElementById(id);
const state = { bulletin: null, bulletinDs: null, slopeLayer: null, slopeGrid: null, s2Layer: null, gpx: [], stationsDs: null, stations: [] };

// localStorage can throw (private window, blocked site data); settings are then just not kept.
const storage = {
  getItem(k) { try { return localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};
let area = loadArea(storage);
const MOBILE = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
// Snow view. `manual` is set once the user moves the slider; an estimate no longer moves it then.
const snow = { on: storage.getItem('sbd-snow') !== '0', material: null, manual: false, fit: null, previousBasemap: null };
const OWN_SHADOWS = patchShadowPass(Cesium); // before the viewer builds its first shader
// High quality rendering: on by default except on phones; the choice is remembered.
let highQuality = storage.getItem('sbd-hq') === null ? !MOBILE : storage.getItem('sbd-hq') === '1';
// Every area change gets a number; answers of requests started for an older area are dropped.
let areaGen = 0;

function text(el, s) { el.textContent = s; }

// ---------- viewer ----------
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(TERRAIN_URL, { requestVertexNormals: true });
// Close-up tiles are smoothed at load (see terrainsmooth.js); ?terrain=raw shows them as delivered.
if (new URLSearchParams(location.search).get('terrain') !== 'raw') smoothTerrain(Cesium, terrainProvider);
const viewer = new Cesium.Viewer('globe', {
  baseLayer: false,
  terrainProvider,
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false,
  // Render at the screen's real pixel density. The default (true) renders at CSS pixels,
  // which on a 150–200 % display halves the image and also loads coarser tiles.
  useBrowserRecommendedResolution: false,
});
const globe = viewer.scene.globe;
globe.depthTestAgainstTerrain = true;
// Detail: tiles refine until their error is below 1.5 screen pixels. Fog normally lets
// distant tiles stay coarse (factor 2); 0.25 keeps the far slopes nearly as sharp.
globe.maximumScreenSpaceError = 1.5;
viewer.scene.fog.screenSpaceErrorFactor = 0.25;
globe.tileCacheSize = 1000;
globe.preloadSiblings = true;
if (MOBILE) {
  // Phones: fewer and coarser tiles, less memory.
  globe.maximumScreenSpaceError = 2.5;
  viewer.scene.fog.screenSpaceErrorFactor = 1;
  globe.tileCacheSize = 250;
  globe.preloadSiblings = false;
}
// Cap the render resolution: a phone with a 3x screen would otherwise shade nine times
// the pixels of its CSS size. 1.5x on phones and 2x on desktops is visually enough.
function capResolution() {
  const dpr = window.devicePixelRatio || 1;
  viewer.resolutionScale = Math.min(1, (MOBILE ? 1.5 : 2) / dpr);
}
capResolution();
window.addEventListener('resize', capResolution);
// Brightness under terrain shading: Cesium multiplies the image by Lambert × 0.9 + 0.3,
// so flat ground under a 24° winter sun ended up at ~67 %. Stronger direct light and a
// brighter shadow floor keep flat ground near full brightness and slopes away from the
// sun at ~50 %, so the relief stays readable.
globe.lambertDiffuseMultiplier = 1.5;
globe.vertexShadowDarkness = 0.5;
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#e9e4d6');
viewer.creditDisplay.addStaticCredit(new Cesium.Credit('© swisstopo', true));
function flyHome(duration = 0) {
  const v = homeView(area);
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, v.height),
    orientation: { heading: Cesium.Math.toRadians(v.heading), pitch: Cesium.Math.toRadians(v.pitch), roll: 0 },
    duration,
  });
}
flyHome();

function wmtsProvider(def, time) {
  return new Cesium.UrlTemplateImageryProvider({
    url: wmtsUrl(def.layer, def.ext, time),
    maximumLevel: def.maxLevel,
    rectangle: Cesium.Rectangle.fromDegrees(SWITZERLAND.west, SWITZERLAND.south, SWITZERLAND.east, SWITZERLAND.north), // tiles outside return 400
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
  btn.onclick = () => { snow.previousBasemap = null; setBasemap(b.id); };
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
  return viewCenter() || centre(area);
}

// An emptied date field falls back to today instead of producing an invalid date.
function selectedDate() {
  const [y, m, d] = $('sun-date').value.split('-').map(Number);
  const mins = Number($('sun-time').value);
  const date = new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(mins / 60), mins % 60);
  }
  return date;
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
  if (snow.material) snow.material.uniforms.selfShade = lightOn ? 0 : 1;
  // High quality always casts terrain shadows; otherwise only on request.
  const shadows = lightOn && ($('sun-shadows').checked || highQuality) && Number($('sun-el').value) > 0;
  if (viewer.shadows !== shadows) viewer.shadows = shadows; // an unchanged value would clear the shadow map's rebuild flag
  viewer.terrainShadows = shadows ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.DISABLED;
  if (snow.material) snow.material.uniforms.shadowDark = shadows ? viewer.shadowMap.darkness : 1;
  scheduleShade();
}

// ---------- sun & shade map ----------
const shadeState = { grid: null, map: null, layer: null, busy: false, again: false, last: null, key: '' };

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
      // Camera moves call this too; the map only changes when the sun does.
      const key = `${s.az.toFixed(2)}/${s.el.toFixed(2)}`;
      if (key === shadeState.key && shadeState.layer) break;
      shadeState.key = key;
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
    shadeState.key = '';
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
  Object.assign(shadeState, { grid: null, map: null, layer: null, last: null, key: '' });
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
function showBulletinFor(lon, lat) {
  $('history-note').hidden = true;
  for (const b of $('history-row').children) b.classList.remove('on');
  renderBulletin($('bulletin'), state.bulletin ? (bulletinAt(state.bulletin, lon, lat) || {}).properties || null : null);
}
async function initBulletin() {
  try {
    state.bulletin = await fetchBulletin();
    showBulletinFor(...centre(area));
    if (lastGpxText) loadGpxText(lastGpxText); // a route analysed before the bulletin arrived had no red sections
    state.bulletinDs = await addBulletinLayer(viewer, state.bulletin);
    state.bulletinDs.show = $('bulletin-toggle').checked;
  } catch (err) {
    text($('bulletin'), `Bulletin could not be loaded: ${err.message}`);
  }
}
$('bulletin-toggle').onchange = () => { if (state.bulletinDs) state.bulletinDs.show = $('bulletin-toggle').checked; };

// History: the SLF API returns the bulletin valid at a given moment (?activeAt=).
function resetHistory() {
  $('history-row').replaceChildren();
  $('history-note').hidden = true;
  $('history-load').hidden = false;
  text($('history-status'), '');
}
$('history-load').onclick = async () => {
  const gen = areaGen;
  const [lon, lat] = centre(area);
  $('history-load').disabled = true;
  text($('history-status'), 'Loading the last 7 days…');
  try {
    const days = await fetchHistory(lon, lat);
    if (gen !== areaGen) return;
    const row = $('history-row');
    row.replaceChildren();
    for (const d of days.reverse()) {
      const lvl = d.properties ? maxLevel(d.properties) : null;
      const b = document.createElement('button');
      b.className = 'day';
      const sw = document.createElement('i');
      sw.style.background = lvl ? lvl.color : 'transparent';
      const label = d.at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
      b.append(sw, document.createTextNode(`${label} · ${lvl ? lvl.n : '–'}`));
      b.title = lvl ? lvl.label : (d.error || 'No bulletin for this day');
      b.disabled = !d.properties;
      b.onclick = () => {
        for (const x of row.children) x.classList.toggle('on', x === b);
        renderBulletin($('bulletin'), d.properties);
        const day = d.at.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        text($('history-text'), `Showing the bulletin of ${day} for the area centre. Critical slopes and the route check always use the current one.`);
        $('history-note').hidden = false;
      };
      row.append(b);
    }
    const found = days.filter((d) => d.properties).length;
    text($('history-status'), found ? 'Highest danger level per day at the area centre. Tap a day to read it.' : 'No bulletins in the last 7 days (outside the season SLF publishes none).');
    $('history-load').hidden = true;
  } catch (err) {
    text($('history-status'), `History failed: ${err.message}`);
  } finally {
    $('history-load').disabled = false;
  }
};
$('history-today').onclick = () => showBulletinFor(...centre(area));

// ---------- stations ----------
async function initStations() {
  const gen = areaGen;
  const el = $('stations');
  text(el, 'Loading…');
  const [imis, ms] = await Promise.allSettled([fetchImis(area), fetchMeteoSwissSnow(area)]);
  if (gen !== areaGen) return;
  const list = [...(imis.status === 'fulfilled' ? imis.value : []), ...(ms.status === 'fulfilled' ? ms.value : [])]
    .sort((a, b) => b.elevation - a.elevation);
  state.stations = list;
  el.replaceChildren();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'station';
    const b = document.createElement('b');
    b.textContent = `${s.name} (${Math.round(s.elevation)} m)`;
    const parts = [];
    if (s.snowCm != null) {
      let t = `snow ${Math.round(s.snowCm)} cm`;
      if (s.snowChange24h != null && Math.abs(s.snowChange24h) >= 1) {
        t += ` (${s.snowChange24h > 0 ? '+' : ''}${Math.round(s.snowChange24h)} in 24 h)`;
      }
      parts.push(t);
    }
    if (s.windKmh != null) {
      let t = `wind ${Math.round(s.windKmh)} km/h ${compass(s.windDir)}`.trim();
      if (s.gustKmh != null) t += `, gusts ${Math.round(s.gustKmh)}`;
      parts.push(t);
    }
    if (s.airC != null) parts.push(`${s.airC.toFixed(1)} °C`);
    const when = s.time ? new Date(s.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    row.append(b, document.createElement('br'), document.createTextNode(`${parts.join(' · ') || 'no current values'} — ${s.source} ${when}`));
    el.append(row);
  }
  if (imis.status === 'rejected') {
    const warn = document.createElement('div');
    // The SLF API sends no CORS header, so IMIS needs the local proxy in serve.py.
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    warn.className = local ? 'zone' : 'muted small';
    warn.textContent = local
      ? `SLF stations unavailable: ${imis.reason.message}`
      : 'SLF stations (IMIS) only in the local version; showing MeteoSwiss stations.';
    el.prepend(warn);
  }
  if (!list.length) el.append(document.createTextNode('No stations in this area.'));
  if (state.stationsDs) viewer.dataSources.remove(state.stationsDs, true);
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
$('slope-forest').onchange = () => { if (state.slopeGrid) paintSlope(); };

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

let slopePaint = 0;
async function paintSlope() {
  const g = state.slopeGrid;
  const turn = ++slopePaint;
  const cLon = (g.west + g.east) / 2;
  const cLat = (g.south + g.north) / 2;
  const b = state.bulletin ? bulletinAt(state.bulletin, cLon, cLat) : null;
  const rules = b ? criticalRules(b.properties) : [];
  const mode = slopeMode === 'critical' && b ? 'critical' : 'classes';
  const forestOn = $('slope-forest').checked && Boolean(g.forest);
  const out = renderOverlay(g, mode, rules, forestOn);
  const provider = await Cesium.SingleTileImageryProvider.fromUrl(out.canvas.toDataURL('image/png'), {
    rectangle: Cesium.Rectangle.fromDegrees(out.west, out.south, out.east, out.north),
  });
  // A newer paint or "Clear" happened while the image was decoding: drop this one.
  if (turn !== slopePaint || state.slopeGrid !== g) return;
  if (state.slopeLayer) viewer.imageryLayers.remove(state.slopeLayer, true);
  state.slopeLayer = viewer.imageryLayers.addImageryProvider(provider);
  const notes = [];
  if (g.failedTiles) notes.push(`${g.failedTiles} elevation tile(s) could not be read; those squares are empty.`);
  if (g.forestError) notes.push(`Forest data unavailable (${g.forestError}).`);
  if (mode === 'critical') {
    const items = [['rgba(200,16,46,.75)', 'critical ≥ 30°'], ['rgba(90,90,90,.35)', '≥ 30°, not named in bulletin']];
    if (forestOn) items.splice(1, 0, ['rgba(30,120,60,.6)', 'would be critical, but in closed forest']);
    legend(items);
    const names = rules.map((r) => PROBLEMS[r.type] || r.type).join(', ') || 'no problem with a location';
    const region = (b.properties.regions || []).map((r) => r.name).slice(0, 2).join(', ');
    const pct = (n) => (out.steep ? Math.round((n / out.steep) * 100) : 0);
    let msg = `Rules from the bulletin for ${region || 'the square centre'} (applied to the whole square): ${names}. ${pct(out.critical)} % of the slopes ≥ 30° match.`;
    if (forestOn) msg += ` Another ${pct(out.forested)} % match but lie in closed forest.`;
    text($('slope-status'), [msg, ...notes].join(' '));
  } else {
    legend([['#f5d400', '30–35°'], ['#f08a00', '35–40°'], ['#d7191c', '40–45°'], ['#8e2bb0', '≥ 45°']]);
    const why = slopeMode === 'critical' ? 'No bulletin for this point — showing slope classes instead.' : 'Slope classes from swissALTI3D (4 m).';
    text($('slope-status'), [why, ...notes].join(' '));
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
    try {
      g.forest = await loadForestMask(g, (d, n) => text($('slope-status'), `Loading forest ${d}/${n}…`));
    } catch (err) {
      g.forestError = err.message; // analysis still works, just without forest
    }
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
  slopePaint++;
  if (state.slopeLayer) viewer.imageryLayers.remove(state.slopeLayer, true);
  state.slopeLayer = null;
  state.slopeGrid = null;
  $('slope-legend').replaceChildren();
  text($('slope-status'), '');
};

// ---------- Sentinel-2 ----------
let scenes = [];
async function initSentinel() {
  const gen = areaGen;
  const sel = $('s2-scenes');
  sel.replaceChildren(new Option('Searching…'));
  text($('s2-status'), '');
  $('s2-snow').hidden = true;
  if (state.s2Layer) { viewer.imageryLayers.remove(state.s2Layer, true); state.s2Layer = null; }
  try {
    let found = await searchScenes(area);
    if (gen !== areaGen) return;
    sel.replaceChildren();
    if (!found.length) {
      scenes = [];
      sel.append(new Option('No scenes in the last 3 weeks'));
      return;
    }
    // Earth Search may list the same acquisition twice (processing versions); keep the newest per date.
    const seen = new Set();
    found = found.filter((s) => { const k = s.date.slice(0, 10); if (seen.has(k)) return false; seen.add(k); return true; });
    scenes = found;
    scenes.forEach((s, i) => {
      const d = new Date(s.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      sel.append(new Option(`${d} · ${Math.round(s.cloud)} % cloud (whole tile)`, String(i)));
    });
    const clearest = scenes.reduce((best, s, i) => (s.cloud < scenes[best].cloud ? i : best), 0);
    sel.value = String(clearest);
  } catch (err) {
    if (gen === areaGen) text($('s2-status'), `Scene search failed: ${err.message}`);
  }
}

// Snow line seen by the satellite: classify a grid of points (snow / snow-free ground) and
// look at the share of snow per 100 m elevation band.
async function sceneSnowline(out) {
  const n = 26;
  const pts = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const lon = out.west + ((i + 0.5) / n) * (out.east - out.west);
      const lat = out.south + ((j + 0.5) / n) * (out.north - out.south);
      const cls = out.classAt(lon, lat);
      if (cls) pts.push({ lon, lat, cls });
    }
  }
  if (pts.length < 30) return { line: null, clear: pts.length };
  const carto = pts.map((q) => Cesium.Cartographic.fromDegrees(q.lon, q.lat));
  await Cesium.sampleTerrain(terrainProvider, 11, carto);
  return snowlineFromClasses(pts.map((q, i) => ({ elevation: carto[i].height, cls: q.cls })));
}

$('s2-load').onclick = async () => {
  const s = scenes[Number($('s2-scenes').value)];
  if (!s) return;
  const gen = areaGen;
  $('s2-load').disabled = true;
  $('s2-snow').hidden = true;
  text($('s2-status'), 'Loading 10 m true colour for the area…');
  try {
    const out = await loadScene(s, area, { maskClouds: $('s2-mask').checked, classes: true });
    if (gen !== areaGen) return;
    if (state.s2Layer) viewer.imageryLayers.remove(state.s2Layer, true);
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(out.canvas.toDataURL('image/jpeg', 0.9), {
      rectangle: Cesium.Rectangle.fromDegrees(out.west, out.south, out.east, out.north),
      credit: new Cesium.Credit('Contains modified Copernicus Sentinel data'),
    });
    if (gen !== areaGen) return;
    state.s2Layer = viewer.imageryLayers.addImageryProvider(provider, 1);
    state.s2Layer.alpha = Number($('s2-alpha').value) / 100;
    const day = new Date(s.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const maskNote = out.maskApplied
      ? `${Math.round(out.masked * 100)} % hidden as cloud or cloud shadow (the classifier can mistake snow for cloud).`
      : 'Clouds look like snow — compare with the national map.';
    let msg = `Showing ${day}. ${maskNote}`;
    if (snow.on) msg += ' The snow view covers it above the snow line; lower the opacity there or switch it off to see the image.';
    text($('s2-status'), msg);
    if (out.classAt) {
      try {
        const sl = await sceneSnowline(out);
        if (gen !== areaGen) return;
        if (sl.line !== null) {
          const where = sl.above ? 'above' : (sl.below ? 'at or below' : 'around');
          text($('s2-snow-text'), `Snow line in this scene (${day}): ${where} ${sl.line} m, from ${sl.clear} cloud-free points.`);
          $('s2-snow-use').onclick = () => setSnowline(sl.above ? NO_SNOW_LINE : sl.line, true, `Sentinel-2 scene of ${day}`);
          $('s2-snow').hidden = false;
        }
      } catch { /* the image is shown either way */ }
    }
  } catch (err) {
    text($('s2-status'), `Could not load scene: ${err.message}`);
  } finally {
    $('s2-load').disabled = false;
  }
};
$('s2-alpha').oninput = () => { if (state.s2Layer) state.s2Layer.alpha = Number($('s2-alpha').value) / 100; };

// ---------- GPX ----------
let gpxTurn = 0;
let lastGpxText = null;
function clearGpx() {
  for (const e of state.gpx) viewer.entities.remove(e);
  state.gpx = [];
}
async function loadGpxText(textContent) {
  const turn = ++gpxTurn;
  lastGpxText = textContent;
  const out = $('gpx-stats');
  out.replaceChildren();
  $('gpx-zones').replaceChildren();
  $('gpx-check').replaceChildren();
  try {
    const gpx = parseGpx(textContent);
    text(out, 'Analysing route…');
    let pts = resample(gpx.points, 20);
    if (pts.length > 3000) pts = resample(gpx.points, Math.ceil(pts[pts.length - 1].dist / 3000));
    pts = await terrainSlopes(terrainProvider, pts);
    if (turn !== gpxTurn) return; // a newer file was dropped meanwhile
    pts = pts.map((p) => ({ ...p, z: p.ele != null ? p.ele : p.terrainEle }));
    if (state.slopeGrid) {
      pts = pts.map((p) => {
        const c = sampleGrid(state.slopeGrid, p.lon, p.lat);
        return c && Number.isFinite(c.slope) ? { ...p, slope: c.slope, aspect: c.aspect } : p;
      });
    }
    const st = stats(pts);
    const check = routeCheck(pts, state.bulletin ? rulesLookup(state.bulletin) : null);

    clearGpx();
    for (const sec of check.sections) {
      const part = check.points.slice(Math.max(0, sec.from - 1), sec.to + 1);
      if (part.length < 2) continue;
      state.gpx.push(viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(part.flatMap((p) => [p.lon, p.lat])),
          width: 5,
          material: new Cesium.PolylineOutlineMaterialProperty({ color: Cesium.Color.fromCssColorString(CHECK_COLORS[sec.check]), outlineColor: Cesium.Color.WHITE, outlineWidth: 1.5 }),
          clampToGround: true,
        },
      }));
    }
    viewer.flyTo(state.gpx, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-40), 0) });

    const m = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '?');
    const dl = document.createElement('dl');
    dl.className = 'kv';
    const add = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
    add('Route', gpx.name);
    add('Distance', `${(st.distance / 1000).toFixed(1)} km`);
    add('Ascent / descent', `${m(st.up)} m / ${m(st.down)} m (changes under 5 m ignored)`);
    add('Lowest / highest', `${m(st.minZ)} m / ${m(st.maxZ)} m`);
    add('Terrain ≥ 30°', `${Math.round(st.steepShare * 100)} % of the route (max ${m(st.maxSlope)}°)`);
    add('Slope source', state.slopeGrid ? 'swissALTI3D where analysed, else 3D terrain' : 'swisstopo 3D terrain (±15 m)');
    out.replaceChildren(dl);

    $('gpx-profile').hidden = false;
    drawProfile($('gpx-profile'), check.points, check.sections);
    renderRouteCheck(check);

    let zones;
    try {
      zones = await wildlifeZonesOnRoute(pts);
    } catch (err) {
      if (turn === gpxTurn) text($('gpx-zones'), `Wildlife zones could not be checked: ${err.message}`);
      return;
    }
    if (turn !== gpxTurn) return;
    const zEl = $('gpx-zones');
    if (!zones.length) text(zEl, 'No wildlife rest zone or protection area on this route.');
    for (const z of zones) {
      const d = document.createElement('div');
      d.className = 'zone';
      d.textContent = `⚠ ${z.name}: km ${z.fromKm.toFixed(1)}–${z.toKm.toFixed(1)} · ${z.rule} · ${z.period} · ${z.binding}`;
      zEl.append(d);
    }
  } catch (err) {
    if (turn === gpxTurn) text(out, `GPX failed: ${err.message}`);
  }
}

function renderRouteCheck(check) {
  const el = $('gpx-check');
  el.replaceChildren();
  const pct = (v) => `${Math.round(v * 100)} %`;
  const head = document.createElement('div');
  head.className = 'lights';
  for (const [key, label] of [[GREEN, 'below 30°'], [YELLOW, '30° or steeper'], [RED, 'steep and named in the bulletin']]) {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.background = CHECK_COLORS[key];
    s.append(i, document.createTextNode(`${pct(check.share[key])} ${label}`));
    head.append(s);
  }
  el.append(head);
  if (!state.bulletin) {
    const n = document.createElement('div');
    n.className = 'muted';
    n.textContent = 'No bulletin loaded: steep sections cannot be compared with it, so none is red.';
    el.append(n);
  }
  const rows = check.sections.filter((s) => s.check === RED || s.check === YELLOW);
  const shown = rows.slice(0, 14);
  for (const s of shown) {
    const d = document.createElement('div');
    d.className = 'section';
    const i = document.createElement('i');
    i.style.background = CHECK_COLORS[s.check];
    const lo = Math.round(s.minZ);
    const hi = Math.round(s.maxZ);
    const elev = Number.isFinite(s.minZ) ? ` · ${lo === hi ? lo : `${lo}–${hi}`} m` : '';
    const len = (s.toKm - s.fromKm) * 1000;
    const where = len < 100 ? `km ${s.fromKm.toFixed(1)} (${Math.max(20, Math.round(len / 10) * 10)} m)` : `km ${s.fromKm.toFixed(1)}–${s.toKm.toFixed(1)}`;
    d.append(i, document.createTextNode(`${where} · up to ${Math.round(s.maxSlope)}° ${s.aspect}${elev}`));
    el.append(d);
  }
  if (rows.length > shown.length) el.append(document.createTextNode(`… and ${rows.length - shown.length} more steep sections.`));
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Checked is the ground under the track only. Slopes above or below it, where an avalanche can start or run out, are not part of this check.';
  el.append(note);
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

let clickTurn = 0;
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clickHandler.setInputAction(async (ev) => {
  const turn = ++clickTurn;
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
    if (turn !== clickTurn) return;
  }
  let headText = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${h ? Math.round(h) : '?'} m`;
  if (state.slopeGrid) {
    const s = sampleGrid(state.slopeGrid, lon, lat);
    if (s && Number.isFinite(s.slope)) headText += ` · ${Math.round(s.slope)}° ${compass(s.aspect)}${s.forest ? ' · closed forest' : ''}`;
  }
  if (shadeState.last) {
    const v = shadeAt(shadeState.grid, shadeState.last, lon, lat);
    const label = { [CAST]: 'in terrain shadow', [AWAY]: 'faces away from the sun', [NIGHT]: 'sun down' }[v];
    if (v !== null) headText += ` · ${label || 'in sun'}`;
  }
  head.textContent = headText;
  info.append(head);

  if (state.bulletin && bulletinAt(state.bulletin, lon, lat)) showBulletinFor(lon, lat);

  $('wind').textContent = 'Loading forecast…';
  fetchWind(lon, lat)
    .then((d) => { if (turn === clickTurn) renderWind($('wind'), d); })
    .catch((err) => { if (turn === clickTurn) $('wind').textContent = `Forecast failed: ${err.message}`; });

  try {
    const results = await identifyAt(lon, lat);
    if (turn !== clickTurn) return;
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
    if (turn === clickTurn) info.append(document.createTextNode(`Lookup failed: ${err.message}`));
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ---------- snow view ----------
// A globe material paints the snow cover on the GPU (see snowlook.js). The snow line comes
// from an estimate (see snowline.js) until the user moves the slider.
const NO_SNOW_LINE = 3600; // slider maximum: nothing in Switzerland's touring terrain is painted
function applySnow() {
  text($('snow-out'), `${$('snow-line').value} m`); // C8: the read-out is never empty
  if (snow.on && !snow.material) {
    snow.material = createSnowMaterial(Cesium, ...centre(area), { snowline: Number($('snow-line').value) });
  }
  globe.material = snow.on ? snow.material : undefined;
  // Cesium shades the whole globe with clamp(lambert * multiplier + floor). The high-quality
  // snow lights itself and divides that factor out again, which only works while the
  // factor stays near 1 (colours above 1 are cut off on the way). So with high-quality
  // snow the built-in shading is made gentle; the map below the snow line keeps a light relief.
  const ownLight = highQuality && snow.on;
  globe.lambertDiffuseMultiplier = ownLight ? 0.6 : 1.5;
  globe.vertexShadowDarkness = ownLight ? 0.75 : 0.5;
  if (snow.material) {
    snow.material.uniforms.quality = highQuality ? 1 : 0;
    snow.material.uniforms.ownShadows = OWN_SHADOWS ? 1 : 0;
    snow.material.uniforms.shadowDark = viewer.terrainShadows === Cesium.ShadowMode.ENABLED ? viewer.shadowMap.darkness : 1;
    snow.material.uniforms.lambertMul = globe.lambertDiffuseMultiplier;
    snow.material.uniforms.lambertFloor = globe.vertexShadowDarkness;
    snow.material.uniforms.selfShade = $('light-toggle').checked ? 0 : 1;
    snow.material.uniforms.contours = $('snow-contours').checked ? 1 : 0;
    snow.material.uniforms.strength = Number($('snow-strength').value) / 100;
  }
  setShadowTerminator(viewer, OWN_SHADOWS && highQuality && snow.on);
  $('snow-controls').hidden = !snow.on;
}

function setSnowline(metres, manual, source) {
  const v = Math.min(3600, Math.max(600, Math.round(metres / 25) * 25));
  $('snow-line').value = String(v);
  text($('snow-out'), `${v} m`);
  if (snow.material) snow.material.uniforms.snowline = v;
  if (manual) {
    snow.manual = true;
    text($('snow-status'), source ? `Set from the ${source}.` : 'Set by hand. “Estimate” goes back to the data.');
  }
}

async function estimateSnowline() {
  const gen = areaGen;
  text($('snow-status'), 'Estimating the snow line…');
  try {
    const model = await fetchModelSnow(area);
    if (gen !== areaGen) return;
    const stationPts = stationSamples(state.stations);
    const fit = fitSnowline([...model, ...stationPts]);
    snow.fit = fit;
    if (fit.line === null) { text($('snow-status'), 'No snow data for this area; set the line by hand.'); return; }
    // No point has snow: the line is somewhere above the data. Draw no snow at all
    // rather than snow from the highest sample upward.
    const none = fit.method === 'no-snow';
    if (!snow.manual) setSnowline(none ? NO_SNOW_LINE : fit.line, false);
    const t = model.find((s) => s.time);
    const when = t ? new Date(t.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'time unknown';
    const src = `${model.length} model points (MeteoSwiss ICON via Open-Meteo)${stationPts.length ? ` and ${stationPts.length} stations` : ''}`;
    const kept = snow.manual ? ` Your setting of ${$('snow-line').value} m is kept.` : '';
    const head = none
      ? `No snow at any of the ${fit.n} points (highest ${Math.round(fit.maxElev)} m), ${when}: no snow line in the data, so the view draws none.`
      : `Estimate ${fit.line} m, ${when}. ${describeFit(fit)}`;
    text($('snow-status'), `${head} Source: ${src}. An estimate, not a measurement.${kept}`);
  } catch (err) {
    if (gen === areaGen) text($('snow-status'), `Snow line estimate failed (${err.message}); set it by hand.`);
  }
}

$('snow-toggle').checked = snow.on;
$('snow-toggle').onchange = () => {
  snow.on = $('snow-toggle').checked;
  storage.setItem('sbd-snow', snow.on ? '1' : '0');
  // The snow view is made for the aerial image: rock and forest show through it.
  if (snow.on && basemapId !== 'image') { snow.previousBasemap = basemapId; setBasemap('image'); }
  else if (!snow.on) {
    // Go back only if the aerial image the snow view switched to is still showing;
    // a base map the user picked in between stays.
    if (snow.previousBasemap && basemapId === 'image') setBasemap(snow.previousBasemap);
    snow.previousBasemap = null;
  }
  applySnow();
};
$('snow-line').oninput = () => setSnowline(Number($('snow-line').value), true);
$('snow-auto').onclick = () => { snow.manual = false; estimateSnowline(); };
$('snow-contours').onchange = applySnow;

// ---------- rendering quality ----------
function setQuality(on) {
  highQuality = on;
  storage.setItem('sbd-hq', on ? '1' : '0');
  $('hq-toggle').checked = on;
  $('sun-shadows').disabled = on;
  applyQuality(Cesium, viewer, on, MOBILE);
  updateSun();
  applySnow(); // last: it may ask the shadow map for a rebuild
}
$('hq-toggle').onchange = () => setQuality($('hq-toggle').checked);
// The snow shader works in coordinates relative to the camera; hand it the camera's
// position (relative to the area centre) before every frame.
viewer.scene.preRender.addEventListener(() => { if (snow.material) updateSnowEye(Cesium, snow.material, viewer.camera); });
$('snow-strength').oninput = applySnow;

// ---------- areas ----------
function fillAreaSelect() {
  const sel = $('area-select');
  sel.replaceChildren();
  for (const p of PRESETS) sel.append(new Option(p.name, p.id));
  if (area.id === 'custom') sel.append(new Option(area.name, 'custom'));
  sel.value = area.id;
}

// Loads everything that belongs to an area. The bulletin covers all of Switzerland and is
// fetched once; only the region shown changes.
async function loadAreaData() {
  const gen = areaGen;
  resetHistory();
  if (state.bulletin) showBulletinFor(...centre(area));
  initSentinel();
  await initStations();
  if (gen !== areaGen) return; // the area changed meanwhile; the newer load does the estimate
  await estimateSnowline();
}

function setArea(next, fly = true) {
  area = next;
  areaGen++;
  state.stations = []; // the old area's stations must not enter the new area's estimate
  saveArea(storage, area);
  fillAreaSelect();
  snow.manual = false;
  if (snow.material) recentreSnowMaterial(Cesium, snow.material, ...centre(area));
  if (fly) flyHome(1.5);
  text($('area-status'), '');
  loadAreaData();
}

$('area-select').onchange = () => {
  const p = PRESETS.find((x) => x.id === $('area-select').value);
  if (p) setArea(p);
};
$('area-view').onclick = () => {
  const c = viewCenter();
  if (!c || !inSwitzerland(c[0], c[1])) { text($('area-status'), 'Point the view at terrain in Switzerland first.'); return; }
  setArea(boxAround(c[0], c[1]), false);
  text($('area-status'), 'Stations, satellite scenes and the snow line now refer to the 19 × 14 km around the view centre.');
};
$('area-locate').onclick = () => {
  if (!navigator.geolocation) { text($('area-status'), 'This browser gives no position.'); return; }
  text($('area-status'), 'Asking for your position…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { longitude, latitude } = pos.coords;
    if (!inSwitzerland(longitude, latitude)) { text($('area-status'), 'Your position is outside Switzerland; the map data ends at the border.'); return; }
    setArea(boxAround(longitude, latitude, 'Around my position'));
  }, (err) => text($('area-status'), `Position not available: ${err.message}`), { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
};

// ---------- start ----------
fillAreaSelect();
setQuality(highQuality);
if (snow.on) { snow.previousBasemap = 'winter'; setBasemap('image'); }
applySnow();
initBulletin();
loadAreaData();
window.skiApp = { viewer, state }; // for debugging in the console
