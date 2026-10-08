/**
 * Scheduler tests — the acceptance criteria, stated as assertions.
 *
 * The user's requirement is precise: "before 18:00, only create tasks, do not
 * run them; after 18:00, claim and dispatch". So these tests set the clock to
 * either side of the boundary and assert what the queue did. The dispatcher is
 * a stub, because what is under test is *when* the queue acts, not how a
 * session runs.
 *
 * Timers are injected and never fire: a test that armed a real 15-second timer
 * would hang or leak, and the loop's own arithmetic is not what is being
 * checked here.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Scheduler } from '../host/scheduler.js';
import { TaskStore, TASK_STATUS, normalizeGlobalSettings, normalizeWorkspaceSettings } from '../host/state.js';
import { archiveCompleted, createTask, patchSettings } from '../host/queue.js';

/** 18:00 in Asia/Shanghai, the first minute the window is open. */
const OPEN = Date.parse('2025-01-01T10:00:00Z');

/** 17:59 in Asia/Shanghai, one minute before the window opens. */
const JUST_BEFORE = Date.parse('2025-01-01T09:59:00Z');

/** 07:00 in Asia/Shanghai, the first minute the window is closed. */
const JUST_AFTER = Date.parse('2025-01-01T23:00:00Z');

/** The workspace these tests queue into. */
const WS = 'ws-1';

/** A store with no disk, one workspace, and one queued task per prompt given. */
function buildStore(prompts, overrides = {}) {
	const files = new Map();
	const store = new TaskStore({
		file: '/q.json',
		fs: {
			mkdirSync() {},
			readFileSync(path) {
				if (!files.has(path)) {
					const error = new Error('ENOENT');
					error.code = 'ENOENT';
					throw error;
				}
				return files.get(path);
			},
			writeFileSync(path, text) {
				files.set(path, text);
			},
			renameSync(from, to) {
				files.set(to, files.get(from));
				files.delete(from);
			},
		},
	});
	store.load();
	store.mutate((state) => {
		// The shared settings are the plugin's, so an override lands in the one
		// global object; the interval is the workspace's and stays in its entry.
		state.settings = normalizeGlobalSettings({ ...state.settings, ...overrides });
		state.workspaces[WS] = { settings: normalizeWorkspaceSettings(overrides) };
		for (const prompt of prompts) createTask(state, WS, { prompt });
	});
	return store;
}

/**
 * A store with two workspaces that each hold one queued task.
 *
 * `settings` is applied to the plugin-wide settings — the hours a test wants to
 * gate on. `stale` writes a full settings object straight into one workspace's
 * entry, which is the shape a v2 document had, so a test can prove that only the
 * interval survives from it.
 */
function buildTwoWorkspaces({ settings = {}, stale } = {}) {
	const files = new Map();
	const store = new TaskStore({
		file: '/q.json',
		fs: {
			mkdirSync() {},
			readFileSync(path) {
				if (!files.has(path)) {
					const error = new Error('ENOENT');
					error.code = 'ENOENT';
					throw error;
				}
				return files.get(path);
			},
			writeFileSync(path, text) {
				files.set(path, text);
			},
			renameSync(from, to) {
				files.set(to, files.get(from));
				files.delete(from);
			},
		},
	});
	store.load();
	store.mutate((state) => {
		state.settings = normalizeGlobalSettings({ ...state.settings, ...settings });
		state.workspaces.one = { settings: normalizeWorkspaceSettings({}) };
		state.workspaces.two = { settings: normalizeWorkspaceSettings({}) };
		if (stale !== undefined) state.workspaces.two.settings = { ...stale };
		createTask(state, 'one', { prompt: 'work' });
		createTask(state, 'two', { prompt: 'night work' });
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	return { store, scheduler, dispatcher };
}

/** A dispatcher that records calls and marks each task running, like the real one. */
function buildDispatcher(store, { failOn } = {}) {
	const dispatched = [];
	return {
		dispatched,
		async dispatch(task) {
			dispatched.push(task.prompt);
			if (failOn !== undefined && task.prompt === failOn) {
				store.mutate((state) => {
					const stored = state.tasks.find((candidate) => candidate.id === task.id);
					stored.status = TASK_STATUS.failed;
				});
				throw new Error('dispatch blew up');
			}
			store.mutate((state) => {
				const stored = state.tasks.find((candidate) => candidate.id === task.id);
				stored.status = TASK_STATUS.running;
			});
		},
	};
}

/** A scheduler with a fixed clock and inert timers. */
function buildScheduler(store, dispatcher, now) {
	const armed = [];
	return {
		armed,
		scheduler: new Scheduler({
			store,
			dispatcher,
			now: () => now,
			timers: {
				setTimeout: (callback, delay) => {
					armed.push(delay);
					return { unref() {} };
				},
				clearTimeout() {},
			},
		}),
	};
}

test('before the window opens, nothing is claimed', async () => {
	const store = buildStore(['first', 'second']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, JUST_BEFORE);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, [], '17:59 must not run anything');
	assert.equal(store.tasks.filter((task) => task.status === TASK_STATUS.running).length, 0);
	assert.equal(store.tasks.filter((task) => task.status === TASK_STATUS.queued).length, 2, 'both stay queued');
});

test('the window opens: the queue claims and dispatches by itself', async () => {
	const store = buildStore(['first', 'second']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['first'], 'the oldest task goes first');
	assert.equal(store.tasks[0].status, TASK_STATUS.running);
	assert.equal(store.tasks[1].status, TASK_STATUS.queued, 'the next one waits for a free slot');
});

test('a closed window after the night stops the queue again', async () => {
	const store = buildStore(['first']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, JUST_AFTER);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, []);
});

test('the master switch closes the window at any hour', async () => {
	const store = buildStore(['first'], { enabled: false });
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, []);
});

test('a pass claims one task per workspace at a time', async () => {
	// One at a time, always: tasks in a workspace share a session by default, so a
	// second one is not parallelism — it is the second task queueing behind the
	// first while both count as running.
	const store = buildStore(['a', 'b', 'c']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a'], 'only the head of the line starts');

	// The completion watcher closes 'a' when its agent goes idle.
	store.mutate((state) => {
		state.tasks[0].status = TASK_STATUS.done;
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a', 'b'], 'the next one starts once the slot frees');
});

test('an empty queue is a no-op', async () => {
	const store = buildStore([]);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, []);
});

test('one failing dispatch stops the pass instead of draining the queue into failures', async () => {
	const store = buildStore(['broken', 'healthy'], { maxConcurrent: 8 });
	const dispatcher = buildDispatcher(store, { failOn: 'broken' });
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['broken'], 'the pass stops on the first failure');
	assert.equal(store.tasks[0].status, TASK_STATUS.failed);
	assert.equal(store.tasks[1].status, TASK_STATUS.queued, 'the rest of the night is not lost');
});

test('overlapping passes never claim the same task twice', async () => {
	const store = buildStore(['only']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await Promise.all([scheduler.tick(), scheduler.tick()]);
	assert.deepEqual(dispatcher.dispatched, ['only'], 'the re-entrancy guard held');
});

test('the loop reports whether the window is open', () => {
	const store = buildStore([]);
	const open = buildScheduler(store, buildDispatcher(store), OPEN).scheduler;
	assert.equal(open.isDispatchWindowOpen(WS), true);
	const closed = buildScheduler(store, buildDispatcher(store), JUST_BEFORE).scheduler;
	assert.equal(closed.isDispatchWindowOpen(WS), false);
});

test('the armed sleep never exceeds the poll interval', async () => {
	const store = buildStore([], { pollSeconds: 15 });
	const dispatcher = buildDispatcher(store);
	const { scheduler, armed } = buildScheduler(store, dispatcher, JUST_BEFORE);
	scheduler.start();
	assert.equal(armed.length, 1);
	assert.ok(armed[0] <= 30000, 'a bound on the sleep is what survives a suspended machine');
	scheduler.stop();
});

test('a settings change is picked up by the next pass without a restart', async () => {
	const store = buildStore(['first']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, JUST_BEFORE);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, []);
	// The user moves the window to include right now.
	store.mutate((state) => {
		state.settings = normalizeGlobalSettings({ ...state.settings, windows: [{ start: '00:00', end: '00:00' }] });
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['first']);
});

test('the hours are shared, so both workspaces are gated by the same window', async () => {
	// Hours are the plugin's, not a workspace's: one answer applies to every
	// queue, so there is no way for two workspaces to disagree about when the
	// queue runs. The interval is what differs per workspace, and that is the
	// next test.
	const { store, scheduler, dispatcher } = buildTwoWorkspaces({
		settings: { windows: [{ start: '18:00', end: '07:00' }] },
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched.sort(), ['night work', 'work'], 'both run inside the one window');
	assert.equal(store.settingsFor('one').windows[0].start, '18:00');
	assert.equal(store.settingsFor('two').windows[0].start, '18:00', 'and they cannot differ');
});

test('the hours are shared even when a workspace entry carries a stale copy', async () => {
	// A v2 document kept a full settings copy per workspace. Only the interval
	// survives that; a stale window list in a workspace entry must not be able to
	// gate that workspace on its own hours again.
	const { store, scheduler, dispatcher } = buildTwoWorkspaces({
		settings: { windows: [{ start: '09:00', end: '17:00' }] },
		stale: { windows: [{ start: '18:00', end: '07:00' }] },
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, [], 'the global hours decide, not the stale copy');
	await scheduler.tick();
	assert.deepEqual(
		store.settingsFor('one').windows,
		[{ start: '09:00', end: '17:00' }],
		'and the workspace reads the global hours',
	);
});

test('a workspace with several windows runs in any of them', async () => {
	const store = buildStore(['a', 'b'], { windows: [{ start: '18:00', end: '07:00' }, { start: '12:00', end: '13:00' }] });
	const dispatcher = buildDispatcher(store);
	const noon = Date.parse('2025-01-01T04:30:00Z'); // 12:30 in Shanghai, inside the second window
	const { scheduler } = buildScheduler(store, dispatcher, noon);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a'], 'the lunch slot is a real window');
});

test('a workspace with no window never runs', async () => {
	const store = buildStore(['a'], { windows: [] });
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, [], 'no window means nothing is scheduled, not everything');
	assert.equal(scheduler.isDispatchWindowOpen(WS), false);
});

test('the execution interval holds the next task back after one finishes', async () => {
	// The reported want: "after one task finishes, the next one starts half an hour
	// later". The anchor is written when a task closes, so a pass before it lapses
	// claims nothing.
	const store = buildStore(['a', 'b'], { cooldownMinutes: 30 });
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);

	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a'], 'the first task starts immediately');

	// Close it the way the completion watcher would.
	store.mutate((state) => {
		state.tasks[0].status = TASK_STATUS.done;
		state.workspaces[WS].lastFinishedAt = OPEN;
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a'], 'the next one waits out the interval');
	assert.equal(scheduler.cooldownRemaining(WS), 30 * 60 * 1000, 'and the wait is reported');

	// Half an hour later it is allowed to start.
	const later = new Scheduler({
		store,
		dispatcher,
		now: () => OPEN + 30 * 60 * 1000,
		timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {} },
	});
	await later.tick();
	assert.deepEqual(dispatcher.dispatched, ['a', 'b'], 'and then it runs');
	assert.equal(later.cooldownRemaining(WS), 0);
});

test('a workspace that has never finished a task does not wait', async () => {
	const store = buildStore(['a'], { cooldownMinutes: 60 });
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a'], 'nothing to wait for before the first task');
});

test('the interval never holds back the first task of a new batch', async () => {
	// The reported bug: a batch finished inside the interval, its tasks were
	// archived, and a new task was queued. The anchor is durable per-workspace
	// state, so it outlives the batch that wrote it — and the fresh task then sat
	// there, blocked by a gap that belonged to work already over.
	//
	// The interval is "between two tasks", so a task with nothing finished ahead
	// of it in the list opens the run and must start at once.
	const store = buildStore([], { cooldownMinutes: 30 });
	store.mutate((state) => {
		createTask(state, WS, { prompt: 'the one task in a fresh batch' });
		// A finished batch that has since been archived away, leaving only the
		// anchor behind. Files one minute ago, so the interval is still running.
		state.workspaces[WS].lastFinishedAt = OPEN - 60 * 1000;
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);

	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['the one task in a fresh batch'], 'it runs without waiting');
	assert.equal(scheduler.cooldownRemaining(WS), 0, 'and no wait is reported for it');
});

test('archiving the finished tasks releases the interval for what comes next', async () => {
	// The same defect through the page's own path: filing finished work away
	// leaves the queue with no history, so a task queued afterwards starts the run
	// rather than inheriting the gap.
	const store = buildStore([], { cooldownMinutes: 30 });
	store.mutate((state) => {
		createTask(state, WS, { prompt: 'yesterday' });
		createTask(state, WS, { prompt: 'today' });
		state.tasks[0].status = TASK_STATUS.done;
		state.workspaces[WS].lastFinishedAt = OPEN - 60 * 1000;
		archiveCompleted(state, WS, OPEN);
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);

	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['today'], 'the new batch starts immediately');
});

test('the interval does not hold back a task that is already running', async () => {
	// A task in flight is not something the pacing can delay, so a pass with one
	// running and an anchor already written still does not start a second one.
	const store = buildStore(['a', 'b'], { cooldownMinutes: 30 });
	store.mutate((state) => {
		state.tasks[0].status = TASK_STATUS.running;
		state.workspaces[WS].lastFinishedAt = OPEN;
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, [], 'the running task holds the single slot');
	assert.equal(scheduler.cooldownRemaining(WS), 0, 'and the pacing is not what is holding it back');
});

test('an interval of zero paces nothing', async () => {
	const store = buildStore(['a', 'b'], { cooldownMinutes: 0 });
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	await scheduler.tick();
	store.mutate((state) => {
		state.tasks[0].status = TASK_STATUS.done;
		state.workspaces[WS].lastFinishedAt = OPEN;
	});
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['a', 'b'], 'the next task follows immediately');
});

test('the loop wakes when the interval lapses rather than on the next poll', async () => {
	// A half-hour pause should end on time, so the cooldown is part of the sleep
	// arithmetic and not left to the 15-second poll.
	const store = buildStore(['a'], { cooldownMinutes: 30 });
	store.mutate((state) => {
		state.workspaces[WS].lastFinishedAt = OPEN - 30 * 60 * 1000 + 2000;
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler, armed } = buildScheduler(store, dispatcher, OPEN);
	scheduler.start();
	assert.ok(armed[0] <= 2000, `expected a wake within 2s, got ${armed[0]}ms`);
	scheduler.stop();
});

test('stopping the loop prevents any further pass', async () => {
	const store = buildStore(['first']);
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);
	scheduler.stop();
	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, []);
});

test('two workspaces pace on their own intervals in the same pass', async () => {
	// The point of a per-workspace interval: one workspace waiting out a pause must
	// not hold another one back. Both are open, both have work and a predecessor,
	// and only the one with the interval set waits.
	const store = buildStore([], { cooldownMinutes: 0 });
	store.mutate((state) => {
		patchSettings(state, 'ws-paced', { cooldownMinutes: 30 }, store.seedSettings);
		patchSettings(state, 'ws-free', { cooldownMinutes: 0 }, store.seedSettings);

		for (const workspaceId of ['ws-paced', 'ws-free']) {
			// A finished task, so the next one is a successor rather than the task
			// that opens the run.
			createTask(state, workspaceId, { prompt: 'done in ' + workspaceId }).status = TASK_STATUS.done;
			state.workspaces[workspaceId].lastFinishedAt = OPEN - 60 * 1000;
			createTask(state, workspaceId, { prompt: 'next in ' + workspaceId });
		}
	});
	const dispatcher = buildDispatcher(store);
	const { scheduler } = buildScheduler(store, dispatcher, OPEN);

	await scheduler.tick();
	assert.deepEqual(dispatcher.dispatched, ['next in ws-free'], 'only the unpaced workspace ran');
	assert.ok(scheduler.cooldownRemaining('ws-paced') > 0, 'the paced one is still waiting');
	assert.equal(scheduler.cooldownRemaining('ws-free'), 0, 'and the other has nothing to wait for');
});
