/**
 * Queue-operation tests.
 *
 * These are the verbs the panel and the scheduler share, so the assertions are
 * about the promises the panel makes to the user: tasks run in the order they
 * were created, retry puts a task back at the front, and reordering cannot lose
 * a task the caller did not mention.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { normalizeState, TASK_STATUS } from '../host/state.js';
import {
	adoptUnassigned,
	archiveCompleted,
	cancelTask,
	clearArchived,
	createTask,
	deleteTask,
	findTask,
	nextQueued,
	patchSettings,
	reorderTasks,
	retryTask,
	runningCount,
	unarchiveTask,
	updateTask,
} from '../host/queue.js';

/** The workspace these tests queue into. */
const WS = 'ws-1';

/** One workspace's live tasks in queue order, the way the page reads them. */
function queueOrder(state, workspaceId) {
	return state.tasks
		.filter((task) => task.workspaceId === workspaceId && task.archivedAt === undefined)
		.slice()
		.sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt)
		.map((task) => String(task.id));
}

/** A state document with no tasks. */
function emptyState() {
	return normalizeState({});
}

test('created tasks queue in creation order', () => {
	const state = emptyState();
	createTask(state, WS, { prompt: 'a' });
	createTask(state, WS, { prompt: 'b' });
	createTask(state, WS, { prompt: 'c' });
	assert.deepEqual(
		state.tasks.map((task) => task.prompt),
		['a', 'b', 'c'],
	);
	assert.equal(nextQueued(state, WS).prompt, 'a');
});

test('a blank prompt is refused rather than queued', () => {
	const state = emptyState();
	assert.throws(() => createTask(state, WS, { prompt: '   ' }), TypeError);
	assert.throws(() => createTask(state, WS, {}), TypeError);
	assert.equal(state.tasks.length, 0);
});

test('a task carries no title of its own', () => {
	// The card headings itself from the instruction; nothing else is stored, and
	// a title passed in is ignored rather than kept as a second source of truth.
	const state = emptyState();
	const task = createTask(state, WS, { prompt: 'Refactor the parser\nand the lexer', title: 'ignored' });
	assert.equal(task.title, undefined);
	assert.equal(task.prompt, 'Refactor the parser\nand the lexer');
});

test('a new task always lands behind every live task', () => {
	// The order only ever compares live tasks, so the number a deleted task
	// held may come back — what must never happen is a new task sorting ahead
	// of one that still exists.
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	const second = createTask(state, WS, { prompt: 'b' });
	const third = createTask(state, WS, { prompt: 'c' });
	deleteTask(state, third.id);
	const fourth = createTask(state, WS, { prompt: 'd' });
	assert.ok(fourth.seq > first.seq, 'the new task sorts after the first survivor');
	assert.ok(fourth.seq > second.seq, 'and after the second survivor');
	assert.equal(nextQueued(state, WS).id, first.id, 'joining the queue late never means jumping it');
	assert.deepEqual(
		state.tasks.filter((task) => task.workspaceId === WS).map((task) => task.prompt),
		['a', 'b', 'd'],
		'the deleted task is gone and the new one is at the back',
	);
});

test('a running task is skipped by the claim', () => {
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	const second = createTask(state, WS, { prompt: 'b' });
	first.status = TASK_STATUS.running;
	assert.equal(nextQueued(state, WS).id, second.id);
	assert.equal(runningCount(state, WS), 1);
});

test('editing keeps a task in its place', () => {
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	createTask(state, WS, { prompt: 'b' });
	updateTask(state, first.id, { prompt: 'a, rewritten' });
	assert.equal(findTask(state, first.id).prompt, 'a, rewritten');
	assert.equal(nextQueued(state, WS).id, first.id, 'an edit does not send it to the back');
});

test('an emptied instruction is refused rather than stored', () => {
	const state = emptyState();
	const task = createTask(state, WS, { prompt: 'the real instruction' });
	assert.throws(() => updateTask(state, task.id, { prompt: '   ' }), TypeError);
	assert.equal(findTask(state, task.id).prompt, 'the real instruction');
});

test('retry puts a failed task at the front', () => {
	const state = emptyState();
	const failed = createTask(state, WS, { prompt: 'a' });
	createTask(state, WS, { prompt: 'b' });
	createTask(state, WS, { prompt: 'c' });
	failed.status = TASK_STATUS.failed;
	failed.error = 'boom';
	failed.result = 'partial';
	const retried = retryTask(state, failed.id);
	assert.equal(retried.status, TASK_STATUS.queued);
	assert.equal(retried.error, undefined);
	assert.equal(retried.result, undefined);
	assert.equal(nextQueued(state, WS).id, failed.id, 'retry means next, not last');
});

test('a running task cannot be cancelled out from under its agent', () => {
	const state = emptyState();
	const task = createTask(state, WS, { prompt: 'a' });
	task.status = TASK_STATUS.running;
	assert.equal(cancelTask(state, task.id), undefined);
	assert.equal(findTask(state, task.id).status, TASK_STATUS.running);
});

test('reordering applies the requested order and keeps unmentioned tasks', () => {
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	const second = createTask(state, WS, { prompt: 'b' });
	const third = createTask(state, WS, { prompt: 'c' });
	reorderTasks(state, WS, [third.id, first.id]);
	assert.deepEqual(
		queueOrder(state, WS),
		[third.id, first.id, second.id],
		'the unmentioned task trails the requested ones',
	);
});

test('reordering ignores unknown and duplicate ids', () => {
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	const second = createTask(state, WS, { prompt: 'b' });
	reorderTasks(state, WS, [second.id, second.id, 'does-not-exist', first.id]);
	assert.deepEqual(queueOrder(state, WS), [second.id, first.id]);
});

test('a partial settings patch touches only the fields it names', () => {
	const state = emptyState();
	patchSettings(state, WS, { windows: [{ start: '19:15', end: '07:00' }], timeZone: 'UTC' }, {});
	assert.deepEqual(state.workspaces[WS].settings.windows, [{ start: '19:15', end: '07:00' }]);
	assert.equal(state.workspaces[WS].settings.timeZone, 'UTC');
	assert.equal(state.workspaces[WS].settings.autoApprove, true, 'untouched fields survive');
});

test('an invalid scalar patch field is dropped rather than reset to the factory value', () => {
	// Merging first and normalizing the result would knock the whole object back
	// toward the defaults, so one mistyped field would also move the fields the
	// user had already set. The invalid field must be dropped, not repaired
	// against the defaults.
	const state = emptyState();
	patchSettings(state, WS, { windows: [{ start: '21:00', end: '05:30' }], timeZone: 'UTC', cooldownMinutes: 3 }, {});
	patchSettings(state, WS, { timeZone: 'Mars/Olympus', targetMode: 'nonsense' }, {});
	assert.equal(state.workspaces[WS].settings.timeZone, 'UTC', 'the previous zone survives');
	assert.equal(state.workspaces[WS].settings.targetMode, 'shared');
	assert.deepEqual(
		state.workspaces[WS].settings.windows,
		[{ start: '21:00', end: '05:30' }],
		'an untouched list survives',
	);
	assert.equal(state.workspaces[WS].settings.cooldownMinutes, 3);

	patchSettings(state, WS, { cooldownMinutes: 999999 }, {});
	assert.equal(state.workspaces[WS].settings.cooldownMinutes, 1440, 'a valid but out-of-range number is clamped');
});

test('an invalid window entry is dropped and the valid ones are kept', () => {
	// A list is a set of independent intervals, so partial application is the
	// right answer here where a scalar would be left untouched.
	const state = emptyState();
	patchSettings(
		state,
		WS,
		{ windows: [{ start: '21:00', end: '05:30' }, { start: '99:99', end: '01:00' }, { start: '09:00', end: '17:00' }] },
		{},
	);
	assert.deepEqual(state.workspaces[WS].settings.windows, [
		{ start: '21:00', end: '05:30' },
		{ start: '09:00', end: '17:00' },
	]);
});

test('an empty window list is a real instruction, not a missing field', () => {
	const state = emptyState();
	patchSettings(state, WS, { windows: [{ start: '21:00', end: '05:30' }] }, {});
	patchSettings(state, WS, { windows: [] }, {});
	assert.deepEqual(state.workspaces[WS].settings.windows, [], 'schedule nothing');
});

test('settings are per workspace', () => {
	const state = emptyState();
	patchSettings(state, 'ws-1', { windows: [{ start: '18:00', end: '07:00' }] }, {});
	patchSettings(state, 'ws-2', { windows: [{ start: '12:00', end: '13:00' }] }, {});
	assert.deepEqual(state.workspaces['ws-1'].settings.windows, [{ start: '18:00', end: '07:00' }]);
	assert.deepEqual(state.workspaces['ws-2'].settings.windows, [{ start: '12:00', end: '13:00' }]);
});

test('unassigned tasks can be adopted into a workspace', () => {
	const state = normalizeState({
		tasks: [
			{ id: 'old-1', prompt: 'legacy', seq: 1, workspaceId: '' },
			{ id: 'old-2', prompt: 'legacy too', seq: 2, workspaceId: '' },
			{ id: 'mine', prompt: 'mine', seq: 3, workspaceId: 'ws-1' },
		],
	});
	assert.equal(adoptUnassigned(state, 'ws-1'), 2);
	assert.equal(adoptUnassigned(state, 'ws-1'), 0, 'adopting twice moves nothing');
	assert.equal(adoptUnassigned(state, ''), 0, 'the unassigned bucket cannot adopt into itself');
	assert.deepEqual(
		state.tasks.map((task) => task.workspaceId),
		['ws-1', 'ws-1', 'ws-1'],
	);
});

test('reordering one workspace never touches another', () => {
	const state = normalizeState({
		tasks: [
			{ id: 'a', prompt: 'a', seq: 1, workspaceId: 'ws-1' },
			{ id: 'b', prompt: 'b', seq: 2, workspaceId: 'ws-2' },
			{ id: 'c', prompt: 'c', seq: 3, workspaceId: 'ws-1' },
		],
	});
	reorderTasks(state, 'ws-1', ['c', 'a']);
	assert.deepEqual(queueOrder(state, 'ws-1'), ['c', 'a']);
	assert.equal(state.tasks.find((task) => task.id === 'b').seq, 2, 'the other queue is untouched');
});

test('a reorder cannot pull in an id from another workspace', () => {
	const state = normalizeState({
		tasks: [
			{ id: 'a', prompt: 'a', seq: 1, workspaceId: 'ws-1' },
			{ id: 'b', prompt: 'b', seq: 2, workspaceId: 'ws-2' },
		],
	});
	reorderTasks(state, 'ws-1', ['b', 'a']);
	// 'b' is not a member of ws-1, so it is ignored and 'a' keeps its place.
	assert.equal(state.tasks.find((task) => task.id === 'b').workspaceId, 'ws-2');
	assert.equal(reorderTasks(state, 'ws-3', ['a']), false, 'a workspace with no tasks is a no-op');
});

test('archiving files away finished tasks and nothing else', () => {
	const state = emptyState();
	const done = createTask(state, WS, { prompt: 'done' });
	const failed = createTask(state, WS, { prompt: 'failed' });
	const waiting = createTask(state, WS, { prompt: 'waiting' });
	done.status = TASK_STATUS.done;
	failed.status = TASK_STATUS.failed;

	assert.equal(archiveCompleted(state, WS, 5000), 1, 'only the finished task is filed away');
	assert.equal(done.archivedAt, 5000);
	assert.equal(failed.archivedAt, undefined, 'a failure stays actionable rather than hidden');
	assert.equal(waiting.archivedAt, undefined);

	// An archived task holds no place in the line and cannot be claimed, even if it
	// is later put back into a queued state by something else.
	assert.deepEqual(queueOrder(state, WS), [failed.id, waiting.id]);
	assert.equal(nextQueued(state, WS).id, waiting.id, 'the waiting task is the head of the line');
	done.status = TASK_STATUS.queued;
	assert.equal(nextQueued(state, WS).id, waiting.id, 'and an archived task is never claimed');
	assert.equal(archiveCompleted(state, WS, 6000), 0, 'archiving again is a no-op');
});

test('archiving is reversible, and clearing the archive is not', () => {
	const state = emptyState();
	const done = createTask(state, WS, { prompt: 'done' });
	done.status = TASK_STATUS.done;
	archiveCompleted(state, WS, 5000);

	assert.equal(unarchiveTask(state, done.id).archivedAt, undefined, 'it comes back to the queue list');
	assert.equal(unarchiveTask(state, done.id), undefined, 'and cannot be restored twice');

	archiveCompleted(state, WS, 6000);
	assert.equal(clearArchived(state, WS), 1, 'the archive empties');
	assert.equal(findTask(state, done.id), undefined, 'the task is gone for good');
	assert.equal(clearArchived(state, WS), 0, 'clearing an empty archive is a no-op');
});

test('archiving one workspace leaves another alone', () => {
	const state = normalizeState({
		tasks: [
			{ id: 'a', prompt: 'a', seq: 1, workspaceId: 'ws-1', status: TASK_STATUS.done },
			{ id: 'b', prompt: 'b', seq: 2, workspaceId: 'ws-2', status: TASK_STATUS.done },
		],
	});
	assert.equal(archiveCompleted(state, 'ws-1', 5000), 1);
	assert.equal(findTask(state, 'a').archivedAt, 5000);
	assert.equal(findTask(state, 'b').archivedAt, undefined);
	assert.equal(clearArchived(state, 'ws-1'), 1);
	assert.ok(findTask(state, 'b'), 'the other workspace keeps its own archived task');
});

test('an archived task survives a reopen with its archive stamp', () => {
	const state = normalizeState({
		tasks: [{ id: 'a', prompt: 'a', seq: 1, workspaceId: 'ws-1', status: TASK_STATUS.done, archivedAt: 4242 }],
	});
	const task = findTask(state, 'a');
	assert.equal(task.archivedAt, 4242);
});

test('a task re-queued for retry keeps whatever archive state it had', () => {
	// `retry` is about the run, not about filing; it does not silently unarchive.
	const state = emptyState();
	const task = createTask(state, WS, { prompt: 'a' });
	task.status = TASK_STATUS.done;
	archiveCompleted(state, WS, 5000);
	retryTask(state, task.id);
	assert.equal(task.status, TASK_STATUS.queued);
	assert.equal(task.archivedAt, 5000, 'still filed away, and still not claimable');
	assert.equal(nextQueued(state, WS), undefined);
});

test('a new task lands at the back even after a reorder', () => {
	const state = emptyState();
	const first = createTask(state, WS, { prompt: 'a' });
	const second = createTask(state, WS, { prompt: 'b' });
	reorderTasks(state, WS, [second.id, first.id]);
	const third = createTask(state, WS, { prompt: 'c' });
	assert.equal(nextQueued(state, WS).id, second.id);
	assert.ok(third.seq > second.seq && third.seq > first.seq);
});
