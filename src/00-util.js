/**
 * Small shared helpers: clocks, durations, and the status vocabulary.
 *
 * Nothing here reaches outside the page. Times are rendered in the window's
 * own zone rather than the browser's, because the whole feature is about a
 * wall clock the user set on purpose and a laptop travelling through time
 * zones must not silently move their night window.
 */

/** Statuses a task can hold, mirroring the host's vocabulary. */
const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

/** Clamp a number into a range. */
function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/** Zero-pad to two digits. */
function pad(value) {
	return String(value).padStart(2, '0');
}

/**
 * Render an instant as `HH:mm` in a zone.
 * @param {number} epochMs - the instant.
 * @param {string} timeZone - IANA zone.
 * @returns {string} the local wall clock.
 */
function clockIn(epochMs, timeZone) {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			hour: '2-digit',
			minute: '2-digit',
		}).formatToParts(new Date(epochMs));
		let hour = '00';
		let minute = '00';
		for (const part of parts) {
			if (part.type === 'hour') hour = part.value;
			else if (part.type === 'minute') minute = part.value;
		}
		return pad(Number(hour)) + ':' + pad(Number(minute));
	} catch {
		return '--:--';
	}
}

/**
 * A coarse "time from now" phrase.
 *
 * Deliberately coarse: the page answers "do I have time to add one more
 * task?", and minutes are the unit that question is asked in.
 *
 * @param {number} deltaMs - milliseconds from now, negative for the past.
 * @param {(key: string, vars?: object) => string} t - translator.
 * @returns {string} the phrase.
 */
function humanDuration(deltaMs, t) {
	const future = deltaMs >= 0;
	const totalMinutes = Math.round(Math.abs(deltaMs) / 60000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const parts = [];
	if (days > 0) parts.push(t('duration.days', { count: days }));
	if (hours > 0) parts.push(t('duration.hours', { count: hours }));
	if (minutes > 0 && days === 0) parts.push(t('duration.minutes', { count: minutes }));
	if (parts.length === 0) parts.push(t('duration.lessThanMinute'));
	const amount = parts.join(' ');
	return future ? t('duration.until', { amount }) : t('duration.since', { amount });
}

/**
 * A short absolute timestamp for a card.
 * @param {number} epochMs - the instant.
 * @returns {string} a locale date and time.
 */
function stamp(epochMs) {
	try {
		return new Date(epochMs).toLocaleString(undefined, {
			month: 'numeric',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
	} catch {
		return '';
	}
}

/**
 * The first line of a prompt, for a card's secondary line.
 * @param {string} text - the prompt.
 * @param {number} limit - maximum characters.
 * @returns {string} the excerpt.
 */
function excerpt(text, limit) {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
}

/** A stable, readable id fragment for a card, since the full id is a uuid. */
function shortId(id) {
	return typeof id === 'string' ? id.slice(0, 8) : '';
}

/**
 * Split a task's instruction into what a card shows as its heading and the rest.
 *
 * A task has no title, so its first line does that job: it is what the user wrote
 * first, it is what they would have typed into a title field, and deriving it
 * means there is no second field to keep in sync.
 *
 * @param {string} prompt - the instruction.
 * @returns {{ heading: string, rest: string }} the first line and everything after it.
 */
function splitPrompt(prompt) {
	const text = String(prompt ?? '').replace(/\s+$/, '');
	const newline = text.indexOf('\n');
	if (newline < 0) return { heading: text, rest: '' };
	return { heading: text.slice(0, newline), rest: text.slice(newline + 1).replace(/^\s+/, '') };
}
