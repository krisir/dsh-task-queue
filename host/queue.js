/**
 * Queue operations: the verbs the page and the scheduler both use.
 *
 * These are deliberately free functions over the raw document rather than
 * methods on the store. The store owns durability; this module owns meaning —
 * what it means to create a task, to claim one, to finish one — which is the
 * part worth testing without touching a disk.
 *
 * Every task verb that reads or reorders the queue is scoped by workspace,
 * because a queue *is* a workspace's queue: two workspaces never share a line,
 * and moving a task up moves it up among its own neighbours.
 *
 * @module dsh-task-queue/queue
 */

import { randomUUID } from 'node:crypto';

import {
	TASK_STATUS,
	UNASSIGNED,
	normalizeGlobalSettings,
	normalizeWorkspaceSettings,
	sanitizeGlobalSettingsPatch,
	sanitizeWorkspaceSettingsPatch,
} from './state.js';

/** The maximum accepted prompt length, matching the store's clamp. */
const MAX_PROMPT = 20000;

/**
 * The next `seq` value: one past the highest in the document.
 *
 * The invariant that matters is *greater than every live task*, not *never
 * reused*. A deleted task's number can come back, and that is fine: the number
 * is only ever compared against tasks that still exist, so a new task always
 * lands behind all of them. Tracking a monotonic counter instead would mean
 * another durable field to keep consistent and would buy nothing.
 *
 * @param {object[]} tasks - every task in the document.
 * @returns {number} a sequence number greater than every live task's.
 */
function nextSeq(tasks) {
	let highest = 0;
	for (const task of tasks) {
		if (Number.isFinite(task.seq) && task.seq > highest) highest = task.seq;
	}
	return highest + 1;
}

/**
 * Find a task by id.
 *
 * Ids are unique across the whole document, so this is not scoped: a task is
 * reached by the page that owns it, and an id belonging to another workspace is
 * a not-found rather than a silent cross-workspace edit.
 *
 * @param {object} state - queue document.
 * @param {string} id - task id.
 * @returns {object | undefined} the task.
 */
export function findTask(state, id) {
	return state.tasks.find((task) => task.id === id);
}

/**
 * Create a task at the back of one workspace's queue.
 *
 * A task is its instruction and nothing else. There is no title to write: the
 * card headings itself from the instruction's first line, which is the only
 * thing a second field would ever have held, and asking for it twice was asking
 * the user to name what they had already written.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace the task belongs to.
 * @param {{ prompt?: unknown }} input - the new task.
 * @returns {object} the created task.
 * @throws {TypeError} when the prompt is blank.
 */
export function createTask(state, workspaceId, input) {
	const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
	if (prompt.length === 0) throw new TypeError('prompt must not be blank');
	if (prompt.length > MAX_PROMPT) throw new TypeError(`prompt must be at most ${MAX_PROMPT} characters`);
	const now = Date.now();
	const task = {
		id: randomUUID(),
		workspaceId,
		prompt,
		status: TASK_STATUS.queued,
		createdAt: now,
		updatedAt: now,
		attempts: 0,
		seq: nextSeq(state.tasks),
	};
	state.tasks.push(task);
	return task;
}

/**
 * Edit a task's instruction. Status is untouched: editing a queued task keeps its
 * place in line, and editing a finished one does not silently re-run it.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} id - task id.
 * @param {{ prompt?: unknown }} input - replacement fields.
 * @returns {object | undefined} the updated task, or undefined when absent.
 */
export function updateTask(state, id, input) {
	const task = findTask(state, id);
	if (task === undefined) return undefined;
	if (typeof input?.prompt === 'string') {
		const prompt = input.prompt.trim();
		if (prompt.length === 0) throw new TypeError('prompt must not be blank');
		if (prompt.length > MAX_PROMPT) throw new TypeError(`prompt must be at most ${MAX_PROMPT} characters`);
		task.prompt = prompt;
	}
	task.updatedAt = Date.now();
	return task;
}

/**
 * Remove a task outright.
 * @param {object} state - queue document, mutated in place.
 * @param {string} id - task id.
 * @returns {boolean} whether a task was removed.
 */
export function deleteTask(state, id) {
	const index = state.tasks.findIndex((task) => task.id === id);
	if (index < 0) return false;
	state.tasks.splice(index, 1);
	return true;
}

/**
 * Cancel a queued task without deleting it, so the page can still show what the
 * user decided not to run.
 * @param {object} state - queue document, mutated in place.
 * @param {string} id - task id.
 * @returns {object | undefined} the updated task.
 */
export function cancelTask(state, id) {
	const task = findTask(state, id);
	if (task === undefined) return undefined;
	if (task.status === TASK_STATUS.running) return undefined;
	task.status = TASK_STATUS.cancelled;
	task.updatedAt = Date.now();
	return task;
}

/**
 * Put a task back at the front of its workspace's queue.
 *
 * Retry is "front", not "back": the user pressing retry on a failure wants it
 * next, not after the thirty tasks they queued afterwards.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} id - task id.
 * @returns {object | undefined} the updated task.
 */
export function retryTask(state, id) {
	const task = findTask(state, id);
	if (task === undefined) return undefined;
	task.status = TASK_STATUS.queued;
	task.seq = 0;
	task.updatedAt = Date.now();
	delete task.error;
	delete task.result;
	delete task.startedAt;
	delete task.finishedAt;
	return task;
}

/**
 * Reorder one workspace's queue to the given id order.
 *
 * Only ids belonging to that workspace are considered, so a client rendering one
 * workspace cannot reorder another by sending ids it should not know about. Ids
 * the caller did not mention keep their relative order after the ones it did, so
 * a partial list never drops tasks.
 *
 * The new positions are written above every sequence number in the document, so
 * a reorder cannot interleave with another workspace's line.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace whose queue is being reordered.
 * @param {unknown} ids - the requested order.
 * @returns {boolean} whether the order changed.
 */
export function reorderTasks(state, workspaceId, ids) {
	if (!Array.isArray(ids)) return false;
	const members = state.tasks.filter(
		(task) => task.workspaceId === workspaceId && task.archivedAt === undefined,
	);
	if (members.length === 0) return false;
	const memberIds = new Set(members.map((task) => task.id));
	const requested = [];
	const seen = new Set();
	for (const id of ids) {
		if (typeof id !== 'string' || seen.has(id) || !memberIds.has(id)) continue;
		seen.add(id);
		requested.push(id);
	}
	if (requested.length === 0) return false;
	const rest = members
		.filter((task) => !seen.has(task.id))
		.sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)
		.map((task) => task.id);
	const byId = new Map(members.map((task) => [task.id, task]));
	let position = nextSeq(state.tasks);
	for (const id of [...requested, ...rest]) {
		byId.get(id).seq = position;
		position += 1;
	}
	return true;
}

/**
 * The next task one workspace's scheduler should claim.
 *
 * FIFO by `seq`, skipping anything already running, finished, or cancelled — the
 * queue is a line, and joining it late never means jumping it.
 *
 * @param {object} state - queue document.
 * @param {string} workspaceId - the workspace to claim from.
 * @returns {object | undefined} the next queued task.
 */
export function nextQueued(state, workspaceId) {
	let best;
	for (const task of state.tasks) {
		if (task.workspaceId !== workspaceId) continue;
		if (task.archivedAt !== undefined) continue;
		if (task.status !== TASK_STATUS.queued) continue;
		if (best === undefined || task.seq < best.seq || (task.seq === best.seq && task.createdAt < best.createdAt)) {
			best = task;
		}
	}
	return best;
}

/**
 * How many tasks one workspace has running.
 * @param {object} state - queue document.
 * @param {string} workspaceId - the workspace.
 * @returns {number} the running count.
 */
export function runningCount(state, workspaceId) {
	let count = 0;
	for (const task of state.tasks) {
		if (task.workspaceId !== workspaceId) continue;
		if (task.archivedAt !== undefined) continue;
		if (task.status === TASK_STATUS.running) count += 1;
	}
	return count;
}

/**
 * How many tasks one workspace has already run in the current batch.
 *
 * A finished task still sitting in the list is the thing that makes the next
 * queued task a *successor* rather than a *starter*. Once every finished task
 * has been archived or deleted, the queue holds no history and the next task to
 * arrive begins a fresh run — which is exactly when the interval must not apply.
 *
 * @param {object} state - queue document.
 * @param {string} workspaceId - the workspace.
 * @returns {number} how many of its tasks have run and are still listed.
 */
export function settledCount(state, workspaceId) {
	let count = 0;
	for (const task of state.tasks) {
		if (task.workspaceId !== workspaceId) continue;
		if (task.archivedAt !== undefined) continue;
		if (task.status === TASK_STATUS.done || task.status === TASK_STATUS.failed) count += 1;
	}
	return count;
}

/**
 * Apply a settings patch to one workspace.
 *
 * The patch is sanitized *before* it is merged, not after. Merging first and
 * normalizing the result would let one malformed field knock the whole object
 * back toward the defaults, so a typo in one window would also quietly move the
 * others the user had set. Sanitizing first means an invalid field is simply not
 * applied, and every other field keeps its current value.
 *
 * A window *list* is the one place where partial application is the right
 * behavior: an entry that cannot be parsed is dropped and the rest are kept,
 * because a list is a set of independent intervals. Sending an empty list is
 * therefore a real instruction — "schedule nothing" — and is applied as one.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace whose settings change.
 * @param {unknown} patch - requested settings.
 * @param {object} seed - the settings a never-seen workspace starts from.
 * @returns {object} the normalized settings.
 */
export function patchSettings(state, workspaceId, patch, seed) {
	// The plugin-wide fields are written once, in one place, whatever workspace
	// the request named — that is what makes them global. Sending them from any
	// workspace's settings face is a change to the queue as a whole.
	const global = sanitizeGlobalSettingsPatch(patch);
	if (Object.keys(global).length > 0) {
		const base = state.settings ?? normalizeGlobalSettings(seed);
		state.settings = normalizeGlobalSettings({ ...base, ...global });
	}

	// The interval belongs to the workspace that asked for it.
	const own = sanitizeWorkspaceSettingsPatch(patch);
	const existing = state.workspaces[workspaceId]?.settings;
	const base = existing ?? normalizeWorkspaceSettings({});
	state.workspaces[workspaceId] = {
		...state.workspaces[workspaceId],
		settings: normalizeWorkspaceSettings({ ...base, ...own }),
	};
	return {
		...normalizeGlobalSettings(state.settings),
		...state.workspaces[workspaceId].settings,
	};
}

/**
 * Record that one workspace just finished a task.
 *
 * This is the anchor the execution cooldown measures from. It is written on the
 * workspace record rather than derived from the task list, so deleting a
 * finished task does not silently shorten a cooldown that is still running.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace that finished.
 * @param {number} at - the instant the task closed.
 * @param {object} seed - the settings a never-seen workspace starts from.
 * @returns {void}
 */
export function markWorkspaceFinished(state, workspaceId, at) {
	const entry = state.workspaces[workspaceId];
	if (entry === undefined) {
		// A workspace can finish a task before anyone has ever set its interval, so
		// the entry starts at the default rather than carrying a copy of anything
		// that belongs to the plugin.
		state.workspaces[workspaceId] = {
			settings: normalizeWorkspaceSettings({}),
			lastFinishedAt: at,
		};
		return;
	}
	entry.lastFinishedAt = at;
}

/**
 * How long until one workspace may start its next task, or 0 when it may now.
 *
 * The wait only applies **between two tasks of a batch**. It paces a run of work
 * out; it is not a lock on the queue. So a task that *starts* a run waits for
 * nothing, even when `lastFinishedAt` still sits inside the interval — which
 * happens whenever a batch ended recently and a new one is being assembled,
 * since that anchor is durable per-workspace state and is deliberately not
 * cleared when the queue drains.
 *
 * The distinction is whether the task has a *predecessor*: a finished task still
 * listed ahead of it. With one, it follows another and waits its turn; without
 * one, it opens the run and must not be paced. Reading the list rather than a
 * counter is what makes the rule survive archiving — filing finished tasks away
 * leaves the queue with no history, and the next task to arrive then starts
 * immediately instead of inheriting a gap from a batch that is over.
 *
 * @param {object} options - the question.
 * @param {number} options.now - the current instant.
 * @param {object} options.settings - the workspace's settings.
 * @param {number | undefined} options.lastFinishedAt - when it last finished.
 * @param {number} options.running - how many of its tasks are running.
 * @param {number} [options.settled=0] - how many of its tasks have already run.
 * @returns {number} milliseconds still to wait, 0 when none.
 */
export function cooldownRemaining({ now, settings, lastFinishedAt, running, settled = 0 }) {
	const minutes = Number(settings.cooldownMinutes);
	if (!Number.isFinite(minutes) || minutes <= 0) return 0;
	if (running > 0) return 0;
	// Nothing has run ahead of it in this batch, so this task opens the run. Its
	// start is not a gap between tasks and must not be paced.
	if (settled <= 0) return 0;
	if (!Number.isFinite(lastFinishedAt)) return 0;
	return Math.max(0, Number(lastFinishedAt) + minutes * 60_000 - now);
}

/**
 * File one workspace's finished tasks away.
 *
 * Only `done` tasks are archived. A failure or a cancellation is something the
 * user still has to decide about — retry it or delete it — and hiding it would
 * take that decision away without asking.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace to tidy.
 * @param {number} at - the instant of archiving.
 * @returns {number} how many tasks were filed away.
 */
export function archiveCompleted(state, workspaceId, at) {
	let archived = 0;
	for (const task of state.tasks) {
		if (task.workspaceId !== workspaceId) continue;
		if (task.archivedAt !== undefined) continue;
		if (task.status !== TASK_STATUS.done) continue;
		task.archivedAt = at;
		archived += 1;
	}
	return archived;
}

/**
 * Bring one archived task back into the queue list.
 *
 * Archiving is a filing decision, not a lifecycle one, so it has to be
 * reversible — otherwise "tidy up" and "lose it" would be the same button.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} id - task id.
 * @returns {object | undefined} the restored task.
 */
export function unarchiveTask(state, id) {
	const task = findTask(state, id);
	if (task === undefined || task.archivedAt === undefined) return undefined;
	delete task.archivedAt;
	return task;
}

/**
 * Delete one workspace's archived tasks outright.
 *
 * The one destructive bulk action in the plugin, which is why the page asks for
 * confirmation before calling it: there is no undo for this, and there is no
 * reason for "clear the archive" to be as cheap as a click on the way past.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace to empty.
 * @returns {number} how many tasks were deleted.
 */
export function clearArchived(state, workspaceId) {
	const before = state.tasks.length;
	state.tasks = state.tasks.filter(
		(task) => task.workspaceId !== workspaceId || task.archivedAt === undefined,
	);
	return before - state.tasks.length;
}

/**
 * Move every unassigned task into one workspace.
 *
 * This exists for the only population that can have unassigned tasks: a queue
 * written before tasks carried a workspace. They are kept runnable rather than
 * discarded, and this is how the user gives them a home.
 *
 * @param {object} state - queue document, mutated in place.
 * @param {string} workspaceId - the workspace to adopt them into.
 * @returns {number} how many tasks moved.
 */
export function adoptUnassigned(state, workspaceId) {
	if (workspaceId === UNASSIGNED) return 0;
	let moved = 0;
	for (const task of state.tasks) {
		if (task.workspaceId !== UNASSIGNED) continue;
		task.workspaceId = workspaceId;
		task.updatedAt = Date.now();
		moved += 1;
	}
	return moved;
}
