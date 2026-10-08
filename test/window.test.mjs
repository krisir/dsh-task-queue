/**
 * Execution-window tests.
 *
 * The cases that matter are the ones a naive implementation gets wrong: the
 * window that wraps midnight, the exclusive end minute, and the fact that
 * `18:00` means 18:00 *in the configured zone*, not on the machine running the
 * Host. Asia/Shanghai is UTC+8 with no DST, so the instants below are exact and
 * the test does not depend on where it runs.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	formatClock,
	isOpen,
	isTimeOfDay,
	isTimeZone,
	nextBoundary,
	normalizeWindows,
	toMinutes,
	zonedClock,
} from '../host/window.js';

/** Build a gating object the way the store would. */
function gate(windows, extra = {}) {
	return { enabled: true, windows, timeZone: 'Asia/Shanghai', ...extra };
}

/** One window that runs overnight, the case the feature exists for. */
const overnight = gate([{ start: '18:00', end: '07:00' }]);

/** The same hours, but not wrapping: a daytime window. */
const daytime = gate([{ start: '09:00', end: '17:00' }]);

/** An instant at a given Shanghai wall-clock time. */
function shanghai(iso) {
	return Date.parse(iso);
}

test('time-of-day validation accepts only HH:mm', () => {
	assert.equal(isTimeOfDay('00:00'), true);
	assert.equal(isTimeOfDay('23:59'), true);
	assert.equal(isTimeOfDay('24:00'), false);
	assert.equal(isTimeOfDay('7:00'), false);
	assert.equal(isTimeOfDay('07:60'), false);
	assert.equal(isTimeOfDay(''), false);
	assert.equal(isTimeOfDay(undefined), false);
	assert.equal(toMinutes('00:00'), 0);
	assert.equal(toMinutes('18:30'), 1110);
	assert.equal(toMinutes('23:59'), 1439);
});

test('time-zone validation rejects unknown zones', () => {
	assert.equal(isTimeZone('Asia/Shanghai'), true);
	assert.equal(isTimeZone('UTC'), true);
	assert.equal(isTimeZone('Mars/Olympus'), false);
	assert.equal(isTimeZone(''), false);
});

test('the zone, not the machine, decides the minute', () => {
	// 10:00 UTC is 18:00 in Shanghai and 11:00 in Berlin; reading the same
	// instant in two zones must give two different minutes of day.
	assert.equal(formatClock(shanghai('2025-01-01T10:00:00Z'), 'Asia/Shanghai'), '18:00');
	assert.equal(formatClock(shanghai('2025-01-01T10:00:00Z'), 'Europe/Berlin'), '11:00');
	assert.deepEqual(zonedClock(shanghai('2025-01-01T10:00:00Z'), 'Asia/Shanghai'), {
		hour: 18,
		minute: 0,
		minuteOfDay: 1080,
	});
});

test('midnight reads as hour 0, not 24', () => {
	// `hour12: false` renders midnight as `24` on some ICU builds, which would
	// silently shorten an 18:00–07:00 window to 18:00–24:00.
	assert.equal(formatClock(shanghai('2025-01-01T16:00:00Z'), 'Asia/Shanghai'), '00:00');
});

test('an overnight window is closed before it opens and open after', () => {
	assert.equal(isOpen(shanghai('2025-01-01T09:59:00Z'), overnight), false, '17:59 local');
	assert.equal(isOpen(shanghai('2025-01-01T10:00:00Z'), overnight), true, '18:00 local, inclusive');
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), overnight), true, '23:00 local');
	assert.equal(isOpen(shanghai('2025-01-01T16:00:00Z'), overnight), true, '00:00 local, wrapped');
	assert.equal(isOpen(shanghai('2025-01-01T22:59:00Z'), overnight), true, '06:59 local');
	assert.equal(isOpen(shanghai('2025-01-01T23:00:00Z'), overnight), false, '07:00 local, exclusive');
	assert.equal(isOpen(shanghai('2025-01-02T05:00:00Z'), overnight), false, '13:00 local');
});

test('a same-day window behaves like a normal interval', () => {
	assert.equal(isOpen(shanghai('2025-01-01T00:59:00Z'), daytime), false, '08:59 local');
	assert.equal(isOpen(shanghai('2025-01-01T01:00:00Z'), daytime), true, '09:00 local');
	assert.equal(isOpen(shanghai('2025-01-01T08:59:00Z'), daytime), true, '16:59 local');
	assert.equal(isOpen(shanghai('2025-01-01T09:00:00Z'), daytime), false, '17:00 local');
});

test('the master switch closes the window at any hour', () => {
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), gate(overnight.windows, { enabled: false })), false);
});

test('equal start and end reads as all day, not never', () => {
	const allDay = gate([{ start: '00:00', end: '00:00' }]);
	assert.equal(isOpen(shanghai('2025-01-01T00:00:00Z'), allDay), true);
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), allDay), true);
});

test('several windows open the queue when any one of them is open', () => {
	const split = gate([
		{ start: '09:00', end: '10:00' },
		{ start: '18:00', end: '07:00' },
	]);
	assert.equal(isOpen(shanghai('2025-01-01T01:30:00Z'), split), true, '09:30 local, first window');
	assert.equal(isOpen(shanghai('2025-01-01T04:00:00Z'), split), false, '12:00 local, neither');
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), split), true, '23:00 local, second window');
	assert.equal(isOpen(shanghai('2025-01-01T22:00:00Z'), split), true, '06:00 local, wrapped part');
	assert.equal(isOpen(shanghai('2025-01-01T23:00:00Z'), split), false, '07:00 local, exclusive end');
});

test('the next boundary is the nearest change across every window', () => {
	const split = gate([
		{ start: '09:00', end: '10:00' },
		{ start: '18:00', end: '07:00' },
	]);
	// 08:59 local: the next change is 09:00, from the first window.
	const boundary = nextBoundary(shanghai('2025-01-01T00:59:00Z'), split);
	assert.equal(new Date(boundary).toISOString(), '2025-01-01T01:00:00.000Z');
	assert.equal(isOpen(boundary, split), true);
	assert.equal(isOpen(boundary - 1, split), false);
});

test('an empty window list schedules nothing and has no boundary', () => {
	const none = gate([]);
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), none), false);
	assert.equal(nextBoundary(shanghai('2025-01-01T15:00:00Z'), none), undefined);
});

test('an all-day window anywhere makes the queue constantly open', () => {
	const split = gate([{ start: '09:00', end: '10:00' }, { start: '00:00', end: '00:00' }]);
	assert.equal(isOpen(shanghai('2025-01-01T15:00:00Z'), split), true);
	assert.equal(nextBoundary(shanghai('2025-01-01T15:00:00Z'), split), undefined, 'it never changes');
});

test('window lists are repaired entry by entry', () => {
	assert.deepEqual(normalizeWindows([{ start: '18:00', end: '07:00' }]), [{ start: '18:00', end: '07:00' }]);
	assert.deepEqual(
		normalizeWindows([
			{ start: '18:00', end: '07:00' },
			{ start: '25:00', end: '07:00' },
			{ start: '18:00', end: '07:00' },
			null,
			{ start: '09:00', end: '17:00' },
		]),
		[
			{ start: '18:00', end: '07:00' },
			{ start: '09:00', end: '17:00' },
		],
		'invalid and duplicate entries are dropped, the rest survive',
	);
	assert.deepEqual(normalizeWindows('nope'), []);
});

test('the next boundary is the exact minute the window opens', () => {
	const boundary = nextBoundary(shanghai('2025-01-01T09:59:00Z'), overnight);
	assert.equal(new Date(boundary).toISOString(), '2025-01-01T10:00:00.000Z');
	assert.equal(isOpen(boundary, overnight), true);
	assert.equal(isOpen(boundary - 1, overnight), false);
});

test('the next boundary is the exact minute the window closes', () => {
	const boundary = nextBoundary(shanghai('2025-01-01T22:00:00Z'), overnight);
	assert.equal(new Date(boundary).toISOString(), '2025-01-01T23:00:00.000Z');
	assert.equal(isOpen(boundary, overnight), false);
	assert.equal(isOpen(boundary - 1, overnight), true);
});

test('a disabled or constant window has no boundary', () => {
	assert.equal(nextBoundary(shanghai('2025-01-01T09:00:00Z'), gate(overnight.windows, { enabled: false })), undefined);
	assert.equal(nextBoundary(shanghai('2025-01-01T09:00:00Z'), gate([{ start: '09:00', end: '09:00' }])), undefined);
});
