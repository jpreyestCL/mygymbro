import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue } from '../coach/cadence.js';

const t1 = Date.parse('2026-08-20T10:00:00Z')
const t2 = Date.parse('2026-08-21T10:00:00Z')
const t3 = Date.parse('2026-08-22T10:00:00Z')
const workout = (end, d) => ({ d: d || new Date(end).toISOString().slice(0, 10), end, entries: [] });

test('everyWorkouts is due once enough sessions landed after the last look', () => {
  const coach = { cadence: { everyWorkouts: 2 } };
  const S = { workouts: [workout(t1), workout(t2)] };
  assert.equal(isDue(coach, S, null), true);
  assert.equal(isDue(coach, S, null, t3), false, 'a finished review on the server must close the window');
});

test('a client lastReview also closes the window', () => {
  const coach = { cadence: { everyWorkouts: 1 }, lastReview: { at: t3 } };
  const S = { workouts: [workout(t1)] };
  assert.equal(isDue(coach, S, null), false);
});

test('weekly fires once on the chosen minute, then not again the same day', () => {
  const coach = { cadence: { weekly: { day: 1, time: '18:00' } } };
  const S = { workouts: [workout(Date.parse('2026-08-24T10:00:00Z'))] };
  const now = { date: '2026-08-24', hhmm: '18:00', weekday: 1 };
  assert.equal(isDue(coach, S, now), true);
  assert.equal(isDue(coach, S, now, Date.parse('2026-08-24T18:00:00Z')), false);
});

test('off cadence never fires', () => {
  assert.equal(isDue({ cadence: 'off' }, { workouts: [workout(1)] }, null), false);
});
