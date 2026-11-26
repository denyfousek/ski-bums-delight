// Tests for the new-snow table (web/js/newsnow.js). The fixture is a real Open-Meteo answer
// for Andermatt from 2026-11-26 (MeteoSwiss ICON, cell_selection=nearest, Europe/Zurich).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { newSnowDays, sumOrNull, fmtCm, zurichToday, PAST_DAYS, AHEAD_DAYS } from '../../web/js/newsnow.js';

const data = JSON.parse(readFileSync(new URL('../fixtures/open-meteo-newsnow.json', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('newsnow: 7 days back, today, 4 ahead', () => {
  const r = newSnowDays(data, '2026-11-26');
  assert.equal(r.days.length, PAST_DAYS + 1 + AHEAD_DAYS);
  assert.equal(r.days[0].date, '2026-11-19');
  assert.equal(r.days[7].date, '2026-11-26');
  assert.equal(r.days[7].kind, 'today');
  assert.equal(r.days[11].date, '2026-11-30');
  assert.deepEqual([...new Set(r.days.map((d) => d.kind))], ['past', 'today', 'future']);
  assert.equal(r.cellElevation, 1438);
});

test('newsnow: snow is precipitation × 0.7, sums by hand from the raw answer', () => {
  const r = newSnowDays(data, '2026-11-26');
  near(r.days[7].snowCm, 12.2 * 0.7);
  // last 3 days without today: 23., 24., 25. November = 10.8 + 0.0 + 2.1 mm
  near(r.last3, (10.8 + 0 + 2.1) * 0.7);
  // next 3 days without today: 27., 28., 29. November = 0 mm each
  assert.equal(r.next3, 0);
  assert.equal(r.days[5].snowCm, 0, 'a real 0 stays 0');
});

test('newsnow: an incomplete day is a dash and makes no sum', () => {
  const r = newSnowDays(data, '2026-11-27');
  const last = r.days[r.days.length - 1];
  assert.equal(last.date, '2026-12-01');
  assert.equal(last.snowCm, null, 'Open-Meteo reports the unfinished day as null');
  assert.equal(last.gust, null);
  near(r.next3, 2.1 * 0.7); // 28., 29., 30. November are complete
  const gap = structuredClone(data);
  gap.daily.precipitation_sum[gap.daily.time.indexOf('2026-11-24')] = null;
  assert.equal(newSnowDays(gap, '2026-11-26').last3, null, 'a missing day gives no smaller sum');
});

test('newsnow: freezing level per day is min and max of the hourly values', () => {
  const r = newSnowDays(data, '2026-11-26');
  const h = data.hourly;
  const vals = h.time.map((t, i) => [t, h.freezing_level_height[i]]).filter(([t, v]) => t.startsWith('2026-11-26') && v !== null).map(([, v]) => v);
  assert.equal(r.days[7].fzMin, Math.min(...vals));
  assert.equal(r.days[7].fzMax, Math.max(...vals));
});

test('newsnow: days outside the answer stay empty', () => {
  const r = newSnowDays(data, '2026-12-10');
  assert.ok(r.days.slice(PAST_DAYS + 1).every((d) => d.snowCm === null && d.fzMin === null));
  const empty = newSnowDays({}, '2026-11-26');
  assert.equal(empty.last3, null);
  assert.equal(empty.cellElevation, null);
});

test('newsnow: helpers', () => {
  assert.equal(sumOrNull([]), null);
  assert.equal(sumOrNull([1, 2]), 3);
  assert.equal(sumOrNull([1, null]), null);
  assert.equal(fmtCm(null), '–');
  assert.equal(fmtCm(0), '0');
  assert.equal(fmtCm(1.47), '1.5');
  assert.equal(fmtCm(12.6), '13');
  assert.equal(zurichToday(new Date('2026-11-26T23:30:00Z')), '2026-11-27', 'after midnight in Zurich');
  assert.equal(zurichToday(new Date('2026-07-01T21:30:00Z')), '2026-07-01', 'summer time: still 23:30');
});
