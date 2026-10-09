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
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_WORKSPACE_SETTINGS,
	TaskStore,
	UNASSIGNED,
	migrate,
	normalizeState,
	normalizeTask,
	normalizeGlobalSettings,
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

test('the shared settings are repaired field by field', () => {
	const settings = normalizeGlobalSettings({
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

test('a workspace entry keeps its interval and its runner, and nothing else', () => {
	// The plugin-wide fields are the plugin's. Feeding them to a workspace must
	// not store them there, or the per-workspace copy this model removed would
	// come straight back the next time a v2-shaped object was normalized.
	//
	// `runnerSessionId` is the deliberate exception: it names a session, and a
	// session belongs to the workspace it was created in. It was plugin-wide
	// once, which is exactly how one workspace's tasks ended up prompted into
	// another workspace's conversation.
	const settings = normalizeWorkspaceSettings({
		cooldownMinutes: 45,
		runnerSessionId: 'session-runner',
		windows: [{ start: '09:00', end: '17:00' }],
		timeZone: 'UTC',
		targetMode: 'fresh',
		enabled: false,
	});
	assert.equal(settings.cooldownMinutes, 45, 'the interval is kept');
	assert.equal(settings.runnerSessionId, 'session-runner', 'the runner the workspace owns is kept');
	assert.deepEqual(
		Object.keys(settings),
		['cooldownMinutes', 'runnerSessionId'],
		'and nothing else is stored',
	);
});

test('a settings object with no window list falls back to the default night window', () => {
	assert.deepEqual(
		normalizeGlobalSettings({ enabled: true }).windows,
		DEFAULT_GLOBAL_SETTINGS.windows.map((window) => ({ ...window })),
	);
});

test('the legacy startTime/endTime pair still produces the hours it meant', () => {
	// A composition config or a v1 document written before windows were a list.
	const settings = normalizeGlobalSettings({ startTime: '22:00', endTime: '06:00', timeZone: 'UTC' });
	assert.deepEqual(settings.windows, [{ start: '22:00', end: '06:00' }]);
	assert.equal(settings.timeZone, 'UTC');
});

test('an empty window list is kept as an explicit answer', () => {
	assert.deepEqual(normalizeGlobalSettings({ windows: [] }).windows, [], 'nothing is scheduled');
	assert.deepEqual(normalizeGlobalSettings({ windows: 'nope' }).windows, [{ start: '18:00', end: '07:00' }]);
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

test('the durable settings win over the composition config', () => {
	// The composition config seeds a *new* document. Once the document holds its
	// own settings, those are the truth — otherwise restarting the Host would
	// undo every change the user made in the page.
	const seeded = JSON.stringify(
		normalizeState({
			settings: { windows: [{ start: '22:00', end: '05:00' }] },
			workspaces: {},
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
		store.globalSettings().windows,
		[{ start: '22:00', end: '05:00' }],
		'the durable hours win over the composition config',
	);
	assert.deepEqual(
		store.settingsFor('any-workspace').windows,
		[{ start: '22:00', end: '05:00' }],
		'and every workspace reads them, seen or not',
	);
});

test('a fresh document takes the composition config as its settings', () => {
	const fs = memoryFs();
	const store = new TaskStore({
		file: '/q.json',
		fs,
		seedSettings: { windows: [{ start: '20:00', end: '06:00' }], timeZone: 'UTC' },
	});
	store.load();
	assert.deepEqual(store.globalSettings().windows, [{ start: '20:00', end: '06:00' }]);
	assert.equal(store.globalSettings().timeZone, 'UTC');
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
		state.settings = normalizeGlobalSettings({ windows: [{ start: '21:30', end: '06:00' }] });
		state.workspaces['ws-1'] = { settings: normalizeWorkspaceSettings({ cooldownMinutes: 15 }) };
	});
	const second = new TaskStore({ file: '/q.json', fs });
	second.load();
	assert.equal(second.tasks.length, 1);
	assert.equal(second.tasks[0].seq, 7);
	assert.equal(second.tasks[0].workspaceId, 'ws-1');
	assert.deepEqual(second.settingsFor('ws-1').windows, [{ start: '21:30', end: '06:00' }]);
	assert.equal(second.settingsFor('ws-1').cooldownMinutes, 15, 'and the interval came back too');
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
	const { document } = migrate(legacy);
	assert.equal(document.version, DOCUMENT_VERSION);
	assert.equal(document.tasks.length, 1, 'the queued work survives the upgrade');
	assert.equal(document.tasks[0].workspaceId, UNASSIGNED, 'and is honest about belonging to no workspace');
	assert.equal(document.tasks[0].prompt, 'still mine');
	// The old hours are what every workspace now runs on, stored once.
	assert.deepEqual(document.settings.windows, [{ start: '20:00', end: '05:30' }]);
	assert.equal(document.settings.timeZone, 'UTC');
	assert.equal(document.settings.autoApprove, false);

	const fs = memoryFs({ '/q.json': JSON.stringify(legacy) });
	const store = new TaskStore({ file: '/q.json', fs });
	store.load();
	assert.equal(store.tasksOf(UNASSIGNED).length, 1);
	assert.deepEqual(
		store.settingsFor('ws-1').windows,
		[{ start: '20:00', end: '05:30' }],
		'every workspace reads the carried-forward hours',
	);
});

test('a v2 document has its shared fields lifted and its intervals kept', () => {
	// v2 stored a full copy of every setting against each workspace. The shared
	// fields are lifted into one place — taking the value most workspaces already
	// used — while each workspace keeps its own interval.
	const v2 = {
		version: 2,
		workspaces: {
			'ws-a': {
				settings: { windows: [{ start: '18:00', end: '07:00' }], timeZone: 'UTC', cooldownMinutes: 30 },
				lastFinishedAt: 1234,
			},
			'ws-b': {
				settings: { windows: [{ start: '18:00', end: '07:00' }], timeZone: 'UTC', cooldownMinutes: 5 },
			},
			'ws-c': {
				settings: { windows: [{ start: '09:00', end: '17:00' }], timeZone: 'UTC', cooldownMinutes: 0 },
			},
		},
		tasks: [{ id: 't', prompt: 'work', createdAt: 1, seq: 1, workspaceId: 'ws-a' }],
	};
	const { document } = migrate(v2);
	assert.equal(document.version, DOCUMENT_VERSION);
	// Two of three workspaces used the night window, so that is the one kept.
	assert.deepEqual(document.settings.windows, [{ start: '18:00', end: '07:00' }], 'the majority value wins');
	assert.equal(document.settings.timeZone, 'UTC');

	assert.equal(document.workspaces['ws-a'].settings.cooldownMinutes, 30);
	assert.equal(document.workspaces['ws-b'].settings.cooldownMinutes, 5);
	assert.equal(document.workspaces['ws-c'].settings.cooldownMinutes, 0);
	assert.deepEqual(
		Object.keys(document.workspaces['ws-a'].settings),
		['cooldownMinutes', 'runnerSessionId'],
		'and a workspace entry carries only what a workspace owns',
	);
	assert.equal(document.workspaces['ws-a'].lastFinishedAt, 1234, 'the cooldown anchor is untouched');
	assert.equal(document.tasks.length, 1, 'tasks survive');

	// Every workspace now reports the one shared answer, whatever its old copy said.
	const store = new TaskStore({ file: '/q.json', fs: memoryFs({ '/q.json': JSON.stringify(v2) }) });
	store.load();
	for (const id of ['ws-a', 'ws-b', 'ws-c']) {
		assert.deepEqual(
			store.settingsFor(id).windows,
			[{ start: '18:00', end: '07:00' }],
			`${id} reads the shared hours`,
		);
	}
	assert.equal(store.settingsFor('ws-a').cooldownMinutes, 30, 'while keeping its own interval');
	assert.equal(store.settingsFor('ws-b').cooldownMinutes, 5);
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
	// The interval is the setting meant to differ between projects: one workspace
	// can pace a batch out while another runs straight through. It lives in the
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
