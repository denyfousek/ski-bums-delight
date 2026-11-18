// Wind forecast for a point via Open-Meteo, model MeteoSwiss ICON-CH1/CH2 (seamless).
// Free tier is non-commercial only; data CC BY 4.0 (Open-Meteo / MeteoSwiss).
import { OPEN_METEO_URL } from './config.js';
import { compass } from './stations.js';

export async function fetchWind(lon, lat) {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,freezing_level_height,snowfall',
    models: 'meteoswiss_icon_seamless',
    forecast_days: '2',
    timezone: 'Europe/Zurich',
    wind_speed_unit: 'kmh',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${q}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

// Draws a compact hourly table (every 3 h) into el.
export function renderWind(el, data) {
  el.replaceChildren();
  const h = data.hourly;
  if (!h || !h.time) {
    el.textContent = 'No forecast available.';
    return;
  }
  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = `Model grid elevation ${Math.round(data.elevation)} m · 10 m wind, not ridge wind`;
  const table = document.createElement('table');
  table.className = 'wx';
  const head = table.insertRow();
  ['Time', 'Wind', 'Gust', 'Dir', '°C', '0° line', 'Snow'].forEach((t) => {
    const th = document.createElement('th');
    th.textContent = t;
    head.append(th);
  });
  const now = Date.now() - 3600e3;
  for (let i = 0; i < h.time.length; i += 3) {
    const t = new Date(h.time[i]);
    if (t.getTime() < now) continue;
    const row = table.insertRow();
    const cells = [
      t.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit' }),
      `${Math.round(h.wind_speed_10m[i])}`,
      `${Math.round(h.wind_gusts_10m[i])}`,
      compass(h.wind_direction_10m[i]),
      h.temperature_2m[i] != null ? h.temperature_2m[i].toFixed(0) : '',
      h.freezing_level_height[i] != null ? `${Math.round(h.freezing_level_height[i] / 50) * 50}` : '',
      h.snowfall[i] ? `${h.snowfall[i].toFixed(1)}` : '',
    ];
    cells.forEach((v, k) => {
      const td = row.insertCell();
      td.textContent = v;
      if (k === 2 && h.wind_gusts_10m[i] >= 50) td.className = 'warn';
    });
    if (table.rows.length > 13) break;
  }
  const units = document.createElement('div');
  units.className = 'muted';
  units.textContent = 'Wind and gusts in km/h, 0° line in m, snowfall in cm per hour.';
  el.append(meta, table, units);
}
