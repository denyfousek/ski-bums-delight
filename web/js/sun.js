// Solar position (azimuth from north, elevation above horizon) for a date and place.
// Low-precision almanac formulas (Astronomical Almanac / NOAA style), accurate to a few
// tenths of a degree — plenty for terrain shading. Refraction is ignored.

const RAD = Math.PI / 180;

export function sunPosition(date, lon, lat) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + lon) * RAD - ra;
  const phi = lat * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { azimuth: ((az / RAD) + 360) % 360, elevation: el / RAD };
}

// Sunrise / sunset (elevation crosses -0.833°) on the local calendar day of `date`, by scanning.
export function sunTimes(date, lon, lat) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  let rise = null;
  let set = null;
  let prev = sunPosition(start, lon, lat).elevation;
  for (let m = 5; m <= 24 * 60; m += 5) {
    const t = new Date(start.getTime() + m * 60000);
    const el = sunPosition(t, lon, lat).elevation;
    if (prev < -0.833 && el >= -0.833 && !rise) rise = t;
    if (prev >= -0.833 && el < -0.833) set = t;
    prev = el;
  }
  return { rise, set };
}
