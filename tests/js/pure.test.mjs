// Tests for the modules that need no browser: run with  node --test tests/js/
import test from 'node:test';
import assert from 'node:assert/strict';

import { wgsToLv95, lv95ToWgs, wgsToUtm, haversine, pointInGeometry, aspectSector } from '../../web/js/proj.js';
import { sunPosition, sunTimes } from '../../web/js/sun.js';
import { computeShade, gridAzimuth, SUN, CAST, NIGHT } from '../../web/js/shade.js';
import { computeSlopeAspect, isCritical } from '../../web/js/slope.js';
import { criticalRules, elevationBound, bulletinAt, rulesLookup, maxLevel, historyMoments } from '../../web/js/bulletin.js';
import {
  parseElevation, resample, slopeAspect, ascentDescent, stats, classifyPoint, routeCheck, GREEN, YELLOW, RED, UNKNOWN,
} from '../../web/js/gpx.js';
import { fitSnowline, snowlineFromClasses, samplePoints, stationSamples } from '../../web/js/snowline.js';
import { boxAround, homeView, isArea, loadArea, saveArea, PRESETS, DEFAULT_AREA, inSwitzerland } from '../../web/js/areas.js';
import { latestValues, compass, fixMojibake } from '../../web/js/stations.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ± ${tol}, got ${a}`);

// ---------- proj ----------
test('LV95: swisstopo reference example and round trip', () => {
  // Worked example from the swisstopo formula sheet: 46° 02' 38.87" N, 8° 43' 49.79" E
  // is E 2 700 000, N 1 100 000 (the approximate formulas are good to about a metre).
  const [E, N] = wgsToLv95(8 + 43 / 60 + 49.79 / 3600, 46 + 2 / 60 + 38.87 / 3600);
  near(E, 2700000, 1.5, 'E');
  near(N, 1100000, 1.5, 'N');
  for (const [lon, lat] of [[8.57, 46.6], [9.85, 46.8], [7.75, 46.0], [6.2, 46.3]]) {
    const [lon2, lat2] = lv95ToWgs(...wgsToLv95(lon, lat));
    near(lon2, lon, 2e-5, 'lon');
    near(lat2, lat, 2e-5, 'lat');
  }
});

test('UTM zone 32: central meridian maps to easting 500000', () => {
  const [x, y] = wgsToUtm(9, 46.6, 32);
  near(x, 500000, 0.01, 'x');
  near(y, 5160800, 800, 'y'); // 46.6° N is about 5161 km from the equator
  assert.ok(wgsToUtm(8.5, 46.6, 32)[0] < 500000);
});

test('haversine: one degree of latitude', () => {
  near(haversine(8, 46, 8, 47), 111195, 60);
  assert.equal(haversine(8, 46, 8, 46), 0);
});

test('point in polygon, with a hole and a multipolygon', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const poly = { type: 'Polygon', coordinates: [square, hole] };
  assert.equal(pointInGeometry(2, 2, poly), true);
  assert.equal(pointInGeometry(5, 5, poly), false);
  assert.equal(pointInGeometry(11, 5, poly), false);
  const multi = { type: 'MultiPolygon', coordinates: [[square], [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]] };
  assert.equal(pointInGeometry(25, 25, multi), true);
  assert.equal(pointInGeometry(15, 15, multi), false);
  assert.equal(pointInGeometry(1, 1, null), false);
});

test('aspect sectors', () => {
  assert.equal(aspectSector(0), 'N');
  assert.equal(aspectSector(22), 'N');
  assert.equal(aspectSector(23), 'NE');
  assert.equal(aspectSector(180), 'S');
  assert.equal(aspectSector(359), 'N');
  assert.equal(aspectSector(-45), 'NW');
});

// ---------- sun ----------
test('sun: summer solstice noon at 46.6° N stands 66.8° high in the south', () => {
  const p = sunPosition(new Date(Date.UTC(2026, 5, 21, 11, 28)), 8.6, 46.6); // local solar noon
  near(p.elevation, 66.8, 0.4, 'elevation');
  near(p.azimuth, 180, 3, 'azimuth');
});

test('sun: winter solstice noon is low, midnight is below the horizon', () => {
  near(sunPosition(new Date(Date.UTC(2026, 11, 21, 11, 24)), 8.6, 46.6).elevation, 20.0, 0.4);
  assert.ok(sunPosition(new Date(Date.UTC(2026, 11, 21, 23, 30)), 8.6, 46.6).elevation < -50);
});

test('sun: morning in the east, afternoon in the west', () => {
  assert.ok(sunPosition(new Date(Date.UTC(2026, 2, 20, 7, 0)), 8.6, 46.6).azimuth < 150);
  assert.ok(sunPosition(new Date(Date.UTC(2026, 2, 20, 15, 0)), 8.6, 46.6).azimuth > 210);
});

test('sun times: day length at the equinox is about 12 hours', () => {
  const { rise, set } = sunTimes(new Date(2026, 2, 20, 12, 0), 8.6, 46.6);
  assert.ok(rise && set);
  near((set - rise) / 3600000, 12.15, 0.35, 'hours');
});

// ---------- shade ----------
function flatWithWall(cols, rows, wallCol, height) {
  const z = new Float32Array(cols * rows).fill(1000);
  for (let r = 0; r < rows; r++) z[r * cols + wallCol] = 1000 + height;
  return { z, cols, rows, cell: 10 };
}

test('shade: a wall casts a shadow away from the sun, of the right length', () => {
  const g = flatWithWall(60, 9, 30, 100);
  // Sun in the east, 45° high: shadow falls west of the wall, 100 m long = 10 cells.
  const s = computeShade(g, 90, 45);
  const row = 4 * g.cols;
  assert.equal(s[row + 40], SUN, 'east of the wall is lit');
  assert.equal(s[row + 25], CAST, '50 m west of the wall is shaded');
  assert.equal(s[row + 15], SUN, '150 m west of the wall is lit again');
  let len = 0;
  for (let c = 29; c >= 0 && s[row + c] === CAST; c--) len++;
  near(len, 10, 2, 'shadow cells');
});

test('shade: sun below the horizon is night everywhere', () => {
  const s = computeShade(flatWithWall(10, 5, 5, 50), 180, -3);
  assert.ok(s.every((v) => v === NIGHT));
});

test('shade: a slope facing away from the sun is shaded, one facing it is lit', () => {
  const cols = 12; const rows = 12;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = 1000 + r * 10; // rises to the south
  // 45° north face, sun 20° high in the south: no sun reaches it.
  assert.notEqual(computeShade({ z, cols, rows, cell: 10 }, 180, 20)[6 * cols + 6], SUN);
  // The same plane seen from the north is a south-facing slope in full sun.
  assert.equal(computeShade({ z, cols, rows, cell: 10 }, 0, 20)[6 * cols + 6], SUN);
});

test('grid azimuth: no correction on the Bern meridian, about -1.5° at 9.5° E', () => {
  near(gridAzimuth(180, 7.43958333, 46.8), 180, 1e-9);
  near(gridAzimuth(180, 9.5, 46.8) - 180, -1.5, 0.05);
});

// ---------- slope ----------
function plane(dzPerCellEast, dzPerCellNorth, cols = 7, rows = 7, cell = 10) {
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = 2000 + c * dzPerCellEast - r * dzPerCellNorth;
  return { z, cols, rows, cell };
}

test('slope and aspect of tilted planes (aspect = the direction the slope faces)', () => {
  const k = 3 * 7 + 3;
  // Rises 10 m per 10 m cell towards the north: 45° slope, facing south.
  let g = computeSlopeAspect(plane(0, 10));
  near(g.slope[k], 45, 0.01);
  near(g.aspect[k], 180, 0.01);
  // Rises towards the east: facing west.
  g = computeSlopeAspect(plane(10, 0));
  near(g.aspect[k], 270, 0.01);
  // Rises towards the south: 30° slope, facing north.
  g = computeSlopeAspect(plane(0, -10 * Math.tan(Math.PI / 6)));
  near(g.slope[k], 30, 0.01);
  near(g.aspect[k] % 360, 0, 0.01);
  // Border cells stay undefined.
  assert.ok(Number.isNaN(g.slope[0]));
});

test('isCritical: slope, aspect and elevation band must all match', () => {
  const rules = [{ aspects: new Set(['N', 'NE']), lower: 2000, upper: null }];
  assert.equal(isCritical({ slope: 35, aspect: 10, elevation: 2300 }, rules), true);
  assert.equal(isCritical({ slope: 29, aspect: 10, elevation: 2300 }, rules), false);
  assert.equal(isCritical({ slope: 35, aspect: 180, elevation: 2300 }, rules), false);
  assert.equal(isCritical({ slope: 35, aspect: 10, elevation: 1900 }, rules), false);
  assert.equal(isCritical({ slope: NaN, aspect: 10, elevation: 2300 }, rules), false);
});

// ---------- bulletin ----------
const region = (name, x0, props) => ({
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[x0, 46], [x0 + 1, 46], [x0 + 1, 47], [x0, 47], [x0, 46]]] },
  properties: { regions: [{ name }], ...props },
});

test('critical rules: a problem without aspects applies to all aspects', () => {
  const rules = criticalRules({
    avalancheProblems: [
      { problemType: 'wind_slab', aspects: ['N', 'NE'], elevation: { lowerBound: '2200' } },
      { problemType: 'wet_snow', aspects: [], elevation: { upperBound: '2400' } },
      { problemType: 'gliding_snow' },
      { problemType: 'favourable_situation', aspects: ['S'] },
      { problemType: 'no_distinct_avalanche_problem' },
    ],
  });
  assert.equal(rules.length, 3);
  assert.deepEqual([...rules[0].aspects], ['N', 'NE']);
  assert.equal(rules[0].lower, 2200);
  assert.equal(rules[0].upper, null);
  assert.equal(rules[1].aspects.size, 8);
  assert.equal(rules[1].upper, 2400);
  assert.equal(rules[2].aspects.size, 8);
  assert.deepEqual(criticalRules({}), []);
});

test('elevation bounds: numbers, treeline, missing', () => {
  assert.equal(elevationBound('2200'), 2200);
  assert.equal(elevationBound(1800), 1800);
  assert.equal(elevationBound('treeline'), 2000);
  assert.equal(elevationBound(undefined), null);
  assert.equal(elevationBound('abc'), null);
});

test('bulletin lookup by point, highest level, per-region rules', () => {
  const gj = {
    features: [
      region('West', 7, { dangerRatings: [{ mainValue: 'moderate' }, { mainValue: 'considerable' }], avalancheProblems: [{ problemType: 'wind_slab', aspects: ['N'] }] }),
      region('East', 9, { dangerRatings: [{ mainValue: 'low' }], avalancheProblems: [] }),
    ],
  };
  assert.equal(bulletinAt(gj, 7.5, 46.5).properties.regions[0].name, 'West');
  assert.equal(bulletinAt(gj, 8.5, 46.5), null);
  assert.equal(maxLevel(gj.features[0].properties).n, 3);
  assert.equal(maxLevel({}), null);
  const at = rulesLookup(gj);
  assert.equal(at(7.5, 46.5).length, 1);
  assert.equal(at(7.6, 46.5), at(7.5, 46.5), 'same region returns the cached rules');
  assert.deepEqual(at(9.5, 46.5), []);
  assert.equal(at(8.5, 46.5), null);
});

test('history moments: last days at 10:00 UTC, newest first, across a month change', () => {
  const m = historyMoments(new Date(Date.UTC(2026, 11, 2, 6, 30)), 3);
  assert.deepEqual(m.map((d) => d.toISOString()), ['2026-12-01T10:00:00.000Z', '2026-11-30T10:00:00.000Z', '2026-11-29T10:00:00.000Z']);
});

// ---------- gpx ----------
test('gpx elevation text: empty and junk are "no elevation", not 0', () => {
  assert.equal(parseElevation(''), null);
  assert.equal(parseElevation('  '), null);
  assert.equal(parseElevation('abc'), null);
  assert.equal(parseElevation('0'), 0);
  assert.equal(parseElevation(' 1523.4 '), 1523.4);
  assert.equal(parseElevation(null), null);
});

test('resample: even steps, total distance kept, elevation interpolated', () => {
  const a = { lon: 8, lat: 46, ele: 1000 };
  const b = { lon: 8, lat: 46.009, ele: 1100 }; // about 1000.8 m north
  const pts = resample([a, b], 100);
  const total = haversine(8, 46, 8, 46.009);
  near(pts[pts.length - 1].dist, total, 1e-6);
  near(pts[1].dist, 100, 1e-6);
  near(pts[5].ele, 1000 + (500 / total) * 100, 0.01);
  assert.equal(pts.length, 12);
});

test('slope and aspect from four neighbours', () => {
  // 15 m spacing; north neighbour 30 m higher than south: rises to the north, faces south.
  let r = slopeAspect(1000, 1000, 1015, 985, 15);
  near(r.slope, 45, 0.01);
  near(r.aspect, 180, 0.01);
  r = slopeAspect(990, 1010, 1000, 1000, 15); // drops to the east: faces east
  near(r.aspect, 90, 0.01);
  assert.ok(Number.isNaN(slopeAspect(undefined, 1, 1, 1, 15).slope));
});

test('ascent with a threshold ignores GPS noise but keeps real climbs', () => {
  const noisy = [];
  for (let i = 0; i < 200; i++) noisy.push(1500 + (i % 2 ? 2 : -2)); // flat, ±2 m jitter
  assert.deepEqual(ascentDescent(noisy, 5), { up: 0, down: 0 });
  // The same jitter summed raw would be 4 m per step.
  assert.ok(ascentDescent(noisy, 0).up > 350);
  const climb = [1000, 1002, 1001, 1010, 1030, 1028, 1100, 1090, 1000];
  const r = ascentDescent(climb, 5);
  near(r.up, 100, 5);
  near(r.down, 100, 5);
  assert.deepEqual(ascentDescent([1000, NaN, 1010], 5), { up: 10, down: 0 });
});

test('stats tolerate missing elevations and slopes', () => {
  const s = stats([
    { dist: 0, z: 1000, slope: 10 },
    { dist: 20, z: NaN, slope: NaN },
    { dist: 40, z: 1020, slope: 35 },
  ]);
  assert.equal(s.up, 20);
  assert.equal(s.minZ, 1000);
  assert.equal(s.maxZ, 1020);
  assert.equal(s.maxSlope, 35);
  assert.equal(s.steepShare, 0.5);
});

test('traffic light per point', () => {
  const rules = [{ aspects: new Set(['N']), lower: 2000, upper: null }];
  assert.equal(classifyPoint({ slope: 20, aspect: 0, z: 2500 }, rules), GREEN);
  assert.equal(classifyPoint({ slope: 30, aspect: 0, z: 2500 }, rules), RED);
  assert.equal(classifyPoint({ slope: 34, aspect: 180, z: 2500 }, rules), YELLOW);
  assert.equal(classifyPoint({ slope: 34, aspect: 0, z: 1800 }, rules), YELLOW);
  assert.equal(classifyPoint({ slope: 34, aspect: 0, z: 2500 }, null), YELLOW, 'no bulletin: never red');
  assert.equal(classifyPoint({ slope: NaN, aspect: 0, z: 2500 }, rules), UNKNOWN);
});

test('route check: sections, short ones absorbed, red ones kept', () => {
  const rules = [{ aspects: new Set(['N']), lower: null, upper: null }];
  const mk = (i, slope, aspect) => ({ lon: 8, lat: 46 + i * 0.0001, dist: i * 20, z: 2000 + i, slope, aspect });
  const pts = [];
  for (let i = 0; i < 10; i++) pts.push(mk(i, 10, 0));          // green, 180 m
  pts.push(mk(10, 33, 180));                                    // one yellow point: absorbed
  for (let i = 11; i < 20; i++) pts.push(mk(i, 10, 0));         // green
  pts.push(mk(20, 36, 0));                                      // one red point: kept
  for (let i = 21; i < 30; i++) pts.push(mk(i, 32, 180));       // yellow, 180 m
  const c = routeCheck(pts, () => rules);
  assert.deepEqual(c.sections.map((s) => s.check), [GREEN, RED, YELLOW]);
  // A short yellow point right after a red one stays out of the red section.
  const pts2 = [];
  for (let i = 0; i < 10; i++) pts2.push(mk(i, 10, 0));
  pts2.push(mk(10, 31, 0));   // red: steep and facing north
  pts2.push(mk(11, 44, 180)); // yellow: steeper, but facing south
  for (let i = 12; i < 20; i++) pts2.push(mk(i, 10, 0));
  const c2 = routeCheck(pts2, () => rules);
  const red = c2.sections.filter((s) => s.check === RED);
  assert.equal(red.length, 1);
  assert.equal(red[0].from, 10);
  assert.equal(red[0].to, 10);
  near(red[0].maxSlope, 31, 1e-9);
  assert.equal(red[0].aspect, 'N');
  assert.equal(c.sections[1].from, 20);
  assert.equal(c.sections[1].aspect, 'N');
  near(c.sections[1].maxSlope, 36, 1e-9);
  near(c.share.green + c.share.yellow + c.share.red + c.share.unknown, 1, 1e-9);
  assert.equal(c.points[20].check, RED);
  // Without a bulletin nothing is red.
  assert.ok(routeCheck(pts, null).sections.every((s) => s.check !== RED));
});

// ---------- snow line ----------
test('snow line: clean split between bare and covered points', () => {
  const f = fitSnowline([
    { elevation: 1000, depthM: 0 }, { elevation: 1400, depthM: 0.01 },
    { elevation: 1800, depthM: 0.2 }, { elevation: 2400, depthM: 0.7 }, { elevation: 2900, depthM: 1.1 },
  ]);
  assert.equal(f.method, 'split');
  assert.equal(f.line, 1600);
  assert.equal(f.misfit, 0);
  near(f.gradient, 8.2, 0.5);
});

test('snow line: a blown-clear summit station does not lift the line', () => {
  const f = fitSnowline([
    { elevation: 1436, depthM: 0 }, { elevation: 1500, depthM: 0.02 },
    { elevation: 1700, depthM: 0.2 }, { elevation: 2200, depthM: 0.6 }, { elevation: 2900, depthM: 1.2 },
    { elevation: 3028, depthM: 0, weight: 4 },
  ]);
  assert.equal(f.line, 1600);
  assert.ok(f.misfit > 0);
});

test('snow line: all covered, none covered, no data', () => {
  let f = fitSnowline([{ elevation: 1500, depthM: 0.3 }, { elevation: 2500, depthM: 1 }]);
  assert.equal(f.method, 'all-snow');
  assert.equal(f.line, 1500);
  f = fitSnowline([{ elevation: 1500, depthM: 0 }, { elevation: 2500, depthM: 0.02 }]);
  assert.equal(f.method, 'no-snow');
  assert.equal(f.line, 2500);
  f = fitSnowline([{ elevation: NaN, depthM: 1 }, { elevation: 2000, depthM: null }]);
  assert.equal(f.method, 'none');
  assert.equal(f.line, null);
});

test('snow line: a trusted station outweighs a single model point', () => {
  // Station says bare at 1400 m, one model point claims snow at 1200 m.
  const f = fitSnowline([
    { elevation: 1200, depthM: 0.5 }, { elevation: 1400, depthM: 0, weight: 4 }, { elevation: 2000, depthM: 0.6 },
  ]);
  assert.equal(f.line, 1700);
});

test('snow line: independent of input order when two points share a height', () => {
  const a = [{ elevation: 1000, depthM: 0 }, { elevation: 1500, depthM: 0 }, { elevation: 1500, depthM: 0.3 }, { elevation: 2000, depthM: 0.5 }];
  const b = [a[0], a[2], a[1], a[3]];
  assert.equal(fitSnowline(a).line, fitSnowline(b).line);
});

test('snow line: two separate optima do not average into a worse cut', () => {
  // bare, snow, bare, snow, snow: cutting below 1200 or between 1400 and 1600 are both
  // optimal for the weights below; the middle of the two would not be.
  const f = fitSnowline([
    { elevation: 1000, depthM: 0 }, { elevation: 1200, depthM: 0.2 },
    { elevation: 1400, depthM: 0, weight: 2 }, { elevation: 1600, depthM: 0.4 }, { elevation: 1800, depthM: 0.5 },
  ]);
  assert.ok(f.line === 1100 || f.line === 1500, `line ${f.line}`);
});

test('snow line from satellite: a thin bare band on top does not hide the snow below', () => {
  const pts = [];
  for (let e = 1000; e < 3000; e += 20) for (let n = 0; n < 2; n++) pts.push({ elevation: e, cls: e >= 1900 && e < 2900 ? 'snow' : 'ground' });
  const r = snowlineFromClasses(pts);
  assert.equal(r.line, 1900);
  assert.ok(!r.above);
});

test('history moments use the Swiss calendar day', () => {
  // 23:30 UTC on the 24th is 00:30 on the 25th in Switzerland: yesterday is the 24th.
  const m = historyMoments(new Date(Date.UTC(2026, 10, 24, 23, 30)), 1);
  assert.equal(m[0].toISOString(), '2026-11-24T10:00:00.000Z');
});

test('snow line from satellite classes', () => {
  const pts = [];
  for (let e = 1000; e < 3000; e += 20) for (let k = 0; k < 2; k++) pts.push({ elevation: e, cls: e >= 1900 ? 'snow' : 'ground' });
  assert.equal(snowlineFromClasses(pts).line, 1900);
  assert.equal(snowlineFromClasses(pts.map((p) => ({ ...p, cls: 'ground' }))).above, true);
  assert.equal(snowlineFromClasses(pts.map((p) => ({ ...p, cls: 'snow' }))).below, true);
  assert.equal(snowlineFromClasses(pts.slice(0, 4)).line, null);
});

test('sample points lie inside the box; station samples convert cm to m', () => {
  const box = { west: 8, south: 46, east: 9, north: 47 };
  const pts = samplePoints(box, 4);
  assert.equal(pts.length, 16);
  assert.ok(pts.every((p) => p.lon > 8 && p.lon < 9 && p.lat > 46 && p.lat < 47));
  const s = stationSamples([{ name: 'A', snowCm: 45, elevation: 2000 }, { name: 'B', snowCm: null, elevation: 2100 }, { name: 'C', snowCm: 0, elevation: 1400 }]);
  assert.equal(s.length, 2);
  assert.equal(s[0].depthM, 0.45);
  assert.equal(s[0].weight, 4);
});

// ---------- areas ----------
test('areas: presets are valid and lie in Switzerland', () => {
  assert.ok(PRESETS.length >= 8);
  for (const p of PRESETS) assert.ok(isArea(p), p.name);
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
});

test('areas: box around a point, clamped at the border', () => {
  const b = boxAround(8.6, 46.6);
  near(b.east - b.west, 0.25, 1e-9);
  near(b.north - b.south, 0.13, 1e-9);
  near((b.west + b.east) / 2, 8.6, 1e-4);
  assert.ok(isArea(b));
  const edge = boxAround(5.91, 45.81);
  assert.ok(isArea(edge));
  assert.ok(edge.west >= 5.9 && edge.south >= 45.8);
  assert.equal(inSwitzerland(2.3, 48.8), false);
});

test('areas: home view looks north from south of the box', () => {
  const v = homeView(PRESETS[0]);
  near(v.lon, 8.575, 1e-9);
  near(v.lat, 46.515, 0.001);
  assert.equal(v.heading, 0);
});

test('areas: storage round trip, junk falls back to the default', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadArea(storage), DEFAULT_AREA);
  saveArea(storage, PRESETS[2]);
  assert.equal(loadArea(storage), PRESETS[2]);
  const custom = boxAround(9.1, 46.9, 'Somewhere');
  saveArea(storage, custom);
  assert.deepEqual(loadArea(storage), custom);
  mem.set('sbd-area', '{"id":"custom","name":"x","west":1,"south":2,"east":3,"north":4}');
  assert.equal(loadArea(storage), DEFAULT_AREA);
  mem.set('sbd-area', 'not json');
  assert.equal(loadArea(storage), DEFAULT_AREA);
  assert.equal(loadArea({ getItem() { throw new Error('blocked'); } }), DEFAULT_AREA);
});

// ---------- stations ----------
test('stations: each value comes from the newest record that has it', () => {
  const v = latestValues([
    { measure_date: '2026-11-25T06:00:00Z', HS: 40, VW_30MIN_MEAN: 2, VW_30MIN_MAX: 5, DW_30MIN_MEAN: 180, TA_30MIN_MEAN: -3 },
    { measure_date: '2026-11-24T06:00:00Z', HS: 30, VW_30MIN_MEAN: 1, VW_30MIN_MAX: 2, DW_30MIN_MEAN: 90, TA_30MIN_MEAN: -1 },
    { measure_date: '2026-11-25T06:30:00Z', HS: null, VW_30MIN_MEAN: 5, DW_30MIN_MEAN: 200 },
  ]);
  assert.equal(v.snowCm, 40);
  assert.equal(v.snowChange24h, 10);
  near(v.windKmh, 18, 1e-9);
  assert.equal(v.gustKmh, null, 'no gust in the newest wind record: no value, not 0');
  assert.equal(v.windDir, 200);
  assert.equal(v.airC, -3);
  const empty = latestValues([]);
  assert.equal(empty.snowCm, null);
  assert.equal(empty.time, null);
});

test('stations: compass and label repair', () => {
  assert.equal(compass(0), 'N');
  assert.equal(compass(225), 'SW');
  assert.equal(compass(350), 'N');
  assert.equal(compass(null), '');
  assert.equal(fixMojibake('BÃ¤rentÃ¤lli'), 'Bärentälli');
  assert.equal(fixMojibake('Gütsch'), 'Gütsch');
});
