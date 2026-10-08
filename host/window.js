/**
 * The execution windows: the wall-clock intervals during which a workspace's
 * queue is allowed to claim and dispatch tasks.
 *
 * A workspace may have several. `18:00–07:00` covers the night, but the same
 * project often also wants a lunchtime slot or a weekend block, and expressing
 * that as a single interval is impossible — so the window is a list, and the
 * queue is open when *any* of them is.
 *
 * Everything here is pure. Each window is a local time-of-day interval in an
 * explicit IANA time zone, so it keeps its meaning across DST shifts and does not
 * depend on where the Host runs: the user says "18:00 到次日 07:00" and means the
 * clock on their wall.
 *
 * The one non-obvious case is the wrap: `18:00 → 07:00` is the interval that
 * starts in the evening and ends the next morning, which is exactly what a
 * "work on it overnight" window is. So `start > end` means "wraps midnight"
 * rather than "empty".
 *
 * @module dsh-task-queue/window
 */

/** Formatter cache: constructing an `Intl.DateTimeFormat` is expensive. */
const formatters = new Map();

/** The most windows one workspace may have. */
const MAX_WINDOWS = 12;

/**
 * One execution window.
 * @typedef {object} ExecutionWindow
 * @property {string} start - first minute the queue may run, inclusive, `HH:mm`.
 * @property {string} end - first minute the queue must stop, exclusive, `HH:mm`.
 */

/**
 * A workspace's time gating.
 * @typedef {object} Gating
 * @property {boolean} enabled - master switch for time gating.
 * @property {ExecutionWindow[]} windows - the allowed intervals.
 * @property {string} timeZone - IANA zone the times are read in.
 */

/** `HH:mm`, 24-hour, zero-padded. */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Whether a value is a syntactically valid `HH:mm`.
 * @param {unknown} value - candidate.
 * @returns {boolean} true when the value parses as a time of day.
 */
export function isTimeOfDay(value) {
	return typeof value === 'string' && TIME_OF_DAY_PATTERN.test(value);
}

/**
 * Convert `HH:mm` to minutes since local midnight.
 * @param {string} value - a valid time of day.
 * @returns {number} minutes since midnight, 0 through 1439.
 */
export function toMinutes(value) {
	const match = TIME_OF_DAY_PATTERN.exec(value);
	if (match === null) throw new TypeError(`not a time of day: ${String(value)}`);
	return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Whether an IANA zone name is one this runtime can resolve.
 * @param {unknown} value - candidate zone name.
 * @returns {boolean} true when `Intl` accepts the name.
 */
export function isTimeZone(value) {
	if (typeof value !== 'string' || value.length === 0) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * Normalize an untrusted window list.
 *
 * Invalid entries are dropped rather than repaired, and exact duplicates are
 * collapsed: a window that cannot be parsed would otherwise silently widen or
 * narrow the schedule, which is worse than not having it at all.
 *
 * @param {unknown} raw - untrusted windows.
 * @returns {ExecutionWindow[]} the valid windows, in the order given.
 */
export function normalizeWindows(raw) {
	if (!Array.isArray(raw)) return [];
	const windows = [];
	const seen = new Set();
	for (const entry of raw) {
		if (windows.length >= MAX_WINDOWS) break;
		if (entry === null || typeof entry !== 'object') continue;
		if (!isTimeOfDay(entry.start) || !isTimeOfDay(entry.end)) continue;
		const key = `${entry.start}-${entry.end}`;
		if (seen.has(key)) continue;
		seen.add(key);
		windows.push({ start: entry.start, end: entry.end });
	}
	return windows;
}

/**
 * The wall-clock fields of one instant in one zone.
 *
 * `hourCycle: 'h23'` is deliberate: `hour12: false` renders midnight as `24`
 * in some ICU builds, which would silently turn an `18:00–07:00` window into
 * `18:00–24:00`.
 *
 * @param {number} epochMs - instant to read.
 * @param {string} timeZone - IANA zone to read it in.
 * @returns {{ hour: number, minute: number, minuteOfDay: number }} local fields.
 */
export function zonedClock(epochMs, timeZone) {
	let formatter = formatters.get(timeZone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			hour: '2-digit',
			minute: '2-digit',
		});
		formatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(new Date(epochMs));
	let hour = 0;
	let minute = 0;
	for (const part of parts) {
		if (part.type === 'hour') hour = Number(part.value);
		else if (part.type === 'minute') minute = Number(part.value);
	}
	return { hour, minute, minuteOfDay: hour * 60 + minute };
}

/**
 * Whether one window contains a minute of the day.
 *
 * Interval semantics are half-open — `[start, end)` — so a task is never claimed
 * twice by two adjacent windows, and `start === end` reads as "open all day"
 * rather than "never open".
 *
 * @param {number} minuteOfDay - minutes since local midnight.
 * @param {ExecutionWindow} window - one window.
 * @returns {boolean} true while that window is open.
 */
function windowContains(minuteOfDay, window) {
	const start = toMinutes(window.start);
	const end = toMinutes(window.end);
	if (start === end) return true;
	if (start < end) return minuteOfDay >= start && minuteOfDay < end;
	// Wraps midnight: the union of [start, 24:00) and [00:00, end).
	return minuteOfDay >= start || minuteOfDay < end;
}

/**
 * Whether an instant falls inside any of a workspace's windows.
 *
 * Note the two different kinds of closed. `enabled: false` means the user paused
 * the queue and the windows are kept for later; an empty `windows` list means
 * nothing was ever scheduled. Both refuse to dispatch, but the page says which,
 * because "已暂停" and "没有设置时段" are different problems to fix.
 *
 * @param {number} epochMs - instant to test.
 * @param {Gating} gating - the workspace's time gating.
 * @returns {boolean} true while the queue may dispatch.
 */
export function isOpen(epochMs, gating) {
	if (!gating.enabled) return false;
	const windows = gating.windows;
	if (windows.length === 0) return false;
	const now = zonedClock(epochMs, gating.timeZone).minuteOfDay;
	return windows.some((window) => windowContains(now, window));
}

/**
 * The next instant at which {@link isOpen} changes value.
 *
 * Computed by walking forward one minute at a time, which is exact across DST
 * gaps and overlaps because the comparison itself is performed in the target
 * zone. Two days is far more than the longest possible gap between two boundary
 * crossings.
 *
 * @param {number} epochMs - instant to search from.
 * @param {Gating} gating - the workspace's time gating.
 * @returns {number | undefined} the boundary instant, or undefined when the
 *   gating is paused, has no windows, or never changes.
 */
export function nextBoundary(epochMs, gating) {
	if (!gating.enabled || gating.windows.length === 0) return undefined;
	// A window whose start equals its end is open all day, so the aggregate can
	// never change; the per-minute walk below would spin for two days before
	// concluding that, so answer it up front.
	if (gating.windows.some((window) => window.start === window.end)) return undefined;
	const current = isOpen(epochMs, gating);
	const limit = epochMs + 2 * 24 * 60 * 60 * 1000;
	// Minute-granularity is enough: the windows themselves are expressed in minutes.
	let probe = Math.floor(epochMs / 60000) * 60000 + 60000;
	while (probe <= limit) {
		if (isOpen(probe, gating) !== current) return probe;
		probe += 60000;
	}
	return undefined;
}

/**
 * A human-readable `HH:mm` for one instant in one zone.
 * @param {number} epochMs - instant to render.
 * @param {string} timeZone - IANA zone to render in.
 * @returns {string} `HH:mm` in that zone.
 */
export function formatClock(epochMs, timeZone) {
	const { hour, minute } = zonedClock(epochMs, timeZone);
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
