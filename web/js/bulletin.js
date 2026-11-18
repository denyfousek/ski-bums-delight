// SLF avalanche bulletin (CAAMLv6 as GeoJSON, CC BY 4.0, © WSL Institute for Snow and Avalanche Research SLF).
import { BULLETIN_URL, TREELINE_M } from './config.js';
import { pointInGeometry } from './proj.js';

export const LEVELS = {
  low: { n: 1, label: '1 – Low', color: '#ccff66' },
  moderate: { n: 2, label: '2 – Moderate', color: '#ffff00' },
  considerable: { n: 3, label: '3 – Considerable', color: '#ff9900' },
  high: { n: 4, label: '4 – High', color: '#ff0000' },
  very_high: { n: 5, label: '5 – Very high', color: '#7f0000' },
};

export const PROBLEMS = {
  new_snow: 'New snow',
  wind_slab: 'Wind slab',
  persistent_weak_layers: 'Persistent weak layers',
  wet_snow: 'Wet snow',
  gliding_snow: 'Gliding snow',
  favourable_situation: 'Favourable situation',
  no_distinct_avalanche_problem: 'No distinct avalanche problem',
};

export async function fetchBulletin() {
  const res = await fetch(BULLETIN_URL);
  if (!res.ok) throw new Error(`Bulletin HTTP ${res.status}`);
  return res.json();
}

export function maxLevel(props) {
  let best = null;
  for (const r of props.dangerRatings || []) {
    const l = LEVELS[r.mainValue];
    if (l && (!best || l.n > best.n)) best = l;
  }
  return best;
}

export function bulletinAt(geojson, lon, lat) {
  return (geojson.features || []).find((f) => pointInGeometry(lon, lat, f.geometry)) || null;
}

export function elevationBound(v) {
  if (v === undefined || v === null || v === '') return null;
  if (String(v).toLowerCase() === 'treeline') return TREELINE_M;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Rules a slope cell is tested against: aspects + elevation band per avalanche problem.
export function criticalRules(props) {
  return (props.avalancheProblems || [])
    .filter((p) => p.problemType !== 'favourable_situation' && (p.aspects || []).length)
    .map((p) => ({
      type: p.problemType,
      aspects: new Set(p.aspects),
      lower: elevationBound(p.elevation && p.elevation.lowerBound),
      upper: elevationBound(p.elevation && p.elevation.upperBound),
    }));
}

export function stripHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || '').replace(/<br\s*\/?>/gi, '\n'), 'text/html');
  return doc.body.textContent.trim();
}

export async function addBulletinLayer(viewer, geojson) {
  const features = geojson.features.map((f, i) => ({ ...f, properties: { _idx: i } }));
  const ds = await Cesium.GeoJsonDataSource.load({ type: 'FeatureCollection', features }, { clampToGround: true });
  for (const e of ds.entities.values) {
    if (!e.polygon) continue;
    const props = geojson.features[e.properties._idx.getValue()].properties;
    const lvl = maxLevel(props);
    e.polygon.material = Cesium.Color.fromCssColorString(lvl ? lvl.color : '#cccccc').withAlpha(0.32);
    e.polygon.outline = false;
    e.bulletin = props;
  }
  ds.show = false;
  await viewer.dataSources.add(ds);
  return ds;
}

function fmtTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function elevText(p) {
  const e = p.elevation || {};
  if (e.lowerBound && e.upperBound) return `${e.lowerBound}–${e.upperBound} m`;
  if (e.lowerBound) return `above ${e.lowerBound} m`;
  if (e.upperBound) return `below ${e.upperBound} m`;
  return 'all elevations';
}

// Renders a bulletin into a container using DOM nodes only (bulletin text is never parsed as HTML into the page).
export function renderBulletin(el, props) {
  el.replaceChildren();
  if (!props) {
    el.textContent = 'No bulletin region at this point.';
    return;
  }
  const lvl = maxLevel(props);
  const head = document.createElement('div');
  head.className = 'danger';
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = lvl ? lvl.color : '#ccc';
  head.append(swatch, document.createTextNode(lvl ? lvl.label : 'No rating'));
  const regions = document.createElement('div');
  regions.className = 'muted';
  regions.textContent = (props.regions || []).map((r) => r.name).join(', ');
  const valid = document.createElement('div');
  valid.className = 'muted';
  valid.textContent = `Valid until ${fmtTime(props.validTime && props.validTime.endTime)} · next update ${fmtTime(props.nextUpdate)}`;
  el.append(head, regions, valid);

  for (const p of props.avalancheProblems || []) {
    const box = document.createElement('div');
    box.className = 'problem';
    const t = document.createElement('strong');
    t.textContent = PROBLEMS[p.problemType] || p.problemType;
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${(p.aspects || []).join(' ') || 'all aspects'} · ${elevText(p)}`;
    const rose = aspectRose(new Set(p.aspects || []));
    const c = document.createElement('p');
    c.textContent = stripHtml(p.comment);
    box.append(t, meta, rose, c);
    el.append(box);
  }
}

// Small SVG compass rose with the critical aspects filled.
function aspectRose(active) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-22 -22 44 44');
  svg.setAttribute('class', 'rose');
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((name, i) => {
    const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180;
    const a1 = ((i * 45 + 22.5 - 90) * Math.PI) / 180;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', `M0 0 L${20 * Math.cos(a0)} ${20 * Math.sin(a0)} A20 20 0 0 1 ${20 * Math.cos(a1)} ${20 * Math.sin(a1)} Z`);
    path.setAttribute('class', active.has(name) ? 'on' : 'off');
    svg.append(path);
  });
  const n = document.createElementNS(ns, 'text');
  n.setAttribute('x', '0');
  n.setAttribute('y', '-13');
  n.textContent = 'N';
  svg.append(n);
  return svg;
}
