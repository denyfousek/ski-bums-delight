// New snow per day for one point: 7 days back, today, 4 days ahead, from Open-Meteo with the
// MeteoSwiss ICON-CH1/CH2 model (seamless). Free tier is non-commercial only; data CC BY 4.0.
//
// The row is model precipitation × 0.7 (cm per mm), the factor Open-Meteo itself uses for
// snowfall. It is the snow that falls where it is cold enough. snowfall_sum is not used: it
// applies to the elevation of the model cell (often far below the touring terrain) and is
// smaller there on mixed days. One model cell is 1–2 km, not a slope.
import { OPEN_METEO_URL } from './config.js';

export const SNOW_CM_PER_MM = 0.7;
export const PAST_DAYS = 7;
export const AHEAD_DAYS = 4;
const SUM_DAYS = 3;

// Today's date in Switzerland as YYYY-MM-DD (the forecast is asked for in that time zone).
export function zurichToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Sum of a list; a missing day makes the sum missing too, never a smaller number.
export function sumOrNull(values) {
  if (!values.length || values.some((v) => !isNum(v))) return null;
  return values.reduce((a, b) => a + b, 0);
}

// Turns the Open-Meteo answer into the 12 table columns. Days the answer lacks, and days
// Open-Meteo reports as null (not yet fully forecast), stay null.
export function newSnowDays(data, today) {
  const daily = data && data.daily ? data.daily : {};
  const dIndex = new Map((daily.time || []).map((t, i) => [t, i]));
  const fz = new Map();
  const h = data && data.hourly ? data.hourly : {};
  (h.time || []).forEach((t, i) => {
    const v = (h.freezing_level_height || [])[i];
    if (!isNum(v)) return;
    const day = t.slice(0, 10);
    const cur = fz.get(day) || { min: Infinity, max: -Infinity };
    fz.set(day, { min: Math.min(cur.min, v), max: Math.max(cur.max, v) });
  });
  const days = [];
  for (let k = -PAST_DAYS; k <= AHEAD_DAYS; k++) {
    const date = addDays(today, k);
    const i = dIndex.get(date);
    const precip = i === undefined ? null : (daily.precipitation_sum || [])[i];
    const gust = i === undefined ? null : (daily.wind_gusts_10m_max || [])[i];
    const f = fz.get(date);
    days.push({
      date,
      kind: k < 0 ? 'past' : k === 0 ? 'today' : 'future',
      snowCm: isNum(precip) ? precip * SNOW_CM_PER_MM : null,
      fzMin: f ? f.min : null,
      fzMax: f ? f.max : null,
      gust: isNum(gust) ? gust : null,
    });
  }
  const past = days.filter((d) => d.kind === 'past').slice(-SUM_DAYS).map((d) => d.snowCm);
  const next = days.filter((d) => d.kind === 'future').slice(0, SUM_DAYS).map((d) => d.snowCm);
  return {
    days,
    last3: sumOrNull(past),
    next3: sumOrNull(next),
    cellElevation: data && isNum(data.elevation) ? data.elevation : null,
  };
}

export async function fetchNewSnow(lon, lat) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: 'precipitation_sum,wind_gusts_10m_max',
    hourly: 'freezing_level_height',
    models: 'meteoswiss_icon_seamless',
    cell_selection: 'nearest',
    timezone: 'Europe/Zurich',
    past_days: String(PAST_DAYS),
    forecast_days: String(AHEAD_DAYS + 2),
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${q}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

// Centimetres: a dash for missing values, one decimal below 10 cm.
export function fmtCm(v) {
  if (!isNum(v)) return '–';
  if (v === 0) return '0';
  return v < 10 ? v.toFixed(1) : `${Math.round(v)}`;
}

const r50 = (v) => Math.round(v / 50) * 50;

function link(href, label) {
  const a = document.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
  return a;
}

// The source line Open-Meteo and MeteoSwiss ask for, placed directly at the data.
export function sourceLine() {
  const p = document.createElement('div');
  p.className = 'muted small';
  p.append(
    link('https://open-meteo.com/', 'Weather data by Open-Meteo.com'), ' · Source: ',
    link('https://www.meteoswiss.admin.ch/', 'MeteoSwiss'), ' · ',
    link('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0'), ', aggregated by this app',
  );
  return p;
}

export function renderNewSnow(el, result, where) {
  el.replaceChildren();
  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = `${where}${result.cellElevation !== null ? ` · model cell ${Math.round(result.cellElevation)} m` : ''}`;

  const wrap = document.createElement('div');
  wrap.className = 'scroll-x';
  const table = document.createElement('table');
  table.className = 'wx newsnow';
  const head = table.insertRow();
  const corner = document.createElement('th');
  head.append(corner);
  for (const d of result.days) {
    const th = document.createElement('th');
    const t = new Date(`${d.date}T12:00:00Z`);
    th.textContent = t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
    if (d.kind === 'today') {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = 'partly forecast';
      th.append(sub);
    }
    th.className = d.kind;
    head.append(th);
  }
  const rows = [
    ['New snow cm', (d) => fmtCm(d.snowCm)],
    ['0° line m\nmax / min', (d) => (d.fzMin === null ? '–' : `${r50(d.fzMax)}\n${r50(d.fzMin)}`)],
    ['Gust km/h', (d) => (d.gust === null ? '–' : `${Math.round(d.gust)}`)],
  ];
  for (const [label, cell] of rows) {
    const row = table.insertRow();
    const th = document.createElement('th');
    th.textContent = label;
    row.append(th);
    for (const d of result.days) {
      const td = row.insertCell();
      td.textContent = cell(d);
      td.className = d.kind;
      if (label.startsWith('Gust') && d.gust !== null && d.gust >= 50) td.classList.add('warn');
    }
  }
  wrap.append(table);

  const sums = document.createElement('div');
  sums.className = 'small';
  sums.textContent = `Last 3 days ${fmtCm(result.last3)} cm · next 3 days ${fmtCm(result.next3)} cm (both without today). Gust: 10 m gust of the model cell.`;

  const notes = document.createElement('div');
  notes.className = 'muted small';
  const n1 = document.createElement('div');
  n1.textContent = 'New snow where it is cold enough, from model precipitation × 0.7. One model cell (1–2 km), not the slope; below the 0° line it falls as rain.';
  const n2 = document.createElement('div');
  n2.append('Not snow depth and not avalanche information. See the ', link('https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/', 'SLF bulletin'), '.');
  notes.append(n1, n2);

  el.append(meta, wrap, sums, notes, sourceLine());
  // On a narrow screen start with the last three days, today and the forecast in view.
  // Reading offsetLeft lays the table out now; in a hidden tab it is 0 and nothing moves.
  const first = table.rows[0].cells[PAST_DAYS - SUM_DAYS + 1];
  if (first && wrap.scrollWidth > wrap.clientWidth) wrap.scrollLeft = first.offsetLeft - corner.offsetWidth;
}
