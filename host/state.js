/**
 * The durable queue document.
 *
 * ## Layout
 *
 * One file holds every workspace's queue, because they share a lifetime and a
 * save: the file is written temp-file-and-rename, so a crash mid-write leaves
 * the previous document intact rather than a half-written one.
 *
 * ```
 * {
 *   version: 2,
 *   workspaces: {
 *     [workspaceId]: { settings, lastFinishedAt? },  // one entry per workspace
 *   },
 *   tasks: [ { …, workspaceId } ],
 * }
 * ```
 *
 * `lastFinishedAt` sits beside the settings rather than inside them because it is
 * observed state, not configuration: it is what the execution cooldown measures
 * from, and it is written by the dispatcher, never by the settings form.
 *
 * Tasks carry their workspace rather than being nested under it. Nesting reads
 * more naturally but makes every repair path recursive; a flat list keeps
 * normalization in one place, and filtering by workspace is a scan of a list
 * that never exceeds a few hundred entries.
 *
 * ## Why per-workspace settings
 *
 * A task belongs to the workspace it was created in, so its hours do too: a side
 * project can run overnight while a work repository only runs at lunchtime. That
 * is also why nothing in the document names a working directory — the directory
 * is the workspace's path, and the workspace is the session the page was opened
 * from.
 *
 * ## Repair
 *
 * Field-by-field repair is what lets a partially hand-edited file still open:
 * one bad time zone costs that field, not the whole queue. A task without usable
 * text is dropped rather than repaired, because an empty prompt would still be
 * dispatched and would burn a turn to accomplish nothing.
 *
 * @module dsh-task-queue/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { isTimeOfDay, isTimeZone, normalizeWindows } from './window.js';

/** Every status a task can hold. */
export const TASK_STATUS = Object.freeze({
	/** Waiting for a dispatch slot inside an execution window. */
	queued: 'queued',
	/** Claimed and sent to a session; the agent owns it now. */
	running: 'running',
	/** The agent finished its turn. */
	done: 'done',
	/** The turn errored, or the plugin gave up on it. */
	failed: 'failed',
	/** Removed from the queue by the user before it ran. */
	cancelled: 'cancelled',
});

/**
 * Where a task's session comes from.
 *
 * `shared` is the default and the recommendation: one conversation per
 * workspace means the tasks can build on each other, and the results are all in
 * one place to read in the morning. The compaction switch exists precisely to
 * keep that single conversation from growing without bound.
 *
 * There is deliberately no "pin an existing session" mode. A session belongs to
 * a workspace, and letting the queue run in a session picked from somewhere else
 * contradicts the one thing this queue guarantees — that a task runs in the
 * workspace that owns it — while offering nothing the shared runner does not.
 */
export const TARGET_MODE = Object.freeze({
	/** A fresh session per task, so tasks never share a context. */
	fresh: 'fresh',
	/** One long-lived runner session per workspace, reused by every task. */
	shared: 'shared',
});

/**
 * The workspace key for a task that predates workspace scoping.
 *
 * A queue written before this document had workspaces holds tasks that cannot be
 * attributed to one. Dropping them would silently discard the user's queued
 * work, so they are kept under this key: they still run, and the page reports
 * them and offers to adopt them into the workspace it is showing.
 */
export const UNASSIGNED = '';

/** The document's current version. */
export const DOCUMENT_VERSION = 2;

/** Default per-workspace settings; every field is validated on read, so this is also the repair table. */
export const DEFAULT_WORKSPACE_SETTINGS = Object.freeze({
	/** Master switch: when false, nothing is claimed at any hour. */
	enabled: true,
	/** The allowed intervals. An empty list schedules nothing. */
	windows: Object.freeze([Object.freeze({ start: '18:00', end: '07:00' })]),
	/** IANA zone the windows are read in. */
	timeZone: 'Asia/Shanghai',
	/** Skip every authorization prompt for sessions the queue drives. */
	autoApprove: true,
	/** How a task's session is chosen. */
	targetMode: TARGET_MODE.shared,
	/** The shared runner session once one has been created for this workspace. */
	runnerSessionId: '',
	/** Minutes a single task may run before the queue marks it failed. */
	taskTimeoutMinutes: 360,
	/**
	 * Minutes to wait after a task finishes before starting the next one.
	 *
	 * Zero means "start the next one as soon as a slot is free". A positive value
	 * paces a batch out, which matters when the work itself is rate-limited or
	 * simply when a queue that hammers through twenty tasks in five minutes is not
	 * what anyone wanted.
	 */
	cooldownMinutes: 0,
	/**
	 * Compact the session before each task.
	 *
	 * Only meaningful when tasks share one session. A batch of tasks in a single
	 * conversation accumulates every earlier task's turns, tool output included, and
	 * the context grows without bound until the model is working against a history
	 * it mostly does not need. Compacting at the task boundary keeps each task
	 * starting from a summary instead.
	 *
	 * It costs a model call and discards detail, so it is off by default and never
	 * applies to a fresh session per task — where there is nothing to compact.
	 */
	compactBeforeTask: false,
});

/** Hard limits, applied on read so a hand-edited file cannot wedge the queue. */
const LIMITS = Object.freeze({
	taskTimeoutMinutes: [1, 24 * 60],
	cooldownMinutes: [0, 24 * 60],
	prompt: 20000,
	tasks: 2000,
});

/** Clamp a number into a range, falling back when it is not finite. */
function clampNumber(value, [min, max], fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.round(number)));
}

/** A trimmed string, or the fallback when the result is empty. */
function trimOr(value, fallback) {
	if (typeof value !== 'string') return fallback;
	const trimmed = value.trim();
	return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * The DSH home directory, honouring the same environment variable the Host uses.
 * @returns {string} absolute path to the DSH home.
 */
function dshHome() {
	const fromEnv = trimOr(process.env.DSH_HOME, '');
	return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

/**
 * The default queue file.
 * @returns {string} absolute path to the durable queue document.
 */
export function defaultFilePath() {
	return join(dshHome(), 'task-queue', 'queue.json');
}

/**
 * Keep only the fields a caller actually supplied validly.
 *
 * This is the whole reason a bad field is survivable. Normalizing
 * `{...current, startTime: '99:99'}` would repair the value against the
 * *defaults*, so one mistyped field would silently reset it to a factory value
 * instead of leaving what the user had. Dropping the invalid field entirely
 * means "repaired" always means "unchanged", never "reset".
 *
 * @param {unknown} raw - an untrusted settings patch.
 * @returns {object} the valid subset of that patch.
 */
export function sanitizeWorkspaceSettingsPatch(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const patch = {};
	if (typeof source.enabled === 'boolean') patch.enabled = source.enabled;
	if (Array.isArray(source.windows)) patch.windows = normalizeWindows(source.windows);
	if (isTimeZone(source.timeZone)) patch.timeZone = source.timeZone;
	if (typeof source.autoApprove === 'boolean') patch.autoApprove = source.autoApprove;
	if (typeof source.compactBeforeTask === 'boolean') patch.compactBeforeTask = source.compactBeforeTask;
	if (Object.values(TARGET_MODE).includes(source.targetMode)) patch.targetMode = source.targetMode;
	if (typeof source.runnerSessionId === 'string') patch.runnerSessionId = source.runnerSessionId;
	for (const [key, bounds] of Object.entries({
		taskTimeoutMinutes: LIMITS.taskTimeoutMinutes,
		cooldownMinutes: LIMITS.cooldownMinutes,
	})) {
		if (source[key] === undefined || source[key] === null || source[key] === '') continue;
		if (!Number.isFinite(Number(source[key]))) continue;
		patch[key] = clampNumber(source[key], bounds, DEFAULT_WORKSPACE_SETTINGS[key]);
	}
	return patch;
}

/**
 * Normalize one workspace's settings.
 *
 * `startTime`/`endTime`, the pre-window-list spelling, are accepted here so a
 * composition config or a document written in that shape still produces the
 * hours it meant.
 *
 * @param {unknown} raw - untrusted settings.
 * @returns {object} complete, valid settings.
 */
export function normalizeWorkspaceSettings(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const patch = sanitizeWorkspaceSettingsPatch(source);
	const settings = { ...DEFAULT_WORKSPACE_SETTINGS, ...patch };
	if (patch.windows === undefined) {
		// No valid window list was supplied, so fall back to the legacy pair when
		// it is there, and only then to the default night window.
		settings.windows =
			isTimeOfDay(source.startTime) && isTimeOfDay(source.endTime)
				? [{ start: source.startTime, end: source.endTime }]
				: DEFAULT_WORKSPACE_SETTINGS.windows.map((window) => ({ ...window }));
	}
	return settings;
}

/**
 * Normalize one task, or reject it.
 * @param {unknown} raw - untrusted task record.
 * @returns {object | undefined} the normalized task, or undefined when unusable.
 */
export function normalizeTask(raw) {
	if (raw === null || typeof raw !== 'object') return undefined;
	const prompt = trimOr(raw.prompt, '');
	if (prompt.length === 0) return undefined;
	const status = Object.values(TASK_STATUS).includes(raw.status) ? raw.status : TASK_STATUS.queued;
	const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now();
	const task = {
		id: trimOr(raw.id, randomUUID()),
		workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : UNASSIGNED,
		prompt: prompt.slice(0, LIMITS.prompt),
		status,
		createdAt,
		updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : createdAt,
		attempts: clampNumber(raw.attempts, [0, 100], 0),
		// Explicit FIFO position. Stored rather than derived from the array so a
		// reorder is a single field write and two tasks created in the same
		// millisecond still have a stable order.
		seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : createdAt,
	};
	if (raw.status === TASK_STATUS.running) {
		// A task stored as running was interrupted: the Host does not survive its
		// own crash, so nothing can still be executing it. Put it back in the
		// queue and say why, instead of leaving a row that can never finish.
		task.status = TASK_STATUS.queued;
		task.error = 'interrupted by a Host restart; re-queued';
	}
	for (const key of ['sessionId', 'error', 'result']) {
		if (typeof raw[key] === 'string' && raw[key].length > 0) task[key] = raw[key];
	}
	for (const key of ['startedAt', 'finishedAt', 'archivedAt']) {
		if (Number.isFinite(Number(raw[key])) && Number(raw[key]) > 0) task[key] = Number(raw[key]);
	}
	if (typeof task.error !== 'string') delete task.error;
	return task;
}

/**
 * Normalize the whole document.
 * @param {unknown} raw - untrusted document.
 * @returns {{ version: number, workspaces: object, tasks: object[] }} a valid document.
 */
export function normalizeState(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const workspaces = {};
	const rawWorkspaces = source.workspaces !== null && typeof source.workspaces === 'object' ? source.workspaces : {};
	for (const [key, value] of Object.entries(rawWorkspaces)) {
		const record = value !== null && typeof value === 'object' ? value : {};
		const entry = {
			settings: normalizeWorkspaceSettings(record.settings),
		};
		if (Number.isFinite(Number(record.lastFinishedAt)) && Number(record.lastFinishedAt) > 0) {
			entry.lastFinishedAt = Number(record.lastFinishedAt);
		}
		workspaces[key] = entry;
	}
	const listed = Array.isArray(source.tasks) ? source.tasks : [];
	const tasks = [];
	for (const entry of listed.slice(0, LIMITS.tasks)) {
		const task = normalizeTask(entry);
		if (task !== undefined) tasks.push(task);
	}
	tasks.sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt);
	return { version: DOCUMENT_VERSION, workspaces, tasks };
}

/**
 * Bring a pre-workspace document forward.
 *
 * A v1 document had one global settings object and a flat task list. Its hours
 * are worth keeping, so they become the seed every workspace starts from; its
 * tasks go to {@link UNASSIGNED}, because guessing which workspace they belonged
 * to would be worse than saying plainly that they belong to none.
 *
 * @param {unknown} raw - a parsed document of any version.
 * @returns {{ document: object, seed: object | undefined }} the document and the settings seed to adopt.
 */
export function migrate(raw) {
	const source = raw !== null && typeof raw === 'object' ? raw : {};
	const isLegacy = source.version !== DOCUMENT_VERSION && source.workspaces === undefined;
	if (!isLegacy) return { document: normalizeState(source), seed: undefined };

	const legacy = source.settings !== null && typeof source.settings === 'object' ? source.settings : {};
	const seed = normalizeWorkspaceSettings(legacy);
	const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map((task) =>
		task !== null && typeof task === 'object' ? { ...task, workspaceId: UNASSIGNED } : task,
	);
	const document = normalizeState({ workspaces: {}, tasks });
	// The old settings named the workspace they applied to. Writing them there as
	// well as seeding from them means the user keeps exactly the state they had,
	// without the seed being hidden behind a workspace they never named.
	const prior = typeof legacy.workspaceId === 'string' ? legacy.workspaceId.trim() : '';
	if (prior.length > 0) document.workspaces[prior] = { settings: normalizeWorkspaceSettings({ ...seed }) };
	return { document, seed };
}

/**
 * The queue store: one in-memory document plus its file.
 *
 * `mutate` runs the caller's function and persists the result, so every
 * observable change is durable before the HTTP response returns and a crashed
 * Host can never expose a change the user saw but the disk did not.
 */
export class TaskStore {
	/** @type {object} the normalized in-memory document. */
	state;

	/** @type {string} absolute path of the durable document. */
	file;

	/** @type {Set<() => void>} listeners notified after every committed change. */
	listeners = new Set();

	/**
	 * @param {object} [options] - construction options.
	 * @param {string} [options.file] - durable document path.
	 * @param {object} [options.fs] - injectable filesystem, for tests.
	 * @param {object} [options.seedSettings] - per-workspace settings a new workspace starts from.
	 * @param {(error: unknown) => void} [options.onError] - persistence failure sink.
	 */
	constructor(options = {}) {
		this.file = options.file ?? defaultFilePath();
		this.fs = options.fs ?? { mkdirSync, readFileSync, renameSync, writeFileSync };
		this.onError = options.onError ?? (() => {});
		this.seedSettings = normalizeWorkspaceSettings(options.seedSettings);
		this.state = this.empty();
	}

	/**
	 * A fresh document, seeded from the plugin's composition config.
	 *
	 * The seed applies only to a workspace that has never been seen: once the
	 * user has edited a workspace's hours in the page, the document is the truth
	 * and the composition config must not silently overwrite it.
	 *
	 * @returns {object} an empty document.
	 */
	empty() {
		return normalizeState({ workspaces: {}, tasks: [] });
	}

	/**
	 * Read the document from disk, migrating it if it predates workspace scoping.
	 *
	 * A missing file opens an empty queue; an unreadable one is reported and also
	 * opens empty, because refusing to start would take the whole Host down over a
	 * file the user can delete.
	 *
	 * @returns {object} the loaded state.
	 */
	load() {
		let text = null;
		try {
			text = this.fs.readFileSync(this.file, 'utf8');
		} catch (error) {
			if (error?.code !== 'ENOENT') this.onError(error);
			this.state = this.empty();
			return this.state;
		}
		try {
			const { document, seed } = migrate(JSON.parse(text));
			if (seed !== undefined) this.seedSettings = seed;
			this.state = document;
		} catch (error) {
			this.onError(error);
			this.state = this.empty();
		}
		return this.state;
	}

	/** Write the document atomically. */
	persist() {
		const text = `${JSON.stringify(this.state, null, '\t')}\n`;
		const temporary = `${this.file}.tmp`;
		try {
			this.fs.mkdirSync(dirname(this.file), { recursive: true });
			this.fs.writeFileSync(temporary, text);
			this.fs.renameSync(temporary, this.file);
		} catch (error) {
			this.onError(error);
		}
	}

	/**
	 * Apply a change and persist it.
	 *
	 * The callback's return value is passed back to the caller, which is what
	 * lets a route hand the created or updated task straight to its response
	 * without re-reading the document.
	 *
	 * @param {(state: object) => unknown} change - in-place mutation of the document.
	 * @returns {unknown} whatever `change` returned.
	 */
	mutate(change) {
		const result = change(this.state);
		this.persist();
		for (const listener of [...this.listeners]) listener();
		return result;
	}

	/**
	 * Subscribe to committed changes.
	 * @param {() => void} listener - called after each persisted mutation.
	 * @returns {() => void} unsubscribe.
	 */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * One workspace's effective settings, whether or not it has been written yet.
	 * @param {string} workspaceId - the workspace.
	 * @returns {object} its settings.
	 */
	settingsFor(workspaceId) {
		const stored = this.state.workspaces[workspaceId];
		if (stored !== undefined) return stored.settings;
		// Not yet materialized: return a copy of the seed, so a first write is just
		// a write and a read never has to persist anything.
		return normalizeWorkspaceSettings({ ...this.seedSettings });
	}

	/**
	 * Every live task belonging to one workspace, in **queue order**.
	 *
	 * The document's array order is the load order, not the queue order: `seq` is
	 * what a reorder writes, and it changes without moving anything in the array.
	 * Sorting here is what makes a reorder visible immediately instead of only
	 * after the next reload.
	 *
	 * Archived tasks are left out: they are history, and history does not hold a
	 * place in the line.
	 *
	 * @param {string} workspaceId - the workspace.
	 * @returns {object[]} its live tasks.
	 */
	tasksOf(workspaceId) {
		return this.state.tasks
			.filter((task) => task.workspaceId === workspaceId && task.archivedAt === undefined)
			.sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt);
	}

	/**
	 * One workspace's archived tasks, newest first.
	 *
	 * Newest first is the reading order for history: the thing you just filed away
	 * is the thing you are most likely to look for.
	 *
	 * @param {string} workspaceId - the workspace.
	 * @returns {object[]} its archived tasks.
	 */
	archivedOf(workspaceId) {
		return this.state.tasks
			.filter((task) => task.workspaceId === workspaceId && task.archivedAt !== undefined)
			.sort((left, right) => right.archivedAt - left.archivedAt);
	}

	/**
	 * When one workspace last finished a task, or undefined if it never has.
	 *
	 * Read from the workspace record rather than derived from the task list, so
	 * that cleaning up finished tasks does not silently cancel a cooldown that is
	 * still running.
	 *
	 * @param {string} workspaceId - the workspace.
	 * @returns {number | undefined} the instant.
	 */
	lastFinishedAt(workspaceId) {
		return this.state.workspaces[workspaceId]?.lastFinishedAt;
	}

	/** @returns {object[]} every task in the document, in queue order. */
	get tasks() {
		return this.state.tasks;
	}

	/**
	 * The workspace keys that currently hold at least one task.
	 * @returns {string[]} the workspace ids.
	 */
	workspacesWithTasks() {
		const keys = new Set();
		for (const task of this.state.tasks) keys.add(task.workspaceId);
		return [...keys];
	}
}
