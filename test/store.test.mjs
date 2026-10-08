/**
 * Durable-store tests.
 *
 * The store is where a crash becomes visible, so the cases here are the
 * failure modes: a missing file, a corrupted file, a task that was running
 * when the Host stopped, and a hand-edited field that cannot be trusted. The
 * filesystem is injected so none of this needs a real disk.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
	DOCUMENT_VERSION,
	DEFAULT_WORKSPACE_SETTINGS,
	TaskStore,
	UNASSIGNED,
	migrate,
	normalizeState,
	normalizeTask,
	normalizeWorkspaceSettings,
	TASK_STATUS,
} from '../host/state.js';
import { patchSettings } from '../host/queue.js';

/** An in-memory filesystem that records what was written. */
function memoryFs(initial = {}) {
	const files = new Map(Object.entries(initial));
	return {
		files,
		writes: [],
		mkdirSync() {},
		readFileSync(path) {
			if (!files.has(path)) {
				const error = new Error(`ENOENT: ${path}`);
				error.code = 'ENOENT';
				throw error;
			}
			return files.get(path);
		},
		writeFileSync(path, text) {
			files.set(path, text);
			this.writes.push(path);
		},
		renameSync(from, to) {
			files.set(to, files.get(from));
			files.delete(from);
		},
	};
}

test('workspace settings are repaired field by field', () => {
	const settings = normalizeWorkspaceSettings({
		enabled: 'yes',
		windows: [{ start: '25:00', end: '07:00' }, { start: '09:00', end: '17:00' }],
		timeZone: 'Mars/Olympus',
		autoApprove: false,
		targetMode: 'nonsense',
		taskTimeoutMinutes: -5,
	});
	assert.equal(settings.enabled, true, 'a non-boolean falls back');
	assert.deepEqual(settings.windows, [{ start: '09:00', end: '17:00' }], 'the invalid window is dropped');
	assert.equal(settings.timeZone, 'Asia/Shanghai', 'an unknown zone falls back');
	assert.equal(settings.autoApprove, false, 'a valid boolean survives');
	assert.equal(settings.targetMode, 'shared', 'the shared runner is the default');
	assert.equal(settings.taskTimeoutMinutes, 1, 'clamped to the floor');
});

test('a settings object with no window list falls back to the default night window', () => {
	assert.deepEqual(
		normalizeWorkspaceSettings({ enabled: true }).windows,
		DEFAULT_WORKSPACE_SETTINGS.windows.map((window) => ({ ...window })),
	);
});

test('the legacy startTime/endTime pair still produces the hours it meant', () => {
	// A composition config or a v1 document written before windows were a list.
	const settings = normalizeWorkspaceSettings({ startTime: '22:00', endTime: '06:00', timeZone: 'UTC' });
	assert.deepEqual(settings.windows, [{ start: '22:00', end: '06:00' }]);
	assert.equal(settings.timeZone, 'UTC');
});

test('an empty window list is kept as an explicit answer', () => {
	assert.deepEqual(normalizeWorkspaceSettings({ windows: [] }).windows, [], 'nothing is scheduled');
	assert.deepEqual(normalizeWorkspaceSettings({ windows: 'nope' }).windows, [{ start: '18:00', end: '07:00' }]);
});

test('a task with no usable text is dropped, not repaired', () => {
	assert.equal(normalizeTask({ prompt: '   ' }), undefined);
	assert.equal(normalizeTask(null), undefined);
	assert.equal(normalizeTask('nope'), undefined);
	const task = normalizeTask({ prompt: 'do the thing' });
	assert.equal(task.prompt, 'do the thing');
	assert.equal(task.workspaceId, UNASSIGNED, 'a task with no workspace is unassigned');
	assert.equal(task.title, undefined, 'a task has no title of its own');
	assert.equal(task.status, TASK_STATUS.queued);
	assert.equal(typeof task.id, 'string');
});

test('a task stored as running is re-queued with an explanation', () => {
	// The Host cannot survive its own crash, so nothing can still be executing
	// a task it stored as running. Leaving the row alone would strand it.
	const task = normalizeTask({ prompt: 'x', status: TASK_STATUS.running, sessionId: 'session-1' });
	assert.equal(task.status, TASK_STATUS.queued);
	assert.match(task.error, /restart/);
	assert.equal(task.sessionId, 'session-1', 'the session is remembered for the retry');
});

test('a task keeps the workspace it was created in', () => {
	const task = normalizeTask({ prompt: 'x', workspaceId: 'ws-1' });
	assert.equal(task.workspaceId, 'ws-1');
});

test('tasks are ordered by their explicit sequence', () => {
	const state = normalizeState({
		tasks: [
			{ prompt: 'third', seq: 3, createdAt: 1 },
			{ prompt: 'first', seq: 1, createdAt: 1 },
			{ prompt: 'second', seq: 2, createdAt: 1 },
		],
	});
	assert.deepEqual(
		state.tasks.map((task) => task.prompt),
		['first', 'second', 'third'],
	);
});

test('a missing file opens an empty queue seeded from config', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs, seedSettings: { windows: [{ start: '20:00', end: '06:00' }] } });
	store.load();
	assert.equal(store.tasks.length, 0);
	assert.deepEqual(store.settingsFor('ws-1').windows, [{ start: '20:00', end: '06:00' }]);
});

test('a workspace that has never been seen reads the seed without writing it', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs, seedSettings: { timeZone: 'UTC' } });
	store.load();
	store.persist();
	assert.equal(store.settingsFor('ws-1').timeZone, 'UTC');
	assert.equal(store.state.workspaces['ws-1'], undefined, 'reading a workspace does not materialize it');
});

test('two workspaces hold two independent queues', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	store.mutate((state) => {
		state.tasks.push(normalizeTask({ prompt: 'a', id: 'a', seq: 1, workspaceId: 'ws-1' }));
		state.tasks.push(normalizeTask({ prompt: 'b', id: 'b', seq: 2, workspaceId: 'ws-2' }));
	});
	assert.deepEqual(store.tasksOf('ws-1').map((task) => task.id), ['a']);
	assert.deepEqual(store.tasksOf('ws-2').map((task) => task.id), ['b']);
	assert.deepEqual(store.workspacesWithTasks().sort(), ['ws-1', 'ws-2']);
});

test('the seed does not overwrite hours the user has already edited', () => {
	const seeded = JSON.stringify(
		normalizeState({
			workspaces: { 'ws-1': { settings: { windows: [{ start: '22:00', end: '05:00' }] } } },
			tasks: [],
		}),
	);
	const fs = memoryFs({ '/q.json': seeded });
	const store = new TaskStore({
		file: '/q.json',
		fs,
		seedSettings: { windows: [{ start: '20:00', end: '06:00' }] },
	});
	store.load();
	assert.deepEqual(
		store.settingsFor('ws-1').windows,
		[{ start: '22:00', end: '05:00' }],
		'the durable window wins over the composition config',
	);
	// A workspace that has never been seen still takes the seed.
	assert.deepEqual(store.settingsFor('ws-2').windows, [{ start: '20:00', end: '06:00' }]);
});

test('a corrupted file opens empty and reports the error', () => {
	const errors = [];
	const fs = memoryFs({ '/q.json': '{not json' });
	const store = new TaskStore({ file: '/q.json', fs, onError: (error) => errors.push(error) });
	store.load();
	assert.equal(store.tasks.length, 0);
	assert.equal(errors.length, 1);
});

test('a write is atomic: the document lands under its real name', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	store.mutate((state) => {
		state.tasks.push(normalizeTask({ prompt: 'persisted', id: 'a', seq: 1 }));
	});
	assert.ok(fs.files.has('/q.json'), 'the document exists under its real name');
	assert.ok(!fs.files.has('/q.json.tmp'), 'the temporary file was renamed away');
	assert.match(fs.files.get('/q.json'), /persisted/);
});

test('a reopen reads back exactly what was committed', () => {
	const fs = memoryFs();
	const first = new TaskStore({ file: '/q.json', fs });
	first.load();
	first.mutate((state) => {
		state.tasks.push(normalizeTask({ prompt: 'survives', id: 'a', seq: 7, workspaceId: 'ws-1' }));
		state.workspaces['ws-1'] = { settings: normalizeWorkspaceSettings({ windows: [{ start: '21:30', end: '06:00' }] }) };
	});
	const second = new TaskStore({ file: '/q.json', fs });
	second.load();
	assert.equal(second.tasks.length, 1);
	assert.equal(second.tasks[0].seq, 7);
	assert.equal(second.tasks[0].workspaceId, 'ws-1');
	assert.deepEqual(second.settingsFor('ws-1').windows, [{ start: '21:30', end: '06:00' }]);
});

test('a pre-workspace document is migrated, not discarded', () => {
	// A v1 document: one global settings object, a flat task list, no workspaces.
	const legacy = {
		version: 1,
		settings: {
			enabled: true,
			startTime: '20:00',
			endTime: '05:30',
			timeZone: 'UTC',
			autoApprove: false,
			workspaceId: 'the-one-i-used',
		},
		tasks: [{ id: 'old', prompt: 'still mine', createdAt: 1, seq: 1 }],
	};
	const { document, seed } = migrate(legacy);
	assert.equal(document.version, DOCUMENT_VERSION);
	assert.equal(document.tasks.length, 1, 'the queued work survives the upgrade');
	assert.equal(document.tasks[0].workspaceId, UNASSIGNED, 'and is honest about belonging to no workspace');
	assert.equal(document.tasks[0].prompt, 'still mine');
	// The old hours become the seed every workspace starts from.
	assert.deepEqual(seed.windows, [{ start: '20:00', end: '05:30' }]);
	assert.equal(seed.timeZone, 'UTC');
	assert.equal(seed.autoApprove, false);
	assert.deepEqual(
		document.workspaces['the-one-i-used'].settings.windows,
		[{ start: '20:00', end: '05:30' }],
		'the hours land on the workspace the old settings named',
	);

	const fs = memoryFs({ '/q.json': JSON.stringify(legacy) });
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	assert.equal(store.tasksOf(UNASSIGNED).length, 1);
	assert.deepEqual(store.settingsFor('ws-1').windows, [{ start: '20:00', end: '05:30' }], 'a new workspace inherits them');
});

test('subscribers hear about committed changes only', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	let notifications = 0;
	store.subscribe(() => {
		notifications += 1;
	});
	store.mutate((state) => {
		state.tasks.push(normalizeTask({ prompt: 'x', id: 'a', seq: 1 }));
	});
	assert.equal(notifications, 1);
});

test('mutate hands back the callback result', () => {
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	const result = store.mutate(() => 'the-value');
	assert.equal(result, 'the-value');
});

test('the execution interval is per workspace, not global', () => {
	// Each workspace keeps its own hours *and* its own interval: one can pace a
	// batch out while another runs straight through. The value lives in the
	// workspace's settings, so setting it in one place cannot reach the other.
	const fs = memoryFs();
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	store.mutate((state) => {
		patchSettings(state, 'ws-1', { cooldownMinutes: 30 });
		patchSettings(state, 'ws-2', { cooldownMinutes: 5 });
	});
	assert.equal(store.settingsFor('ws-1').cooldownMinutes, 30);
	assert.equal(store.settingsFor('ws-2').cooldownMinutes, 5);

	// A workspace never seen reads the seed without being written, and the others
	// are unaffected by that read.
	assert.equal(store.settingsFor('ws-3').cooldownMinutes, DEFAULT_WORKSPACE_SETTINGS.cooldownMinutes);
	assert.equal(store.settingsFor('ws-1').cooldownMinutes, 30, 'still its own value');
});

test('a per-workspace interval survives a reopen', () => {
	// It is durable state, not a session preference: the queue has to keep pacing
	// after the Host restarts.
	const fs = memoryFs();
	const first = new TaskStore({ file: '/q.json', fs });
	first.load();
	first.mutate((state) => patchSettings(state, 'ws-1', { cooldownMinutes: 45 }));

	const reopened = new TaskStore({ file: '/q.json', fs });
	reopened.load();
	assert.equal(reopened.settingsFor('ws-1').cooldownMinutes, 45);
});
