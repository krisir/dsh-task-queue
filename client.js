/**
 * dsh-plugin-task-queue — browser half.
 *
 * GENERATED FILE — do not edit. Edit src/*.js and run `node build.mjs`.
 * Sources are concatenated in filename order into one factory body; see
 * build.mjs for why they cannot be separate modules.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-task-queue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React;
		const h = React.createElement;

		//#region src/00-util.js
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
		//#endregion

		//#region src/10-api.js
/**
 * The page's link to the host half.
 *
 * The browser cannot call a third-party host plugin through the generated
 * Remote protocol — the client side of that protocol needs a build-time
 * generated artifact this plugin does not have — so the plugin exposes a plain
 * HTTP route and the page talks to it with `fetch`. Relative URLs work in both
 * hosts: the shipped Web server serves the route directly, and the desktop
 * shell carries `fetch` over its IPC bridge.
 *
 * Every call names the **session** the page is showing. The host resolves that
 * to a workspace, which is what makes a queue belong to a workspace: the page
 * never sends a workspace id, because it does not know one and a client that
 * named its own could file a task in the wrong queue.
 *
 * Every response is `{ error: { code, message } }` on failure, so the page
 * always has something specific to show instead of a bare status code.
 */

/** The route prefix the host half registers. */
const API_BASE = '/dsh-task-queue/api';

/** An error carrying the host's machine-readable code. */
class ApiError extends Error {
	constructor(status, code, message) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * Perform one request against the queue route.
 * @param {string} path - route path below the prefix.
 * @param {object} [init] - fetch options.
 * @returns {Promise<object>} the parsed body.
 */
async function apiRequest(path, init) {
	let response;
	try {
		response = await fetch(API_BASE + path, init);
	} catch (error) {
		throw new ApiError(0, 'UNREACHABLE', String(error && error.message ? error.message : error));
	}
	const text = await response.text();
	let body = null;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (!response.ok) {
		const detail = body && body.error ? body.error : {};
		throw new ApiError(
			response.status,
			detail.code || 'HTTP_' + response.status,
			detail.message || response.statusText,
		);
	}
	return body ?? {};
}

/** POST a JSON body. */
function post(path, body) {
	return apiRequest(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
}

/** The queue API, as the page uses it. Every call carries its session. */
const api = {
	/** Read the snapshot for one session's workspace. */
	state: (sessionId) => apiRequest('/state?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' }),
	createTask: (sessionId, input) => post('/tasks', { sessionId, ...input }),
	updateTask: (sessionId, id, input) => post('/tasks/update', { sessionId, id, ...input }),
	deleteTask: (sessionId, id) => post('/tasks/delete', { sessionId, id }),
	cancelTask: (sessionId, id) => post('/tasks/cancel', { sessionId, id }),
	retryTask: (sessionId, id) => post('/tasks/retry', { sessionId, id }),
	reorderTasks: (sessionId, ids) => post('/tasks/reorder', { sessionId, ids }),
	runTask: (sessionId, id) => post('/tasks/run', { sessionId, id }),
	adoptUnassigned: (sessionId) => post('/tasks/adopt', { sessionId }),
	archiveCompleted: (sessionId) => post('/tasks/archive', { sessionId }),
	unarchiveTask: (sessionId, id) => post('/tasks/unarchive', { sessionId, id }),
	clearArchived: (sessionId) => post('/tasks/archive/clear', { sessionId }),
	patchSettings: (sessionId, patch) => post('/settings', { sessionId, ...patch }),
};
		//#endregion

		//#region src/20-store.js
/**
 * Page state: one observable store.
 *
 * The queue itself is not stored here. It lives on the host, because that is
 * where the scheduler runs and where a restart must not lose it; the page keeps
 * a mirror it refreshes. Nothing in this module touches browser storage — the
 * page has no geometry of its own to remember, because the shell owns the layout
 * it is mounted into.
 *
 * The store also remembers **which session** its snapshot belongs to. The page
 * is mounted per session and a queue is per workspace, so a snapshot left over
 * from another session must never be rendered as if it were this one's.
 */

/** Create a minimal observable store. */
function createStore(initial) {
	let state = initial;
	const listeners = new Set();
	return {
		get: () => state,
		/**
		 * Merge a patch and notify every subscriber synchronously.
		 *
		 * Both call styles merge, and that is the whole point: when the callback
		 * form returned its object *as* the next state, a write that mentioned one
		 * field silently dropped every other one. That is not a subtle failure — a
		 * single keystroke in the composer reduced the store to `{ draft }`, which
		 * erased the loaded snapshot, and the page replaced itself with its loading
		 * state the moment the user started typing.
		 *
		 * @param {object | ((state: object) => object)} patch - fields to merge.
		 */
		set(patch) {
			const partial = typeof patch === 'function' ? patch(state) : patch;
			const next = { ...state, ...partial };
			let changed = false;
			for (const key of Object.keys(next)) {
				if (!Object.is(next[key], state[key])) {
					changed = true;
					break;
				}
			}
			if (!changed) return;
			state = next;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Subscribe a component to one store; `select` must return a stable value. */
function useStore(store, select = (value) => value) {
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.get()),
		() => select(store.get()),
	);
}

/** The page store. */
const uiStore = createStore({
	/** Which face of the page is showing. */
	view: 'queue',
	/** The last snapshot from the host, or null before the first read. */
	snapshot: null,
	/** The session that snapshot describes, so it is never shown for another. */
	snapshotSessionId: null,
	/** The last transport or host failure, or null. */
	error: null,
	/** The id of the task currently being mutated, so its buttons can disable. */
	busy: null,
	/** The composer's in-progress text, kept while the user switches faces. */
	draft: { title: '', prompt: '' },
	/** The id of the task being edited inline, or null. */
	editingId: null,
	/**
	 * The text of the inline edit in progress, or null when it is untouched.
	 *
	 * It lives here rather than in the card's own state for the same reason the
	 * composer's draft does: the page is remounted whenever the shell rebuilds the
	 * conversation view list, which a task starting a session is enough to cause.
	 * Local state would be thrown away by that remount while `editingId` survived
	 * it, so the editor would reopen holding the *old* text — looking exactly like
	 * the page had reset what the user was halfway through typing.
	 */
	editDraft: null,
	/** The settings form's uncommitted values, or null while it is untouched. */
	settingsDraft: null,
	/** Whether the archive-clear button is armed and waiting for a second click. */
	confirmClearArchive: false,
	/**
	 * Fields the Host normalized away on the last save, so the form can say what
	 * it refused instead of quietly reverting the control.
	 */
	refusedFields: [],
});

/**
 * Re-read the queue for one session from the host.
 *
 * Called after every mutation and on a slow poll while the page is mounted, so
 * the page shows the scheduler's decisions — a task being claimed at 18:00, a
 * run finishing at 02:00 — without the user having to reload.
 *
 * @param {string} sessionId - the session whose workspace to read.
 * @returns {Promise<void>} resolves when the read settles.
 */
async function refresh(sessionId) {
	try {
		const snapshot = await api.state(sessionId);
		uiStore.set({ snapshot, snapshotSessionId: sessionId, error: null });
	} catch (error) {
		uiStore.set({ error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Run one mutating call and refresh from its response.
 *
 * Every mutation returns a full snapshot, so the page never shows a stale queue
 * after a click — and a failed call leaves the last good snapshot in place while
 * surfacing the reason.
 *
 * @param {string} sessionId - the session whose workspace is being changed.
 * @param {string | null} taskId - the task being mutated, for the busy marker.
 * @param {() => Promise<object>} operation - the call to make.
 * @returns {Promise<boolean>} whether it succeeded.
 */
async function mutate(sessionId, taskId, operation) {
	uiStore.set({ busy: taskId ?? 'global', error: null });
	try {
		const result = await operation();
		if (result && result.state) uiStore.set({ snapshot: result.state, snapshotSessionId: sessionId });
		uiStore.set({ busy: null });
		return true;
	} catch (error) {
		uiStore.set({ busy: null, error: error instanceof Error ? error.message : String(error) });
		return false;
	}
}
		//#endregion

		//#region src/30-styles.js
/**
 * The page's whole stylesheet, as one owned `<style>` element.
 *
 * Every colour comes from the theme tokens (`--dsw-alias-*`), so the page
 * follows the app's light and dark themes without a single literal colour.
 *
 * The page is mounted into `conversation.view`, whose container the shell sizes
 * as `display: flex; flex-direction: column; flex: 1 1 0; min-height: 0;
 * overflow: hidden`. That contract decides the two rules below: the root is a
 * flex column that fills that box, and the body — not the root — is what
 * scrolls, because the parent hides its own overflow and a scroller anywhere
 * else would be clipped rather than scroll.
 */

const STYLE_TAG_ID = 'dsh-task-queue/page.css';

const STYLES = `
.tq-page {
	display: flex;
	flex-direction: column;
	flex: 1 1 0;
	min-height: 0;
	height: 100%;
	background: var(--dsw-alias-bg-base, #141414);
	color: var(--dsw-alias-label-primary, #eee);
	font-family: var(--dsw-font-family, inherit);
	font-size: 13px;
	line-height: 1.5;
}

.tq-page-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 20px;
	border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	flex: 0 0 auto;
	flex-wrap: wrap;
}
.tq-page-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 14px;
	font-weight: 600;
	white-space: nowrap;
}
.tq-page-spacer { flex: 1 1 auto; }
.tq-workspace {
	max-width: 32ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding: 1px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	color: var(--dsw-alias-label-secondary, #aaa);
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
}

.tq-section-title {
	margin: 4px 0 0;
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-secondary, #aaa);
}

.tq-tabs {
	display: inline-flex;
	gap: 2px;
	padding: 2px;
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
	flex: 0 0 auto;
}
.tq-tab {
	padding: 4px 12px;
	border: none;
	border-radius: calc(var(--dsw-radius-md, 10px) - 3px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #aaa);
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.tq-tab:hover { color: var(--dsw-alias-label-primary, #eee); }
.tq-tab-active {
	background: var(--dsw-alias-bg-base, #141414);
	color: var(--dsw-alias-label-primary, #eee);
	font-weight: 600;
}
.tq-tab {
	display: inline-flex;
	align-items: center;
	gap: 5px;
}
.tq-tab-count {
	min-width: 16px;
	padding: 0 4px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 26%, transparent);
	font-size: 10px;
	font-weight: 700;
	justify-content: center;
}

.tq-page-body {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 16px 20px 28px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.tq-page-inner {
	width: 100%;
	max-width: var(--dsh-chat-content-width, 780px);
	margin: 0 auto;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.tq-pill {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 2px 9px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	white-space: nowrap;
	border: 1px solid transparent;
}
.tq-pill-open {
	color: var(--dsw-alias-state-success-primary, #4ade80);
	background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 14%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 34%, transparent);
}
.tq-pill-closed {
	color: var(--dsw-alias-label-secondary, #aaa);
	background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 12%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 26%, transparent);
}
.tq-pill-off {
	color: var(--dsw-alias-state-warn-primary, #fbbf24);
	background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 14%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 34%, transparent);
}
.tq-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
	flex: 0 0 auto;
}

.tq-icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: 1px solid transparent;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #aaa);
	cursor: pointer;
	flex: 0 0 auto;
}
.tq-icon-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
	color: var(--dsw-alias-label-primary, #eee);
}
.tq-icon-btn:disabled { opacity: 0.4; cursor: default; }

.tq-note {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 9px 12px;
	border-radius: var(--dsw-radius-md, 10px);
	font-size: 12px;
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05));
	color: var(--dsw-alias-label-secondary, #aaa);
}
.tq-note-error {
	color: var(--dsw-alias-state-error-primary, #f87171);
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 12%, transparent);
}

.tq-field { display: flex; flex-direction: column; gap: 4px; }
.tq-label {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--dsw-alias-label-secondary, #aaa);
}
.tq-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); }

.tq-input,
.tq-textarea,
.tq-select {
	width: 100%;
	box-sizing: border-box;
	padding: 6px 9px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
	border-radius: var(--dsw-radius-sm, 6px);
	background: var(--dsw-alias-bg-layer-1, #1e1e1e);
	color: var(--dsw-alias-label-primary, #eee);
	font-family: inherit;
	font-size: 12px;
	resize: vertical;
}
.tq-input:focus,
.tq-textarea:focus,
.tq-select:focus {
	outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d8dff));
	outline-offset: -1px;
}
.tq-textarea { min-height: 68px; line-height: 1.55; }

.tq-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	padding: 5px 12px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-primary, #eee);
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.tq-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08)); }
.tq-btn:disabled { opacity: 0.45; cursor: default; }
.tq-btn-primary {
	background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d8dff));
	border-color: transparent;
	color: var(--dsw-alias-label-primary-foreground, #fff);
	font-weight: 600;
}
.tq-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d8dff)); }
.tq-btn-danger:hover { color: var(--dsw-alias-state-error-primary, #f87171); }
/* The one labelled card action: run this task by hand. */
.tq-btn-run {
	padding: 3px 10px;
	color: var(--dsw-alias-brand-primary, #4d8dff);
	border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 42%, transparent);
	font-weight: 600;
}
.tq-btn-run:hover {
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 16%, transparent);
}
.tq-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tq-row-end { justify-content: flex-end; }

.tq-card {
	border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04));
	padding: 10px 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.tq-card-running { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 55%, transparent); }
.tq-card-done { opacity: 0.72; }
.tq-card-failed { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 50%, transparent); }

.tq-card-head { display: flex; align-items: flex-start; gap: 8px; }

/* The task's place in the line, so execution order is readable at a glance
   rather than inferred from how far down the card sits. */
.tq-ordinal {
	flex: 0 0 auto;
	min-width: 2.2em;
	padding-top: 1px;
	font-variant-numeric: tabular-nums;
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-tertiary, #888);
}
.tq-card-title {
	flex: 1 1 auto;
	font-weight: 600;
	font-size: 13px;
	word-break: break-word;
}
.tq-card-body {
	font-size: 12px;
	color: var(--dsw-alias-label-secondary, #aaa);
	word-break: break-word;
	white-space: pre-wrap;
}
.tq-card-foot {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
}
.tq-card-foot .tq-row { margin-left: auto; }

.tq-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 1px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 600;
	flex: 0 0 auto;
}
.tq-badge-queued { color: var(--dsw-alias-label-secondary, #aaa); background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 16%, transparent); }
.tq-badge-running { color: var(--dsw-alias-brand-primary, #4d8dff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 18%, transparent); }
.tq-badge-done { color: var(--dsw-alias-state-success-primary, #4ade80); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 16%, transparent); }
.tq-badge-failed { color: var(--dsw-alias-state-error-primary, #f87171); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 16%, transparent); }
.tq-badge-cancelled { color: var(--dsw-alias-label-dimmed, #777); background: color-mix(in srgb, var(--dsw-alias-label-dimmed, #777) 16%, transparent); }

.tq-result {
	font-size: 12px;
	color: var(--dsw-alias-label-secondary, #aaa);
	background: var(--dsw-alias-bg-base, #141414);
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 8px 10px;
	max-height: 160px;
	overflow-y: auto;
	white-space: pre-wrap;
	word-break: break-word;
}
.tq-result-error { color: var(--dsw-alias-state-error-primary, #f87171); }

.tq-note .tq-btn { flex: 0 0 auto; margin-left: auto; }

.tq-empty {
	text-align: center;
	padding: 34px 12px;
	color: var(--dsw-alias-label-tertiary, #888);
	font-size: 12px;
}

.tq-settings { display: flex; flex-direction: column; gap: 14px; }
/* Says which settings are shared and which belong to this workspace. A quiet
   rule above it separates the note from the field it introduces without making
   either look like an error. */
.tq-scope-note {
	font-size: 12px;
	line-height: 1.5;
	color: var(--dsw-alias-text-secondary, #94a3b8);
	padding-top: 10px;
	border-top: 1px solid var(--dsw-alias-border-secondary, rgba(148, 163, 184, 0.22));
}
.tq-settings-group {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
}
.tq-settings-group > .tq-label { font-size: 12px; color: var(--dsw-alias-label-primary, #eee); }
.tq-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tq-window-row {
	display: grid;
	grid-template-columns: 7.5em auto 7.5em 1fr auto;
	align-items: center;
	gap: 8px;
}
.tq-window-dash { color: var(--dsw-alias-label-tertiary, #888); text-align: center; }
.tq-window-desc {
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.tq-toggle { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 12px; }
.tq-toggle input { margin: 2px 0 0; flex: 0 0 auto; }
.tq-toggle-text { display: flex; flex-direction: column; gap: 1px; }

/* Bulk actions sit above the list on both faces, and the gap below them is what
   keeps a destructive one clear of the first card's own controls — which is the
   one thing that must not be next to 清空归档. */
.tq-bulk { margin-top: 4px; }

.tq-btn-armed {
	color: var(--dsw-alias-state-error-primary, #f87171);
	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 55%, transparent);
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 12%, transparent);
	font-weight: 600;
}

.tq-hint-warn { color: var(--dsw-alias-state-warn-primary, #fbbf24); }

/* The settings footer sits outside the scroller, so the save button is never
   the thing that is off screen — which is exactly how a window setting ends up
   looking unsettable. */
.tq-page-foot {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	justify-content: flex-end;
	padding: 10px 20px;
	border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	background: var(--dsw-alias-bg-base, #141414);
}
.tq-page-foot .tq-hint { margin-right: auto; }
`;

/**
 * Add the stylesheet, once.
 * @returns {() => void} a disposer that removes it.
 */
function installStyles() {
	if (typeof document === 'undefined') return () => {};
	if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')) return () => {};
	const tag = document.createElement('style');
	tag.dataset.plugin = 'dsh-plugin-task-queue';
	tag.dataset.pluginCss = STYLE_TAG_ID;
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	return () => tag.remove();
}
		//#endregion

		//#region src/40-icons.js
/**
 * Inline SVG icons.
 *
 * The plugin ships its own glyphs rather than importing the app's icon set: a
 * third-party browser half must not `require` DSH client packages, because they
 * change without notice and a throwing import blanks the slot the plugin is
 * registered into. These are drawn on a 16px grid with `currentColor`, so they
 * inherit the theme wherever they are used.
 */

/**
 * Build one icon element.
 * @param {string} path - the SVG path data.
 * @param {number} [size] - pixel size.
 * @returns {object} a React element.
 */
function icon(path, size = 16) {
	return h(
		'svg',
		{
			width: size,
			height: size,
			viewBox: '0 0 16 16',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			strokeLinejoin: 'round',
			'aria-hidden': 'true',
			focusable: 'false',
		},
		h('path', { d: path }),
	);
}

/** The queue mark: a stack of rows. */
function IconQueue(props) {
	return h(
		'svg',
		{
			width: props?.size ?? 16,
			height: props?.size ?? 16,
			viewBox: '0 0 16 16',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			'aria-hidden': 'true',
			focusable: 'false',
		},
		h('path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h7' }),
	);
}

/** Close. */
function IconClose() {
	return icon('M4 4l8 8M12 4l-8 8');
}

/** Settings: a slider row. */
function IconSettings() {
	return icon('M2.5 4.5h4M9.5 4.5h4M2.5 11.5h4M9.5 11.5h4M6.5 2.8v3.4M11 9.8v3.4');
}

/** Back to the queue. */
function IconBack() {
	return icon('M9.5 3.5L5 8l4.5 4.5');
}

/** Run now. */
function IconPlay() {
	return icon('M5 3.2l7 4.8-7 4.8z');
}

/** Retry. */
function IconRetry() {
	return icon('M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5h-3');
}

/** Cancel: a slash through a circle. */
function IconCancel() {
	return icon('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM4.4 4.4l7.2 7.2');
}

/** Delete. */
function IconTrash() {
	return icon('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4');
}

/** Move up in the queue. */
function IconUp() {
	return icon('M8 12.5V4M4.5 7.5L8 4l3.5 3.5');
}

/** Move down in the queue. */
function IconDown() {
	return icon('M8 3.5V12M4.5 8.5L8 12l3.5-3.5');
}

/** Edit. */
function IconEdit() {
	return icon('M11.2 2.9l1.9 1.9-7.6 7.6-2.4.5.5-2.4z');
}

/** Check. */
function IconCheck() {
	return icon('M3.5 8.5l3 3 6-6.5');
}

/** The resize grip. */
function IconGrip() {
	return icon('M13 6L6 13M13 10l-3 3', 14);
}

/** Plus. */
function IconPlus() {
	return icon('M8 3.5v9M3.5 8h9');
}
		//#endregion

		//#region src/50-cards.js
/**
 * The task card and the composer that adds one.
 *
 * One task is one card, and the card is the whole lifecycle in one place: what
 * the task says, what the queue decided about it, what happened when it ran, and
 * the buttons that make the next thing happen. Finished tasks stay in the list
 * rather than disappearing, because the morning question is "what did it do
 * overnight?" and a list that empties itself cannot answer it.
 *
 * The one action that is not an icon is **执行**. Running a task by hand is the
 * thing a user reaches for when a task is sitting there and they want it now —
 * and an icon-only control in a row of five other icons is a control they have to
 * learn. It is a labelled button, on every card that can still run.
 *
 * Every card belongs to a workspace, and the page only ever renders one
 * workspace's cards, so the mutations need nothing but the session the page was
 * opened from.
 */

/** The badge for one status. */
function StatusBadge({ t, status }) {
	return h('span', { className: 'tq-badge tq-badge-' + status }, t('status.' + status));
}

/**
 * The composer: an instruction and a button.
 *
 * There is no title to write. A card headings itself from the instruction's first
 * line, so a title field only ever asked the user to name what they had already
 * written — and then to keep the two in step.
 */
function TaskComposer({ t, sessionId }) {
	const draft = useStore(uiStore, (state) => state.draft);
	const busy = useStore(uiStore, (state) => state.busy);
	const submitting = busy === 'global';
	const canSubmit = draft.prompt.trim().length > 0 && !submitting;

	/** Patch the persisted draft, so switching faces does not lose typing. */
	const editDraft = (patch) => {
		uiStore.set((state) => ({ draft: { ...state.draft, ...patch } }));
	};

	/** Add the draft to the queue and clear the form. */
	const submit = async () => {
		if (!canSubmit) return;
		const ok = await mutate(sessionId, 'global', () => api.createTask(sessionId, { prompt: draft.prompt.trim() }));
		if (ok) uiStore.set({ draft: { prompt: '' } });
	};

	return h(
		'div',
		{ className: 'tq-settings-group' },
		h(
			'div',
			{ className: 'tq-field' },
			h('label', { className: 'tq-label', htmlFor: 'tq-new-prompt' }, t('compose.prompt')),
			h('textarea', {
				id: 'tq-new-prompt',
				className: 'tq-textarea tq-textarea-new',
				value: draft.prompt,
				placeholder: t('compose.promptPlaceholder'),
				onChange: (event) => editDraft({ prompt: event.target.value }),
				onKeyDown: (event) => {
					// Ctrl/Cmd+Enter submits; a bare Enter must stay a newline,
					// because a task instruction is usually several lines.
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void submit();
					}
				},
			}),
		),
		h(
			'div',
			{ className: 'tq-row-end tq-row' },
			h('span', { className: 'tq-hint' }, t('compose.hint')),
			h(
				'button',
				{ type: 'button', className: 'tq-btn tq-btn-primary', disabled: !canSubmit, onClick: () => void submit() },
				IconPlus(),
				t('compose.add'),
			),
		),
	);
}

/**
 * A bulk action that acts on every finished task at once.
 *
 * The archive button is safe — archiving is reversible — so it is one click. The
 * clear button deletes, so it arms first and says what it will do; "one click" a
 * few pixels from the search field is not a good enough reason to lose history.
 */
function BulkAction({ t, label, confirmLabel, count, armed, disabled, onClick }) {
	return h(
		'button',
		{
			type: 'button',
			className: 'tq-btn' + (armed ? ' tq-btn-danger tq-btn-armed' : ''),
			disabled: disabled || count === 0,
			onClick,
		},
		// The label and the count are separate children so the label stays an exact
		// string — findable by assistive technology and by anything else that looks
		// for the action by name.
		...(armed ? [confirmLabel] : [label, h('span', { className: 'tq-bulk-count' }, String(count))]),
	);
}

/**
 * One archived task, as a card.
 *
 * Archive is a filing decision, so the card is deliberately inert: no running,
 * no reordering, no editing. The result is what you came here to read, and the
 * one action is the way back out of the archive.
 */
function ArchivedCard({ t, sessionId, task }) {
	const busy = useStore(uiStore, (state) => state.busy === task.id);
	const parts = splitPrompt(task.prompt);
	return h(
		'div',
		{ className: 'tq-card tq-card-' + task.status },
		h(
			'div',
			{ className: 'tq-card-head' },
			h('div', { className: 'tq-card-title' }, excerpt(parts.heading, 160)),
			h(StatusBadge, { t, status: task.status }),
		),
		parts.rest.length > 0 ? h('div', { className: 'tq-card-body' }, excerpt(parts.rest, 320)) : null,
		task.error ? h('div', { className: 'tq-result tq-result-error' }, task.error) : null,
		!task.error && task.result ? h('div', { className: 'tq-result' }, task.result) : null,
		h(
			'div',
			{ className: 'tq-card-foot' },
			h('span', null, stamp(task.createdAt)),
			task.finishedAt ? h('span', null, t('card.finishedAt', { time: stamp(task.finishedAt) })) : null,
			task.sessionId ? h('span', { title: task.sessionId }, t('card.session', { id: shortId(task.sessionId) })) : null,
			h(
				'div',
				{ className: 'tq-row' },
				h(
					'button',
					{
						type: 'button',
						className: 'tq-btn',
						title: t('archive.restoreHint'),
						disabled: busy,
						onClick: () => void mutate(sessionId, task.id, () => api.unarchiveTask(sessionId, task.id)),
					},
					IconRetry(),
					t('archive.restore'),
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-icon-btn tq-btn-danger',
						title: t('card.delete'),
						'aria-label': t('card.delete'),
						disabled: busy,
						onClick: () => void mutate(sessionId, task.id, () => api.deleteTask(sessionId, task.id)),
					},
					IconTrash(),
				),
			),
		),
	);
}

/**
 * One task, as a card.
 *
 * `isFirst` and `isLast` only disable the move buttons; the host owns the real
 * order, and the page never guesses it.
 */
function TaskCard({ t, sessionId, task, order, ordinal, isFirst, isLast }) {
	const editing = useStore(uiStore, (state) => state.editingId === task.id);
	const busy = useStore(uiStore, (state) => state.busy === task.id);
	// The draft is the store's, not this component's: a remount must not be able
	// to discard a half-finished edit. `null` means "not touched yet", so the
	// field falls back to the task's own text — which is also what makes an
	// externally-changed task show the new text rather than a stale copy.
	//
	// Opening the editor sets it back to null, so each edit starts from the task
	// as it stands. There is deliberately no effect re-seeding it afterwards: a
	// poll replaces the snapshot while the user is typing, and re-seeding on that
	// would overwrite the very keystrokes this is here to protect.
	const editDraft = useStore(uiStore, (state) => state.editDraft);
	const draftText = editDraft === null ? task.prompt : editDraft;
	const setDraftText = (value) => uiStore.set({ editDraft: value });

	const parts = splitPrompt(task.prompt);

	const runnable = task.status !== 'running';
	const movers = task.status === 'queued';

	/** Move this card one slot up or down by swapping order with its neighbour. */
	const move = async (direction, ids) => {
		const index = ids.indexOf(task.id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= ids.length) return;
		const next = ids.slice();
		next[index] = next[target];
		next[target] = task.id;
		await mutate(sessionId, null, () => api.reorderTasks(sessionId, next));
	};

	const stopEditing = () => uiStore.set({ editingId: null, editDraft: null });

	return h(
		'div',
		{ className: 'tq-card tq-card-' + task.status },
		editing
			? h(
					'div',
					{ className: 'tq-field' },
					h('textarea', {
						className: 'tq-textarea',
						value: draftText,
						'aria-label': t('card.editPrompt'),
						onChange: (event) => setDraftText(event.target.value),
					}),
				)
			: h(
					'div',
					{ className: 'tq-card-head' },
					// The ordinal is the task's place in the line, so the execution
					// order is readable without inferring it from vertical position.
					h('span', { className: 'tq-ordinal' }, '#' + ordinal),
					h('div', { className: 'tq-card-title' }, excerpt(parts.heading, 160)),
					h(StatusBadge, { t, status: task.status }),
				),

		editing
			? h(
					'div',
					{ className: 'tq-row tq-row-end' },
					h('button', { type: 'button', className: 'tq-btn', onClick: stopEditing }, t('card.cancelEdit')),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-btn tq-btn-primary',
							disabled: draftText.trim().length === 0,
							onClick: async () => {
								const ok = await mutate(sessionId, task.id, () =>
									api.updateTask(sessionId, task.id, { prompt: draftText }),
								);
								if (ok) stopEditing();
							},
						},
						IconCheck(),
						t('card.save'),
					),
				)
			: parts.rest.length > 0
				? h('div', { className: 'tq-card-body' }, excerpt(parts.rest, 320))
				: null,

		!editing && task.error ? h('div', { className: 'tq-result tq-result-error' }, task.error) : null,
		!editing && !task.error && task.result ? h('div', { className: 'tq-result' }, task.result) : null,

		h(
			'div',
			{ className: 'tq-card-foot' },
			h('span', null, stamp(task.createdAt)),
			task.attempts > 0 ? h('span', null, t('card.attempts', { count: task.attempts })) : null,
			task.sessionId ? h('span', { title: task.sessionId }, t('card.session', { id: shortId(task.sessionId) })) : null,
			editing
				? null
				: h(
						'div',
						{ className: 'tq-row' },
						// The one labelled action: run it by hand, right now.
						runnable
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-btn tq-btn-run',
										title: t('card.runNowHint'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.runTask(sessionId, task.id)),
									},
									IconPlay(),
									t('card.runNow'),
								)
							: null,
						movers && !isFirst
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.moveUp'),
										'aria-label': t('card.moveUp'),
										disabled: busy,
										onClick: () => void move(-1, order),
									},
									IconUp(),
								)
							: null,
						movers && !isLast
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.moveDown'),
										'aria-label': t('card.moveDown'),
										disabled: busy,
										onClick: () => void move(1, order),
									},
									IconDown(),
								)
							: null,
						h(
							'button',
							{
								type: 'button',
								className: 'tq-icon-btn',
								title: t('card.edit'),
								'aria-label': t('card.edit'),
								disabled: busy || task.status === 'running',
								onClick: () => uiStore.set({ editingId: task.id, editDraft: null }),
							},
							IconEdit(),
						),
						task.status === 'failed' || task.status === 'done' || task.status === 'cancelled'
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.retry'),
										'aria-label': t('card.retry'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.retryTask(sessionId, task.id)),
									},
									IconRetry(),
								)
							: null,
						task.status === 'queued'
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.cancel'),
										'aria-label': t('card.cancel'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.cancelTask(sessionId, task.id)),
									},
									IconCancel(),
								)
							: null,
						h(
							'button',
							{
								type: 'button',
								className: 'tq-icon-btn tq-btn-danger',
								title: t('card.delete'),
								'aria-label': t('card.delete'),
								disabled: busy,
								onClick: () => void mutate(sessionId, task.id, () => api.deleteTask(sessionId, task.id)),
							},
							IconTrash(),
						),
					),
		),
	);
}
		//#endregion

		//#region src/60-page.js
/**
 * The task queue page, mounted beside 对话 and 轨迹 in `conversation.view`.
 *
 * It is a full page rather than a floating panel for a reason that turned out to
 * be a bug report: a floating panel needs a drag handler on its header, and a
 * drag handler that captures the pointer on `pointerdown` also swallows the
 * `click` of every button inside that header. The page has no drag, so its
 * controls simply work.
 *
 * The page is a **workspace's** page. It is mounted per session, the host
 * resolves that session to a workspace, and everything shown — the queue, the
 * hours, the concurrency limit — belongs to that workspace alone. Nothing here
 * asks the user which workspace they meant, because the answer is wherever they
 * opened it.
 */

/** How many minutes since midnight an `HH:mm` names, or -1 when unparseable. */
function toMinutes(value) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
	if (match === null) return -1;
	return Number(match[1]) * 60 + Number(match[2]);
}

/** One window rendered as a phrase, with "next day" when it wraps midnight. */
function describeWindow(window, t) {
	return toMinutes(window.start) > toMinutes(window.end)
		? t('window.overnight', { start: window.start, end: window.end })
		: t('window.sameDay', { start: window.start, end: window.end });
}

/** Every window as one line, or the two distinct kinds of "nothing scheduled". */
function describeWindows(settings, t) {
	const windows = settings.windows ?? [];
	if (windows.length === 0) return t('window.none');
	return windows.map((window) => describeWindow(window, t)).join(' · ');
}

/** The status pill plus the sentence beside it. */
function describeQueueStatus(t, snapshot) {
	const settings = snapshot.settings;
	const runtime = snapshot.runtime;
	const running = snapshot.tasks.filter((task) => task.status === 'running').length;
	const queued = snapshot.tasks.filter((task) => task.status === 'queued').length;
	const windows = settings.windows ?? [];

	if (!settings.enabled) {
		return {
			pill: h('span', { className: 'tq-pill tq-pill-off' }, h('span', { className: 'tq-dot' }), t('status.paused')),
			note: t('status.pausedNote'),
		};
	}
	if (windows.length === 0) {
		return {
			pill: h('span', { className: 'tq-pill tq-pill-off' }, h('span', { className: 'tq-dot' }), t('status.noWindow')),
			note: t('status.noWindowNote'),
		};
	}
	if (runtime.windowOpen) {
		const until = runtime.nextWindowChangeAt;
		// A queue waiting out its execution interval looks exactly like a queue
		// that has stopped working, so the wait is named rather than left to be
		// inferred from the clock.
		const waiting = runtime.cooldownUntil === null ? 0 : Math.max(0, runtime.cooldownUntil - snapshot.now);
		const note =
			waiting > 0 && queued > 0
				? t('status.cooldownNote', {
						amount: humanDuration(waiting, t),
						queued,
						minutes: settings.cooldownMinutes,
					})
				: t('status.openNote', { running, queued });
		return {
			pill: h('span', { className: 'tq-pill tq-pill-open' }, h('span', { className: 'tq-dot' }), t('status.open')),
			note:
				note +
				(waiting > 0 && queued > 0
					? ''
					: until === null
						? ''
						: ' · ' + t('status.closesIn', { amount: humanDuration(until - snapshot.now, t) })),
		};
	}
	const until = runtime.nextWindowChangeAt;
	return {
		pill: h('span', { className: 'tq-pill tq-pill-closed' }, h('span', { className: 'tq-dot' }), t('status.closed')),
		note:
			t('status.closedNote', { queued }) +
			(until === null
				? ''
				: ' · ' +
					t('status.opensAt', {
						time: clockIn(until, settings.timeZone),
						amount: humanDuration(until - snapshot.now, t),
					})),
	};
}

/** The queue face: status, composer, and the cards. */
function QueueView({ t, sessionId, snapshot }) {
	const tasks = snapshot.tasks;
	const order = tasks.map((task) => task.id);
	const adoptable = snapshot.unassignedCount ?? 0;
	const done = tasks.filter((task) => task.status === 'done').length;
	const busy = useStore(uiStore, (state) => state.busy);

	return h(
		React.Fragment,
		null,
		h('div', { className: 'tq-note' }, describeQueueStatus(t, snapshot).note),
		adoptable > 0
			? h(
					'div',
					{ className: 'tq-note' },
					h('span', null, t('queue.unassigned', { count: adoptable })),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-btn',
							onClick: () => void mutate(sessionId, 'global', () => api.adoptUnassigned(sessionId)),
						},
						t('queue.adopt'),
					),
				)
			: null,
		h('h3', { className: 'tq-section-title' }, t('queue.addTitle')),
		h(TaskComposer, { t, sessionId }),
		// The bulk action sits *above* the list, not below it. It acts on the list
		// as a whole, and a control that only appears after the last card is a
		// control you have to scroll to find — which is exactly backwards on a
		// queue that is meant to be read top-down.
		tasks.length === 0
			? null
			: h(
					'div',
					{ className: 'tq-row tq-bulk' },
					h(BulkAction, {
						t,
						label: t('queue.archiveDone'),
						confirmLabel: t('queue.archiveDone'),
						count: done,
						armed: false,
						disabled: busy === 'global',
						onClick: () => void mutate(sessionId, 'global', () => api.archiveCompleted(sessionId)),
					}),
				),
		tasks.length === 0
			? h('div', { className: 'tq-empty' }, t('queue.empty'))
			: tasks.map((task, index) =>
					h(TaskCard, {
						key: task.id,
						t,
						sessionId,
						task,
						order,
						ordinal: index + 1,
						isFirst: index === 0,
						isLast: index === tasks.length - 1,
					}),
				),
	);
}

/**
 * The settings face.
 *
 * Edits are held in a draft and applied by the footer's save button. That is
 * deliberate: a time field fires a change for every keystroke, and patching the
 * host on each one would make the queue briefly hold a window the user never
 * meant — say `1` while typing `18:00` — while the time-zone field would fight
 * the user on every character, because half a zone name is not a zone.
 *
 * The workspace and its directory are deliberately absent. A task belongs to the
 * workspace the page was opened from, so there is nothing to choose.
 */
function SettingsView({ t, snapshot, values, set }) {
	/** The turn every field needs: a number input yields a string. */
	const numeric = (raw, fallback) => {
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	};

	const windows = values.windows ?? [];

	/** Replace one window's field. */
	const setWindow = (index, patch) =>
		set({ windows: windows.map((window, at) => (at === index ? { ...window, ...patch } : window)) });

	/** Remove one window. An empty list is a real answer: schedule nothing. */
	const removeWindow = (index) => set({ windows: windows.filter((_, at) => at !== index) });

	/** Append a window. A daytime slot, so adding one is visibly different. */
	const addWindow = () => set({ windows: [...windows, { start: '09:00', end: '18:00' }] });

	return h(
		'div',
		{ className: 'tq-settings' },
		// Which of these belong to the workspace and which are shared is the first
		// thing the form has to say: every field looks alike, and guessing wrong
		// means expecting a change to affect one queue when it affects all of them.
		h('div', { className: 'tq-scope-note' }, t('settings.sharedNote')),
		h(
			'div',
			{ className: 'tq-settings-group' },
			h('div', { className: 'tq-label' }, t('settings.windowGroup')),
			h('span', { className: 'tq-hint' }, t('settings.windowGroupHint')),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.enabled,
					onChange: (event) => set({ enabled: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.enabled')),
					h('span', { className: 'tq-hint' }, t('settings.enabledHint')),
				),
			),
			windows.map((window, index) =>
				h(
					'div',
					{ className: 'tq-window-row', key: String(index) },
					h('input', {
						className: 'tq-input',
						type: 'time',
						value: window.start,
						'aria-label': t('settings.windowStart', { index: index + 1 }),
						onChange: (event) => setWindow(index, { start: event.target.value }),
					}),
					h('span', { className: 'tq-window-dash' }, '～'),
					h('input', {
						className: 'tq-input',
						type: 'time',
						value: window.end,
						'aria-label': t('settings.windowEnd', { index: index + 1 }),
						onChange: (event) => setWindow(index, { end: event.target.value }),
					}),
					h('span', { className: 'tq-window-desc' }, describeWindow(window, t)),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-icon-btn tq-btn-danger',
							title: t('settings.removeWindow', { index: index + 1 }),
							'aria-label': t('settings.removeWindow', { index: index + 1 }),
							onClick: () => removeWindow(index),
						},
						IconTrash(),
					),
				),
			),
			windows.length === 0 ? h('span', { className: 'tq-hint' }, t('settings.windowEmpty')) : null,
			h(
				'div',
				{ className: 'tq-row' },
				h('button', { type: 'button', className: 'tq-btn', onClick: addWindow }, IconPlus(), t('settings.addWindow')),
			),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-tz' }, t('settings.timeZone')),
				h('input', {
					id: 'tq-tz',
					className: 'tq-input',
					type: 'text',
					value: values.timeZone,
					placeholder: 'Asia/Shanghai',
					onChange: (event) => set({ timeZone: event.target.value }),
				}),
				h('span', { className: 'tq-hint' }, t('settings.timeZoneHint', { zone: browserZone() })),
			),
			h('span', { className: 'tq-hint' }, t('settings.windowPreview', { window: describeWindows(values, t) })),
		),

		h(
			'div',
			{ className: 'tq-settings-group' },
			h('div', { className: 'tq-label' }, t('settings.execGroup')),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.autoApprove,
					onChange: (event) => set({ autoApprove: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.autoApprove')),
					h('span', { className: 'tq-hint' }, t('settings.autoApproveHint')),
				),
			),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-target' }, t('settings.targetMode')),
				h(
					'select',
					{
						id: 'tq-target',
						className: 'tq-select',
						value: values.targetMode,
						onChange: (event) => set({ targetMode: event.target.value }),
					},
					h('option', { value: 'shared' }, t('settings.targetShared')),
					h('option', { value: 'fresh' }, t('settings.targetFresh')),
				),
				h('span', { className: 'tq-hint' }, t('settings.targetHint')),
			),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.compactBeforeTask,
					onChange: (event) => set({ compactBeforeTask: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.compact')),
					h('span', { className: 'tq-hint' }, t('settings.compactHint')),
				),
			),
			// The one per-workspace setting, marked off from the shared ones above it
			// so the page says which is which rather than leaving it to be guessed.
			h('div', { className: 'tq-scope-note' }, t('settings.perWorkspaceNote')),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-cooldown' }, t('settings.cooldown')),
				h('input', {
					id: 'tq-cooldown',
					className: 'tq-input',
					type: 'number',
					min: 0,
					max: 1440,
					step: 5,
					value: values.cooldownMinutes,
					onChange: (event) => set({ cooldownMinutes: numeric(event.target.value, 0) }),
				}),
				h('span', { className: 'tq-hint' }, t('settings.cooldownHint')),
			),
			h(
				'div',
				{ className: 'tq-grid-2' },
				h(
					'div',
					{ className: 'tq-field' },
					h('label', { className: 'tq-label', htmlFor: 'tq-timeout' }, t('settings.timeout')),
					h('input', {
						id: 'tq-timeout',
						className: 'tq-input',
						type: 'number',
						min: 1,
						max: 1440,
						value: values.taskTimeoutMinutes,
						onChange: (event) => set({ taskTimeoutMinutes: numeric(event.target.value, 360) }),
					}),
				),
			),
		),
	);
}

/** The archive face: what was filed away, and the one button that empties it. */
function ArchiveView({ t, sessionId, snapshot }) {
	const archived = snapshot.archived ?? [];
	const armed = useStore(uiStore, (state) => state.confirmClearArchive);
	const busy = useStore(uiStore, (state) => state.busy);

	return h(
		React.Fragment,
		null,
		// Above the list, matching the queue face's bulk action. It is the same
		// kind of control — one that acts on everything below it — so it sits in
		// the same place on both faces rather than moving around between them.
		archived.length === 0
			? null
			: h(
					'div',
					{ className: 'tq-row tq-bulk' },
					armed ? h('span', { className: 'tq-hint' }, t('archive.clearWarning')) : null,
					h(BulkAction, {
						t,
						label: t('archive.clear'),
						confirmLabel: t('archive.clearConfirm'),
						count: archived.length,
						armed,
						disabled: busy === 'global',
						onClick: async () => {
							if (!armed) {
								uiStore.set({ confirmClearArchive: true });
								return;
							}
							const ok = await mutate(sessionId, 'global', () => api.clearArchived(sessionId));
							uiStore.set({ confirmClearArchive: false });
							if (!ok) uiStore.set({ error: t('archive.clearFailed') });
						},
					}),
				),
		archived.length === 0
			? h('div', { className: 'tq-empty' }, t('archive.empty'))
			: archived.map((task) => h(ArchivedCard, { key: task.id, t, sessionId, task })),
	);
}

/** The browser's own zone, offered as a hint when the field is empty or wrong. */
function browserZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * The fields the form owns, as one patch.
 *
 * Only these are sent, so a setting the form does not render can never be
 * cleared by saving. They must also be exactly the fields the Host knows: a key
 * this side invents is dropped by the Host's sanitizer, and the save then reports
 * it as refused — which is how a removed setting left behind in this list turns
 * into a complaint on screen rather than a silent no-op.
 *
 * `test/client.test.mjs` checks this list against the Host's defaults.
 *
 * @param {object} values - the form's current values.
 * @returns {object} the patch.
 */
function settingsPatch(values) {
	return {
		enabled: values.enabled,
		windows: values.windows,
		timeZone: values.timeZone,
		autoApprove: values.autoApprove,
		targetMode: values.targetMode,
		taskTimeoutMinutes: values.taskTimeoutMinutes,
		cooldownMinutes: values.cooldownMinutes,
		compactBeforeTask: values.compactBeforeTask,
	};
}

/** The settings footer: the only place a settings change is committed. */
function SettingsFooter({ t, sessionId, values, dirty, refused, onDiscard }) {
	return h(
		'div',
		{ className: 'tq-page-foot' },
		dirty ? h('span', { className: 'tq-hint' }, t('settings.unsaved')) : null,
		refused.length > 0
			? h('span', { className: 'tq-hint tq-hint-warn' }, t('settings.refused', { fields: refused.join('、') }))
			: null,
		h(
			'button',
			{ type: 'button', className: 'tq-btn', disabled: !dirty, onClick: onDiscard },
			t('settings.discard'),
		),
		h(
			'button',
			{
				type: 'button',
				className: 'tq-btn tq-btn-primary',
				disabled: !dirty,
				onClick: async () => {
					const patch = settingsPatch(values);
					const ok = await mutate(sessionId, 'global', () => api.patchSettings(sessionId, patch));
					if (!ok) return;
					// The Host is the authority: it repairs what it cannot use. Diffing the
					// reply against what was sent is what turns "I clicked save and it went
					// back" into a sentence naming the field it refused — otherwise a
					// setting the running Host is too old to know about reverts in silence.
					const applied = uiStore.get().snapshot?.settings ?? {};
					const refusedFields = Object.keys(patch).filter(
						(key) => JSON.stringify(applied[key]) !== JSON.stringify(patch[key]),
					);
					uiStore.set({ settingsDraft: null, refusedFields });
				},
			},
			IconCheck(),
			t('settings.save'),
		),
	);
}

/**
 * The page root: header, the active face, and the settings footer.
 *
 * @param {object} props - `t` from the locale namespace, `sessionId` from the
 *   slot's inject.
 */
function TaskQueuePage({ t, sessionId }) {
	const view = useStore(uiStore, (state) => state.view);
	const stored = useStore(uiStore, (state) => state.snapshot);
	const storedSessionId = useStore(uiStore, (state) => state.snapshotSessionId);
	const error = useStore(uiStore, (state) => state.error);
	const settingsDraft = useStore(uiStore, (state) => state.settingsDraft);
	const refusedFields = useStore(uiStore, (state) => state.refusedFields);

	// The shell mounts one page per session and remounts it when the session
	// changes; this effect re-reads on that change and polls while the page is
	// actually on screen, which is the only time anyone is looking.
	useEffect(() => {
		void refresh(sessionId);
		const timer = window.setInterval(() => void refresh(sessionId), 5000);
		return () => window.clearInterval(timer);
	}, [sessionId]);

	// A snapshot from another session is not this session's queue.
	const snapshot = storedSessionId === sessionId ? stored : null;
	const workspace = snapshot?.workspace ?? null;
	const values = settingsDraft ?? snapshot?.settings ?? null;
	const dirty =
		settingsDraft !== null && snapshot !== null && JSON.stringify(values) !== JSON.stringify(snapshot.settings);

	/** Patch the settings draft, seeding it from the host on first edit. */
	const set = (patch) => {
		uiStore.set({ settingsDraft: { ...(settingsDraft ?? snapshot.settings), ...patch } });
	};

	const status = snapshot === null || workspace === null ? null : describeQueueStatus(t, snapshot);
	const archivedCount = snapshot?.archived?.length ?? 0;

	return h(
		'div',
		{ className: 'tq-page' },
		h(
			'div',
			{ className: 'tq-page-head' },
			h(
				'div',
				{ className: 'tq-page-title' },
				IconQueue(),
				t('page.title'),
				workspace === null ? null : h('span', { className: 'tq-workspace' }, workspace.title || workspace.path),
				status === null ? null : status.pill,
			),
			h('div', { className: 'tq-page-spacer' }),
			h(
				'div',
				{ className: 'tq-tabs' },
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'queue' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'queue',
						onClick: () => uiStore.set({ view: 'queue', editingId: null, editDraft: null }),
					},
					t('page.tabQueue'),
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'archive' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'archive',
						onClick: () => uiStore.set({ view: 'archive', editingId: null, editDraft: null, confirmClearArchive: false }),
					},
					t('page.tabArchive'),
					archivedCount > 0 ? h('span', { className: 'tq-tab-count' }, String(archivedCount)) : null,
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'settings' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'settings',
						onClick: () => uiStore.set({ view: 'settings', editingId: null, editDraft: null, refusedFields: [] }),
					},
					t('page.tabSettings'),
				),
			),
		),
		h(
			'div',
			{ className: 'tq-page-body' },
			h(
				'div',
				{ className: 'tq-page-inner' },
				error !== null ? h('div', { className: 'tq-note tq-note-error' }, error) : null,
				snapshot === null
					? h('div', { className: 'tq-empty' }, t('page.loading'))
					: workspace === null
						? h('div', { className: 'tq-note tq-note-error' }, t('page.noWorkspace'))
						: view === 'settings'
							? h(SettingsView, { t, snapshot, values, set })
							: view === 'archive'
								? h(ArchiveView, { t, sessionId, snapshot })
								: h(QueueView, { t, sessionId, snapshot }),
			),
		),
		view === 'settings' && snapshot !== null && values !== null
			? h(SettingsFooter, {
					t,
					sessionId,
					values,
					dirty,
					refused: refusedFields,
					onDiscard: () => uiStore.set({ settingsDraft: null, refusedFields: [] }),
				})
			: null,
	);
}
		//#endregion

		//#region src/90-plugin.js
/**
 * Plugin entry: dictionaries, the stylesheet, and the view registration.
 *
 * Registration layout: one entry in `conversation.view`, the session-scoped list
 * the shell renders one at a time. It already holds `chat` (order 0) and
 * `trajectory` (order 10), so this takes a fresh id at order 20 and sits third —
 * beside them rather than in either of their cells.
 *
 * Everything the page shows comes from the host half over one HTTP route, and
 * the page re-reads it on a slow poll. The queue's truth — what is queued, what
 * is running, what the window is — lives on the host, because a browser tab is
 * not a scheduler.
 */

const NS = 'taskQueue';

/**
 * The view id, which is also the tab key the shell remembers per session.
 *
 * It must not collide with a shipped view: reusing `chat` or `trajectory` would
 * take over that cell and replace the built-in page instead of sitting beside it.
 */
const VIEW_ID = 'task-queue';

/** Simplified Chinese dictionary — the key-set source of truth. */
const zh = {
	'view.label': '任务',
	'page.title': '任务队列',
	'page.tabQueue': '队列',
	'page.tabSettings': '设置',
	'page.tabArchive': '归档',
	'page.loading': '正在读取队列…',
	'page.noWorkspace': '当前会话没有归属任何工作区，因此没有队列。先把它放进一个工作区，任务才知道该在哪里执行。',

	'status.open': '执行中',
	'status.closed': '时段外',
	'status.paused': '已暂停',
	'status.pausedNote': '队列已暂停：任务会一直排队，直到你重新启用。',
	'status.noWindow': '未设时段',
	'status.noWindowNote': '这个工作区还没有设置执行时段，任务只会排队，不会自动执行。到「设置」里加一个时段。',
	'status.openNote': '正在执行时段内 · 运行中 {running} · 排队 {queued}',
	'status.closesIn': '{amount}后进入时段外',
	'status.closedNote': '当前时段外，{queued} 个任务在排队',
	'status.opensAt': '将于 {time} 开始（{amount}）',
	'status.cooldownNote': '执行间隔中：{amount}后开始下一个任务（排队 {queued} 个，间隔 {minutes} 分钟）',

	'status.queued': '排队中',
	'status.running': '执行中',
	'status.done': '已完成',
	'status.failed': '失败',
	'status.cancelled': '已取消',

	'window.overnight': '{start} ～ 次日 {end}',
	'window.sameDay': '{start} ～ {end}',
	'window.none': '（没有时段）',

	'duration.days': '{count} 天',
	'duration.hours': '{count} 小时',
	'duration.minutes': '{count} 分钟',
	'duration.lessThanMinute': '不到 1 分钟',
	'duration.until': '{amount}后',
	'duration.since': '{amount}前',

	'compose.title': '标题',
	'compose.titlePlaceholder': '一句话说明这个任务（可留空，取正文首行）',
	'compose.prompt': '任务内容',
	'compose.promptPlaceholder': '写给 AI 的指令，例如：把 src 下所有 console.log 清掉并跑一遍测试…',
	'compose.hint': 'Ctrl/⌘ + Enter 快速加入',
	'compose.add': '加入队列',

	'queue.empty': '队列是空的。在上面写一条任务，到点后会由 AI 自动执行。',
	'archive.empty': '归档是空的。已完成的任务归档后会留在这里。',
	'archive.restore': '移回队列',
	'archive.restoreHint': '把它移回任务列表',
	'archive.clear': '清空归档',
	'archive.clearConfirm': '确认清空？',
	'archive.clearWarning': '清空后无法恢复。',
	'archive.clearFailed': '清空归档失败，请重试。',
	'queue.addTitle': '新建任务',
	'queue.archiveDone': '归档已完成',
	'queue.unassigned': '有 {count} 个旧任务没有归属工作区。',
	'queue.adopt': '归入当前工作区',

	'card.editTitle': '任务标题',
	'card.editPrompt': '任务内容',
	'card.cancelEdit': '取消',
	'card.save': '保存',
	'card.attempts': '第 {count} 次',
	'card.session': '会话 {id}',
	'card.moveUp': '上移一位',
	'card.moveDown': '下移一位',
	'card.edit': '编辑',
	'card.runNow': '执行',
	'card.runNowHint': '立即执行这个任务，忽略执行时段',
	'card.retry': '重新排队',
	'card.cancel': '取消任务',
	'card.delete': '删除',
	'card.finishedAt': '完成于 {time}',

	'settings.windowGroup': '执行时段',
	'settings.windowGroupHint': '可以有多个时段，任意一个到点都会开始执行。开始时间晚于结束时间表示跨到第二天。',
	'settings.sharedNote': '上面这些设置对所有工作区生效，是整套队列共用的。',
	'settings.perWorkspaceNote': '下面这一项按工作区分别设置，只影响当前工作区。',
	'settings.windowStart': '第 {index} 个时段的开始时间',
	'settings.windowEnd': '第 {index} 个时段的结束时间',
	'settings.addWindow': '添加时段',
	'settings.removeWindow': '删除第 {index} 个时段',
	'settings.windowEmpty': '没有时段时，任务只会排队，不会自动执行。',
	'settings.enabled': '启用自动执行',
	'settings.enabledHint': '关闭后只创建任务，任何时间都不会自动执行。',
	'settings.start': '开始时间',
	'settings.end': '结束时间',
	'settings.timeZone': '时区',
	'settings.timeZoneHint': 'IANA 时区名，例如 Asia/Shanghai。浏览器当前为 {zone}。',
	'settings.windowPreview': '生效区间：{window}',
	'settings.execGroup': '执行方式',
	'settings.autoApprove': '自动跳过所有授权',
	'settings.autoApproveHint':
		'任务会话切到完全访问权限，所有需要确认的操作由队列直接放行。只对队列自己驱动的会话生效，不影响你手动打开的会话。',
	'settings.targetMode': '任务执行位置',
	'settings.targetFresh': '每个任务新建一个会话',
	'settings.targetShared': '共用一个会话（推荐）',
	'settings.targetHint': '共用一个会话时，任务之间可以接续上下文，结果也都在这一个会话里；打开下面的会话压缩可以避免上下文越滚越大。',
	'settings.cooldown': '执行间隔（分钟）',
	'settings.cooldownHint':
		'上一个任务结束后等这么久再开始下一个。0 表示不等待，有空位就接着执行。只对当前工作区生效，每个工作区各设各的。',
	'settings.compact': '任务执行前压缩会话',
	'settings.compactHint':
		'只在「共用会话 / 固定会话」下有意义：每个任务开始前先把会话压缩成摘要，避免前面任务的上下文越滚越大。每个任务新建会话时不需要，也不会触发。',
	'settings.timeout': '单任务超时（分钟）',
	'settings.unsaved': '有未保存的修改',
	'settings.refused': '宿主未接受：{fields}',
	'settings.discard': '撤销',
	'settings.save': '保存设置',
};

/** English dictionary, checked complete against the zh key set. */
const en = {
	'view.label': 'Tasks',
	'page.title': 'Task queue',
	'page.tabQueue': 'Queue',
	'page.tabSettings': 'Settings',
	'page.tabArchive': 'Archive',
	'page.loading': 'Reading the queue…',
	'page.noWorkspace': 'This session does not belong to a workspace, so it has no queue. Put it in one first, and tasks will know where to run.',

	'status.open': 'Running',
	'status.closed': 'Outside window',
	'status.paused': 'Paused',
	'status.pausedNote': 'The queue is paused: tasks keep stacking up until you enable it again.',
	'status.noWindow': 'No window',
	'status.noWindowNote': 'This workspace has no execution window yet, so tasks only queue up. Add one under Settings.',
	'status.openNote': 'Inside the execution window · {running} running · {queued} waiting',
	'status.closesIn': 'closes in {amount}',
	'status.closedNote': 'Outside the window, {queued} task(s) waiting',
	'status.opensAt': 'starts at {time} ({amount})',
	'status.cooldownNote': 'Pacing: the next task starts in {amount} ({queued} waiting, {minutes} min apart)',

	'status.queued': 'Queued',
	'status.running': 'Running',
	'status.done': 'Done',
	'status.failed': 'Failed',
	'status.cancelled': 'Cancelled',

	'window.overnight': '{start} to {end} next day',
	'window.sameDay': '{start} to {end}',
	'window.none': '(no windows)',

	'duration.days': '{count}d',
	'duration.hours': '{count}h',
	'duration.minutes': '{count}m',
	'duration.lessThanMinute': 'under a minute',
	'duration.until': 'in {amount}',
	'duration.since': '{amount} ago',

	'compose.title': 'Title',
	'compose.titlePlaceholder': 'One line naming the task (blank takes the first line of the text)',
	'compose.prompt': 'Task',
	'compose.promptPlaceholder': 'The instruction for the agent, e.g. remove every console.log under src and run the tests…',
	'compose.hint': 'Ctrl/⌘ + Enter to add',
	'compose.add': 'Add to queue',

	'queue.empty': 'The queue is empty. Write a task above and the agent will run it once the window opens.',
	'archive.empty': 'The archive is empty. Tasks you file away after finishing show up here.',
	'archive.restore': 'Restore',
	'archive.restoreHint': 'Put it back in the task list',
	'archive.clear': 'Clear archive',
	'archive.clearConfirm': 'Really clear?',
	'archive.clearWarning': 'This cannot be undone.',
	'archive.clearFailed': 'Could not clear the archive; try again.',
	'queue.addTitle': 'New task',
	'queue.archiveDone': 'Archive completed',
	'queue.unassigned': '{count} older task(s) belong to no workspace.',
	'queue.adopt': 'Adopt into this workspace',

	'card.editTitle': 'Task title',
	'card.editPrompt': 'Task text',
	'card.cancelEdit': 'Cancel',
	'card.save': 'Save',
	'card.attempts': 'attempt {count}',
	'card.session': 'session {id}',
	'card.moveUp': 'Move up one',
	'card.moveDown': 'Move down one',
	'card.edit': 'Edit',
	'card.runNow': 'Run',
	'card.runNowHint': 'Run this task now, ignoring the execution window',
	'card.retry': 'Re-queue',
	'card.cancel': 'Cancel task',
	'card.delete': 'Delete',
	'card.finishedAt': 'finished {time}',

	'settings.windowGroup': 'Execution windows',
	'settings.windowGroupHint': 'Add as many as you like; the queue runs when any one of them is open. A start later than the end wraps to the next day.',
	'settings.sharedNote': 'The settings above apply to every workspace — they are shared by the whole queue.',
	'settings.perWorkspaceNote': 'The one below is set per workspace and affects only this one.',
	'settings.windowStart': 'Start time of window {index}',
	'settings.windowEnd': 'End time of window {index}',
	'settings.addWindow': 'Add window',
	'settings.removeWindow': 'Remove window {index}',
	'settings.windowEmpty': 'With no window, tasks only queue up and never run by themselves.',
	'settings.enabled': 'Enable automatic execution',
	'settings.enabledHint': 'When off, tasks are only created and never run automatically.',
	'settings.start': 'Start time',
	'settings.end': 'End time',
	'settings.timeZone': 'Time zone',
	'settings.timeZoneHint': 'An IANA zone name such as Asia/Shanghai. The browser reports {zone}.',
	'settings.windowPreview': 'In effect: {window}',
	'settings.execGroup': 'How tasks run',
	'settings.autoApprove': 'Skip every authorization',
	'settings.autoApproveHint':
		'Task sessions get full file access and the queue answers every confirmation itself. Only sessions the queue drives are affected — never a session you opened by hand.',
	'settings.targetMode': 'Where a task runs',
	'settings.targetFresh': 'A fresh session per task',
	'settings.targetShared': 'One shared session (recommended)',
	'settings.targetHint': 'A shared session lets the tasks build on each other and keeps every result in one conversation; turn on compaction below to stop that conversation growing without bound.',
	'settings.cooldown': 'Interval between tasks (minutes)',
	'settings.cooldownHint':
		'Wait this long after one task finishes before starting the next. 0 starts the next one as soon as a slot is free. Per workspace: each one keeps its own interval.',
	'settings.compact': 'Compact the session before each task',
	'settings.compactHint':
		'Only meaningful for a shared or pinned session: compacting keeps each task starting from a summary instead of everything the earlier tasks left behind. A fresh session per task never triggers it.',
	'settings.timeout': 'Task timeout (minutes)',
	'settings.unsaved': 'Unsaved changes',
	'settings.refused': 'The host did not accept: {fields}',
	'settings.discard': 'Discard',
	'settings.save': 'Save settings',
};

/** Cordis client services this plugin's `apply` waits for. */
const inject = ['slots', 'locale'];

/**
 * Client plugin body.
 * @param {object} ctx - the client root context.
 */
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-queue: dictionaries');
	ctx.effect(() => installStyles(), 'task-queue: stylesheet');

	// One full-page view, beside the shipped 对话 (`chat`) and 轨迹 (`trajectory`)
	// entries — the conversation view list is `[chat(0), trajectory(10), …]`, so
	// an order of 20 puts this third. `label` is what the shell projects into the
	// tab row; without it the tab would read as the raw slot id.
	//
	// The entry is session-scoped and its `inject` receives the session id, which
	// is what makes the page a *workspace's* page: the id travels with every
	// request and the Host resolves it, so the page never has to know — or be
	// trusted with — a workspace identity of its own.
	const label = ctx.locale.bind(NS);
	ctx.slots.inject('conversation.view', () =>
		ctx.slots.register(
			{
				name: 'conversation.view',
				id: VIEW_ID,
				order: 20,
				locale: NS,
				label: () => label('view.label'),
				inject: (sessionId) => ({ sessionId }),
			},
			TaskQueuePage,
		),
	);
}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
