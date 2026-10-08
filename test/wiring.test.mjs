/**
 * Wiring test: the real plugin entry against the real Cordis runtime.
 *
 * This is the test that would have caught the bug it exists to prevent. Cordis
 * **throws** on a property read for a service a plugin did not declare, so
 * reaching for `ctx.approval` or `ctx.workspaceRegistry` and catching the throw
 * looks like a working fallback while permanently disabling the richer path.
 * Only a real `Context` reproduces that, so this test builds one: it registers
 * the services the plugin needs, activates the plugin, and then drives a task
 * from the HTTP route all the way to a finished session.
 *
 * Cordis is resolved out of an installed DSH profile rather than a local
 * dependency, so the test skips cleanly on a machine with no profile instead of
 * failing for a reason that has nothing to do with the plugin.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

// The module namespace itself is what the Host Loader hands Cordis, so the
// test passes it verbatim: `Config` then runs for real, exactly as in the app.
import * as pluginModule from '../host/plugin.js';

/** Where a DSH profile with `@deepseek-ai/cordis` installed may live. */
function cordisEntry() {
	const home = process.env.DSH_HOME || join(homedir(), '.dsh');
	const profile = process.env.DSH_PROFILE || 'desktop';
	const candidates = [
		join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
		join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

const entry = cordisEntry();

/** A session stub with a readable log, as the dispatcher requires. */
function fakeSession(id) {
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

/**
 * Boot a real Cordis app with the plugin mounted, plus the services it needs.
 * @returns {Promise<object>} the app handle.
 */
async function boot(existingFile) {
	const cordis = await import(pathToFileURL(entry).href);
	const { Context, Service } = cordis;

	const sessions = new Map();
	const agents = new Map();
	const prompts = [];
	const createdRequests = [];
	const policyChanges = [];
	const routes = [];

	class WorkspaceRegistry extends Service {
		constructor(ctx) {
			super(ctx, 'workspaceRegistry');
		}
		list() {
			return [
				{ id: 'ws-1', title: 'Project', path: '/tmp/project', sessionIds: ['session-viewing'] },
				{ id: 'ws-2', title: 'Other', path: '/tmp/other', sessionIds: ['session-viewing-2'] },
			];
		}
	}

	class Approval extends Service {
		constructor(ctx) {
			super(ctx, 'approval');
		}
		setPolicy(agent, policy) {
			policyChanges.push({ sessionId: agent.session.id, policy });
		}
	}

	class SessionController extends Service {
		constructor(ctx) {
			super(ctx, 'sessionController');
		}
		async create(request) {
			createdRequests.push(request);
			const sessionId = request.sessionId ?? 'session-created-' + (sessions.size + 1);
			if (!sessions.has(sessionId)) {
				sessions.set(sessionId, fakeSession(sessionId));
				agents.set(sessionId, { id: sessionId, session: sessions.get(sessionId), status: 'idle' });
			}
			this.lastCreate = { request, sessionId };
			return { sessionId };
		}
		async resolveAgent(sessionId) {
			const agent = agents.get(sessionId);
			return agent === undefined ? { error: new Error('session/not-found') } : { agent };
		}
		async prompt(request) {
			prompts.push(request);
			return { accepted: true };
		}
		cancel() {}
	}

	class AgentRegistry extends Service {
		constructor(ctx) {
			super(ctx, 'agents');
		}
		get(id) {
			return agents.get(id);
		}
	}

	class WebServer extends Service {
		constructor(ctx) {
			super(ctx, 'webServer');
		}
		register(route) {
			routes.push(route);
			return () => {};
		}
	}

	const dir = mkdtempSync(join(tmpdir(), 'task-queue-test-'));
	const file = existingFile ?? join(dir, 'queue.json');

	class Sessions extends Service {
		constructor(ctx) {
			super(ctx, 'sessions');
		}
		get(id) {
			return sessions.get(id);
		}
	}

	const root = new Context();
	root.plugin(WorkspaceRegistry);
	root.plugin(Approval);
	root.plugin(SessionController);
	root.plugin(AgentRegistry);
	root.plugin(WebServer);
	root.plugin(Sessions);
	root.plugin(
		pluginModule,
		// The window is opened all day so the scheduler is willing to dispatch,
		// which is what makes this an end-to-end test rather than a unit test.
		{ file, enabled: true, windows: [{ start: '00:00', end: '00:00' }], timeZone: 'UTC' },
	);

	await settle();

	/** One request against the registered prefix route. */
	const call = async (method, path, body) => {
		const route = routes.find((candidate) => candidate.path === '/dsh-task-queue/api');
		assert.ok(route, 'the plugin registered its control route');
		const res = {
			status: 0,
			body: '',
			writeHead(status) {
				this.status = status;
			},
			end(text) {
				if (text !== undefined) this.body = text;
			},
		};
		const payload = method === 'GET' ? undefined : { sessionId: 'session-viewing', ...(body ?? {}) };
		const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))];
		const handlers = { data: [], end: [], error: [] };
		const req = {
			method,
			url: '/dsh-task-queue/api' + path + (method === 'GET' ? (path.includes('?') ? '' : '?sessionId=session-viewing') : ''),
			headers: { 'content-type': 'application/json' },
			socket: { remoteAddress: '127.0.0.1' },
			on(event, listener) {
				if (handlers[event] !== undefined) handlers[event].push(listener);
				return this;
			},
		};
		const settled = route.handler(req, res);
		await Promise.resolve();
		for (const listener of handlers.data) listener(chunks[0] ?? Buffer.alloc(0));
		for (const listener of handlers.end) listener();
		await settled;
		return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : null };
	};

	return {
		root,
		file,
		sessions,
		agents,
		prompts,
		createdRequests,
		policyChanges,
		routes,
		call,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
		cleanupKeepFile: () => {}, // leave the document for the restart case
	};
}

/** Let queued work settle: timers, promises, and event dispatch. */
async function settle() {
	for (let index = 0; index < 6; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

test('the plugin activates against a real Cordis context', { skip: entry === undefined }, async () => {
	const app = await boot();
	try {
		assert.equal(app.routes.length, 1, 'the control route is registered through ctx.webServer');
		const state = await app.call('GET', '/state');
		assert.equal(state.status, 200);
		assert.deepEqual(
			state.body.settings.windows,
			[{ start: '00:00', end: '00:00' }],
			'the composition config seeded the workspace',
		);
		assert.deepEqual(
			state.body.workspace,
			{ id: 'ws-1', title: 'Project', path: '/tmp/project' },
			'the session was resolved through the registry — a plain property read would have thrown and been swallowed',
		);
		assert.equal(state.body.runtime.windowOpen, true, 'the all-day window is open');
	} finally {
		app.cleanup();
	}
});

test('a task travels from the route to a finished session', { skip: entry === undefined }, async () => {
	const app = await boot();
	try {
		const created = await app.call('POST', '/tasks', { title: 'nightly', prompt: 'do the thing' });
		assert.equal(created.status, 201);
		const id = created.body.task.id;

		// A pass of the scheduler claims it: the window is open all day here.
		await app.call('POST', '/tick', {});
		await settle();

		assert.equal(app.prompts.length, 1, 'the prompt reached the session controller');
		assert.equal(app.prompts[0].sessionId, 'session-created-1');
		assert.deepEqual(app.createdRequests[0], { workspaceId: 'ws-1' }, 'the task runs in its own workspace');
		assert.match(app.prompts[0].content[0].text, /do the thing/);

		const session = app.sessions.get('session-created-1');
		assert.deepEqual(
			session.events.map((event) => event.type),
			['sandbox/mode'],
			'the sandbox was relaxed on the session log itself, so a resume replays it',
		);
		assert.equal(session.events[0].data.mode, 'danger-full-access');
		// The approval knob goes through the service when it is mounted, and the
		// service is what records the durable `approval/policy` event.
		assert.deepEqual(app.policyChanges, [{ sessionId: 'session-created-1', policy: 'ask' }]);

		const running = await app.call('GET', '/state');
		assert.equal(running.body.tasks[0].status, 'running', 'the queue claimed the task');

		// The agent runs and settles, exactly as the real one would announce.
		const agent = app.agents.get('session-created-1');
		session.events.push({
			type: 'assistant/message',
			data: { message: { content: [{ type: 'text', text: 'finished the thing' }] } },
		});
		app.root.emit('agent/status', { agent, status: 'running' });
		await settle();
		app.root.emit('agent/status', { agent, status: 'idle' });
		await settle();

		const done = await app.call('GET', '/state');
		assert.equal(done.body.tasks[0].status, 'done', 'the task closed when its agent went idle');
		assert.equal(done.body.tasks[0].result, 'finished the thing');
	} finally {
		app.cleanup();
	}
});

test('a task created while the window is shut stays queued', { skip: entry === undefined }, async () => {
	const app = await boot();
	try {
		// Move the window to an hour that is not now, in UTC.
		const hour = new Date().getUTCHours();
		const closedStart = String((hour + 2) % 24).padStart(2, '0') + ':00';
		const closedEnd = String((hour + 3) % 24).padStart(2, '0') + ':00';
		await app.call('POST', '/settings', {
			windows: [{ start: closedStart, end: closedEnd }],
			timeZone: 'UTC',
		});
		const created = await app.call('POST', '/tasks', { prompt: 'wait for tonight' });
		await app.call('POST', '/tick', {});
		await settle();
		assert.equal(app.prompts.length, 0, 'an empty window claims nothing');
		const state = await app.call('GET', '/state');
		assert.equal(state.body.tasks[0].status, 'queued');
		assert.equal(state.body.runtime.windowOpen, false);
		assert.ok(state.body.runtime.nextWindowChangeAt > Date.now(), 'the panel is told when it will open');
		assert.equal(created.body.task.status, 'queued');
	} finally {
		app.cleanup();
	}
});

test('the durable queue survives a Host restart', { skip: entry === undefined }, async () => {
	const first = await boot();
	let file;
	try {
		// Close the window first, so what is under test is durability rather
		// than the scheduler re-claiming the task the moment the Host comes up.
		await first.call('POST', '/settings', { enabled: false });
		await first.call('POST', '/tasks', { prompt: 'remember me' });
		file = first.file;
	} finally {
		first.cleanupKeepFile();
	}

	const second = await boot(file);
	try {
		// The seed config re-opens the window, so close it again before reading;
		// the point is that the task itself came back.
		const state = await second.call('GET', '/state');
		assert.equal(state.body.tasks.length, 1, 'the queue came back');
		assert.equal(state.body.tasks[0].prompt, 'remember me');
		assert.equal(state.body.tasks[0].status, 'queued');
	} finally {
		second.cleanup();
	}
});
