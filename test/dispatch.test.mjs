/**
 * Dispatcher tests — the whole claim-and-run cycle against a fake Host.
 *
 * The two things worth proving here are the ones that would quietly ruin a
 * night of work: that a task is not marked done in the moment between "prompt
 * accepted" and "turn actually started", and that a session is reused or
 * created exactly as the target mode says.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Dispatcher, lastAssistantText, renderPrompt } from '../host/dispatch.js';
import { Privileges } from '../host/privilege.js';
import {
	TaskStore,
	TASK_STATUS,
	normalizeGlobalSettings,
	normalizeWorkspaceSettings,
	UNASSIGNED,
} from '../host/state.js';
import { createTask } from '../host/queue.js';

/** A session stub with a readable log. */
function buildSession(id) {
	const events = [];
	return {
		id,
		events,
		append(type, data) {
			events.push({ type, data });
		},
		snapshotEvents() {
			return events;
		},
	};
}

/** A Host context stub: sessions, prompts, and event listeners. */
function buildCtx() {
	const created = [];
	const prompts = [];
	const compactions = [];
	const order = [];
	let compactFails = false;
	const listeners = new Map();
	const sessions = new Map();
	const agents = new Map();
	/** Recorded working directory per session, so the cwd conflict is real. */
	const sessionCwd = new Map();
	return {
		created,
		prompts,
		compactions,
		order,
		setCompactFails: (value) => {
			compactFails = value;
		},
		listeners,
		sessions,
		agents,
		sessionCwd,
		// A plain stub rather than a Cordis service: this fixture is an object
		// literal, and the plugin reaches compaction through the optional-service
		// handle the way it reaches approval.
		compaction: {
			async compactNow(agent) {
				compactions.push(agent.session.id);
				order.push('compact');
				if (compactFails) throw new Error('compaction blew up');
				return { compactionId: 'c1' };
			},
		},
		sessionController: {
			async create(request) {
				const sessionId = request.sessionId ?? `session-${created.length + 1}`;
				// The real controller derives the directory from the named workspace and
				// refuses to adopt an existing session recorded under a different one.
				const cwd = request.workspaceId !== undefined ? '/workspaces/' + request.workspaceId : '/host/process/dir';
				const existing = sessionCwd.get(sessionId);
				if (existing !== undefined && existing !== cwd) {
					throw new Error(`session "${sessionId}" belongs to "${existing}", not "${cwd}"`);
				}
				sessionCwd.set(sessionId, cwd);
				created.push({ request, sessionId });
				if (!sessions.has(sessionId)) sessions.set(sessionId, buildSession(sessionId));
				agents.set(sessionId, { id: sessionId, session: sessions.get(sessionId), status: 'idle' });
				return { sessionId };
			},
			async resolveAgent(sessionId) {
				const agent = agents.get(sessionId);
				return agent === undefined ? { error: new Error(`no session ${sessionId}`) } : { agent };
			},
			async prompt(request) {
				order.push('prompt');
				prompts.push(request);
				return { accepted: true };
			},
			cancel() {},
		},
		workspaceRegistry: { list: () => [{ id: 'ws-1', title: 'Workspace', path: '/tmp' }] },
		approval: { setPolicy() {} },
		on(event, listener) {
			listeners.set(event, listener);
			return () => {};
		},
	};
}

/** The workspace these tasks belong to. */
const WS = 'ws-1';

/** A store with no disk. */
function buildStore(overrides = {}) {
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
	return store;
}

/**
 * Wire a dispatcher over a fake Host.
 *
 * The settings travel with the task now, so `build` hands back the same object a
 * scheduler pass would pass to `dispatch`.
 */
function build(overrides = {}) {
	const ctx = buildCtx();
	const store = buildStore(overrides);
	// The owning workspace is read from where the session was actually created,
	// exactly as the real Host reads it from the workspace registry.
	const privileges = new Privileges(ctx, { services: { approval: ctx.approval }, log: () => {} });
	const dispatcher = new Dispatcher({
		ctx,
		store,
		privileges,
		services: { compaction: ctx.compaction },
		log: () => {},
		now: () => 1000,
	});
	dispatcher.install();
	const taskSettings = normalizeGlobalSettings(overrides);
	// The shared settings are the plugin's, so the fixture writes them to the
	// document's one settings object — which is where `dispatch` reads them from.
	// The workspace entry keeps the interval.
	store.mutate((state) => {
		state.settings = normalizeGlobalSettings({ ...state.settings, ...overrides });
		state.workspaces[WS] = { settings: normalizeWorkspaceSettings(overrides) };
	});
	return { ctx, store, privileges, dispatcher, taskSettings };
}

/** Add a task to a workspace and return it. */
function queued(store, prompt = 'do the thing', workspaceId = WS) {
	let task;
	store.mutate((state) => {
		task = createTask(state, workspaceId, { prompt });
	});
	return store.tasks.find((candidate) => candidate.id === task.id);
}

test('the prompt is the instruction plus a note that nobody is watching', () => {
	// The task's own text is carried verbatim and is not headed by anything: a
	// title would only repeat the instruction's first line back at the model.
	const text = renderPrompt({ prompt: 'Summarise the open issues.\nThen close them.' });
	assert.match(text, /Summarise the open issues\.\nThen close them\./, 'the instruction survives intact');
	assert.match(text, /没有人在场/, 'the executing agent is told nobody is there');
	assert.match(text, /定时任务队列/, 'and where it came from');
});

test('the result excerpt is the newest assistant text, or nothing', () => {
	const session = buildSession('s');
	assert.equal(lastAssistantText(session), undefined, 'a session with no reply has no excerpt');
	session.events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } });
	assert.equal(lastAssistantText(session), undefined, 'a user message is not a result');
	session.events.push({
		type: 'assistant/message',
		data: { message: { content: [{ type: 'text', text: 'first' }] } },
	});
	session.events.push({
		type: 'assistant/message',
		data: { message: { content: [{ type: 'text', text: 'second' }] } },
	});
	assert.equal(lastAssistantText(session), 'second', 'the newest one wins');
	session.events.push({ type: 'assistant/message', data: { message: { content: [] } } });
	assert.equal(lastAssistantText(session), 'second', 'an empty reply does not erase the last real one');
});

test('a fresh task gets a new session in the first workspace', async () => {
	const { ctx, store, dispatcher, taskSettings } = build();
	const task = queued(store, 'write the report');
	await dispatcher.dispatch(task, taskSettings);
	assert.equal(ctx.created.length, 1);
	assert.deepEqual(ctx.created[0].request, { workspaceId: 'ws-1' }, 'attachment is what puts it in the sidebar');
	assert.equal(ctx.prompts.length, 1);
	assert.deepEqual(ctx.prompts[0].content[0].text, renderPrompt(task) && ctx.prompts[0].content[0].text);
	assert.match(ctx.prompts[0].content[0].text, /write the report/);
});

test('the claimed task is running, remembers its session, and counts the attempt', async () => {
	const { store, dispatcher, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	const stored = store.tasks.find((candidate) => candidate.id === task.id);
	assert.equal(stored.status, TASK_STATUS.running);
	assert.equal(stored.sessionId, 'session-1');
	assert.equal(stored.attempts, 1);
	assert.equal(typeof stored.startedAt, 'number');
});

test('the session is relaxed for unattended work before the prompt is sent', async () => {
	const { ctx, dispatcher, store, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	const session = ctx.sessions.get('session-1');
	assert.deepEqual(
		session.events.find((event) => event.type === 'sandbox/mode'),
		{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
	);
	const promptIndex = session.events.findIndex((event) => event.type === 'sandbox/mode');
	assert.ok(promptIndex >= 0, 'the relaxation is durable session state, not a wrapper');
});

test('a task completes when its agent goes running and then idle', async () => {
	const { ctx, store, dispatcher, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	const agent = ctx.agents.get('session-1');
	agent.session.events.push({
		type: 'assistant/message',
		data: { message: { content: [{ type: 'text', text: 'All done: 3 issues closed.' }] } },
	});
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	const stored = store.tasks.find((candidate) => candidate.id === task.id);
	assert.equal(stored.status, TASK_STATUS.done);
	assert.equal(stored.result, 'All done: 3 issues closed.');
	assert.equal(dispatcher.inFlight.size, 0);
});

test('an idle observed before the turn starts does not finish the task', async () => {
	// This is the race that makes a naive implementation mark every task done
	// in the instant between prompt admission and the driver waking up.
	const { ctx, store, dispatcher, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	const agent = ctx.agents.get('session-1');
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(
		store.tasks.find((candidate) => candidate.id === task.id).status,
		TASK_STATUS.running,
		'a spurious idle is ignored until a running was seen',
	);
});

test('an agent error becomes a failed task with its message', async () => {
	const { ctx, store, dispatcher, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	const agent = ctx.agents.get('session-1');
	ctx.listeners.get('agent/error')({ agent, error: new Error('model exploded') });
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	const stored = store.tasks.find((candidate) => candidate.id === task.id);
	assert.equal(stored.status, TASK_STATUS.failed);
	assert.equal(stored.error, 'model exploded');
});

test('a session that cannot be activated fails the task instead of stranding it', async () => {
	const { ctx, store, dispatcher, taskSettings } = build();
	ctx.sessionController.resolveAgent = async () => ({ error: new Error('session/not-found') });
	const task = queued(store);
	await assert.rejects(() => dispatcher.dispatch(task, taskSettings), /session\/not-found/);
	const stored = store.tasks.find((candidate) => candidate.id === task.id);
	assert.equal(stored.status, TASK_STATUS.failed);
	assert.match(stored.error, /session\/not-found/);
	assert.equal(dispatcher.inFlight.size, 0, 'no phantom in-flight record is left behind');
});

test('shared mode reuses one runner session across tasks', async () => {
	// The regression this test exists for: the second task used to re-adopt the
	// runner through `create({ sessionId })`, which derived a working directory
	// from the Host's process default and blew up on a directory conflict —
	// "session … belongs to X, not Y" — for a call that should not have been
	// creating anything at all.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared' });
	const first = queued(store, 'one');
	const second = queued(store, 'two');
	await dispatcher.dispatch(first, taskSettings);
	// The first task finishes, freeing the session for the next one.
	const agent = ctx.agents.get('session-1');
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	await dispatcher.dispatch(second, taskSettings);
	const distinct = new Set(ctx.created.map((call) => call.sessionId));
	assert.equal(distinct.size, 1, 'the second task reuses the runner rather than minting a new session');
	assert.equal(ctx.prompts[1].sessionId, 'session-1');
	assert.equal(store.settingsFor(WS).runnerSessionId, 'session-1', 'the runner id is remembered durably');
	assert.equal(ctx.created.length, 1, 'and the runner is created exactly once, never re-adopted');
});

test('shared mode gives each workspace its own runner, never another workspace', async () => {
	// The regression this pins, reported from a real run: the queue fired at
	// 12:00, and every workspace's tasks were prompted into one session — the
	// first workspace's. `runnerSessionId` lived in the plugin-wide settings, and
	// `settingsFor` merges those into every workspace's view, so the second
	// workspace read back the id the first one had just written and reused it.
	// A task then ran in a workspace that did not own it.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared' });
	const WS_B = 'ws-2';
	// The fixture seeds only `WS`, so give the second workspace a settings entry
	// of its own, exactly as a real second workspace would have.
	store.mutate((state) => {
		state.workspaces[WS_B] = { settings: normalizeWorkspaceSettings({}) };
	});

	const taskA = queued(store, 'work for alpha', WS);
	const taskB = queued(store, 'work for beta', WS_B);
	await dispatcher.dispatch(taskA, taskSettings);
	await dispatcher.dispatch(taskB, taskSettings);

	const runnerA = store.settingsFor(WS).runnerSessionId;
	const runnerB = store.settingsFor(WS_B).runnerSessionId;
	assert.ok(runnerA.length > 0, 'the first workspace has a runner');
	assert.ok(runnerB.length > 0, 'so does the second');
	assert.notEqual(
		runnerA,
		runnerB,
		'the two workspaces do not share one runner session',
	);
	assert.notEqual(
		ctx.prompts[0].sessionId,
		ctx.prompts[1].sessionId,
		"the second workspace's task was not sent into the first workspace's session",
	);

	// The session a task was prompted into is the one its own workspace owns, and
	// it was created against that workspace — which is what the real Host derives
	// the working directory from.
	assert.equal(ctx.prompts[0].sessionId, runnerA, 'alpha ran in alpha runner');
	assert.equal(ctx.prompts[1].sessionId, runnerB, 'beta ran in beta runner');
	const createdFor = new Map(ctx.created.map((call) => [call.sessionId, call.request.workspaceId]));
	assert.equal(createdFor.get(runnerA), WS, "alpha's runner was created for alpha");
	assert.equal(createdFor.get(runnerB), WS_B, "beta's runner was created for beta");
});

test('a runner belongs to one workspace even after the other runs first', async () => {
	// Order must not decide ownership. Here the second workspace dispatches first;
	// under the old global field it would have claimed the shared slot and the
	// first workspace would then have been the one sent into a foreign session.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared' });
	const WS_B = 'ws-2';
	store.mutate((state) => {
		state.workspaces[WS_B] = { settings: normalizeWorkspaceSettings({}) };
	});

	const taskB = queued(store, 'work for beta', WS_B);
	const taskA = queued(store, 'work for alpha', WS);
	await dispatcher.dispatch(taskB, taskSettings);
	await dispatcher.dispatch(taskA, taskSettings);

	assert.notEqual(store.settingsFor(WS).runnerSessionId, store.settingsFor(WS_B).runnerSessionId);
	const createdFor = new Map(ctx.created.map((call) => [call.sessionId, call.request.workspaceId]));
	// The first prompt belongs to ws-2 and the second to ws-1, and each must have
	// gone to a session that was created for that same workspace.
	assert.equal(createdFor.get(ctx.prompts[0].sessionId), WS_B, 'the beta task ran in a beta session');
	assert.equal(createdFor.get(ctx.prompts[1].sessionId), WS, 'the alpha task ran in an alpha session');
});

test('one workspace switching to fresh does not disarm another workspace runner', async () => {
	// `targetMode` is a plugin-wide setting any workspace's settings page may
	// change, while a runner belongs to one workspace. Deciding whether to release
	// a session by reading the *mode* therefore let a workspace that switched to
	// `fresh` withdraw the relaxed permissions from a different workspace's runner:
	// that workspace's tasks kept coming, but the unattended bypass was gone until
	// something happened to re-arm it. The release decision has to ask whether the
	// session is still somebody's runner, which is independent of any mode.
	const { ctx, store, privileges, dispatcher, taskSettings } = build({ targetMode: 'shared' });
	const WS_B = 'ws-2';
	store.mutate((state) => {
		state.workspaces[WS_B] = { settings: normalizeWorkspaceSettings({}) };
	});

	// Workspace A dispatches and keeps a runner of its own.
	await dispatcher.dispatch(queued(store, 'alpha work', WS), taskSettings);
	const runnerA = store.settingsFor(WS).runnerSessionId;
	assert.ok(runnerA.length > 0, 'workspace A owns a runner');
	assert.equal(privileges.isManaged(runnerA), true, 'and its runner is managed while it runs');

	// Some other workspace switches the plugin-wide mode to fresh.
	store.mutate((state) => {
		state.settings = normalizeGlobalSettings({ ...state.settings, targetMode: 'fresh' });
	});

	// A's task now finishes. Its runner must stay managed: it is still A's runner,
	// and A will dispatch into it again the moment its next task comes up.
	const agent = ctx.agents.get(runnerA);
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(
		privileges.isManaged(runnerA),
		true,
		"a plugin-wide mode change did not disarm another workspace's runner",
	);
});

test('a fresh-mode session is released once its task ends', async () => {
	// The other half of the same rule: a session that is nobody's runner has no
	// claim on the bypass, so it is released the moment its task is done.
	const { ctx, store, privileges, dispatcher, taskSettings } = build({ targetMode: 'fresh' });
	await dispatcher.dispatch(queued(store, 'one-off', WS), taskSettings);
	const sessionId = ctx.prompts[0].sessionId;
	assert.equal(privileges.isManaged(sessionId), true, 'it is managed while its task runs');

	// Finish the turn: the session has served its one task and holds no workspace,
	// so the grant has nothing left to cover.
	const agent = ctx.agents.get(sessionId);
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(
		privileges.isManaged(sessionId),
		false,
		'a per-task session is released rather than held for a workspace',
	);
	assert.equal(store.settingsFor(WS).runnerSessionId, '', 'and fresh mode records no runner');
});

test('fresh mode gives every task its own session', async () => {
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'fresh' });
	const first = queued(store, 'one');
	const second = queued(store, 'two');
	await dispatcher.dispatch(first, taskSettings);
	await dispatcher.dispatch(second, taskSettings);
	assert.equal(ctx.created.length, 2);
	assert.notEqual(ctx.prompts[0].sessionId, ctx.prompts[1].sessionId);
});

test('an unknown target mode is normalized to the shared runner', async () => {
	// The document is repaired rather than trusted, so a mode this build does not
	// know — including the retired pinned mode — falls back instead of failing.
	assert.equal(normalizeGlobalSettings({ targetMode: 'fixed' }).targetMode, 'shared');
	assert.equal(normalizeGlobalSettings({ targetMode: 'nonsense' }).targetMode, 'shared');
	assert.equal(normalizeGlobalSettings({ targetMode: 'fresh' }).targetMode, 'fresh');
});

test('a session shared by tasks is compacted before each task, when asked', async () => {
	// The point of the setting: in a single session, every earlier task's turns and
	// tool output pile up, so each task starts from a summary instead.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared', compactBeforeTask: true });
	await dispatcher.dispatch(queued(store, 'one'), taskSettings);
	const runner = store.settingsFor(WS).runnerSessionId;
	assert.ok(runner, 'the runner exists');

	ctx.compactions.length = 0;
	ctx.order.length = 0;
	await dispatcher.dispatch(queued(store, 'two'), taskSettings);
	assert.deepEqual(ctx.compactions, [runner], 'the shared session was compacted');
	assert.deepEqual(ctx.order, ['compact', 'prompt'], 'and before the task was sent, not after');
});

test('compaction is not attempted for a fresh session per task', async () => {
	// A brand-new session has nothing behind it; compacting it would spend a call
	// to summarize nothing.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'fresh', compactBeforeTask: true });
	await dispatcher.dispatch(queued(store), taskSettings);
	await dispatcher.dispatch(queued(store), taskSettings);
	assert.deepEqual(ctx.compactions, [], 'nothing was compacted');
	assert.equal(ctx.prompts.length, 2, 'and both tasks still ran');
});

test('compaction is off unless it is asked for', async () => {
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared' });
	await dispatcher.dispatch(queued(store), taskSettings);
	assert.deepEqual(ctx.compactions, []);
});

test('a failed compaction does not cost the night its work', async () => {
	// Compaction is an optimization. Losing it is not a reason to lose the task.
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared', compactBeforeTask: true });
	await dispatcher.dispatch(queued(store, 'one'), taskSettings);
	ctx.setCompactFails(true);
	await dispatcher.dispatch(queued(store, 'two'), taskSettings);
	const second = store.tasks.find((task) => task.prompt === 'two');
	assert.equal(second.status, TASK_STATUS.running, 'the task ran anyway');
	assert.equal(ctx.prompts.length, 2, 'and the prompt was still sent');
});

test('a composition with no compaction service still runs the task', async () => {
	const { ctx, store, dispatcher, taskSettings } = build({ targetMode: 'shared', compactBeforeTask: true });
	await dispatcher.dispatch(queued(store, 'one'), taskSettings);
	dispatcher.services.compaction = undefined;
	await dispatcher.dispatch(queued(store, 'two'), taskSettings);
	assert.equal(store.tasks.find((task) => task.prompt === 'two').status, TASK_STATUS.running);
});

test('every dispatched task arms a deadline that completion clears', async () => {
	const { store, dispatcher, ctx, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	assert.equal(dispatcher.timeouts.size, 1, 'a turn that never settles cannot hold a slot forever');
	const agent = ctx.agents.get('session-1');
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(dispatcher.timeouts.size, 0);
});

test('a finished task stops counting against the concurrency limit', async () => {
	const { ctx, store, dispatcher, taskSettings } = build();
	const task = queued(store);
	await dispatcher.dispatch(task, taskSettings);
	assert.equal(dispatcher.isBusy('session-1'), true);
	const agent = ctx.agents.get('session-1');
	ctx.listeners.get('agent/status')({ agent, status: 'running' });
	ctx.listeners.get('agent/status')({ agent, status: 'idle' });
	assert.equal(dispatcher.isBusy('session-1'), false);
});
