/**
 * Control-route tests, over a real HTTP server.
 *
 * The panel's only way to reach the queue is this route, so these tests exercise
 * it the way the browser does — a real socket, real headers, a real JSON body —
 * rather than calling the handler directly. The gates matter as much as the
 * happy paths: a mutating route that is reachable without the loopback and
 * JSON checks is a remote-control hole in the Host.
 */

import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { Scheduler } from '../host/scheduler.js';
import { TaskStore, normalizeWorkspaceSettings } from '../host/state.js';
import { isJsonContentType, isLoopbackAddress, createHandler, ROUTE_PREFIX } from '../host/http.js';

/** The session every request in this suite claims to come from. */
const SESSION_A = 'session-a';

/** A store with no disk. */
function buildStore() {
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

/** The sessions these tests pretend to be, and the workspace each resolves to. */
const SESSIONS = { 'session-a': 'ws-1', 'session-b': 'ws-2', 'session-loose': null };

/** Start the plugin's route on an ephemeral port and hand back a client. */
async function startServer() {
	const store = buildStore();
	const dispatcher = {
		dispatched: [],
		enable: true,
		async dispatch(task) {
			this.dispatched.push(task.id);
		},
		resumeManagedSessions() {},
		dispose() {},
	};
	const scheduler = new Scheduler({ store, dispatcher, now: () => Date.parse('2025-01-01T09:00:00Z') });
	const privileges = { enabled: true };
	/** Resolve a session the way the plugin does, from a fixed table. */
	const resolveWorkspace = (sessionId) => {
		const id = SESSIONS[sessionId];
		return id === undefined || id === null ? undefined : { id, title: id.toUpperCase(), path: '/tmp/' + id };
	};
	const handler = createHandler({ store, scheduler, dispatcher, privileges, resolveWorkspace });

	const server = createServer((req, res) => {
		void handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`;

	/** Issue one request and parse the JSON reply. */
	const call = async (path, init) => {
		const response = await fetch(base + path, init);
		const text = await response.text();
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
	};
	const post = (path, body) =>
		call(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: SESSION_A, ...(body ?? {}) }),
		});

	return {
		store,
		dispatcher,
		call,
		post,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test('the snapshot carries everything the panel renders from', async () => {
	const server = await startServer();
	try {
		const { status, body } = await server.call('/state?sessionId=' + SESSION_A);
		assert.equal(status, 200);
		assert.ok(body.settings, 'settings are present');
		assert.deepEqual(body.tasks, [], 'an empty queue is an empty list');
		assert.equal(typeof body.runtime.windowOpen, 'boolean', 'the window state is resolved by the host');
		assert.deepEqual(body.workspace, { id: 'ws-1', title: 'WS-1', path: '/tmp/ws-1' }, 'the session resolves to a workspace');
		assert.deepEqual(body.settings.windows, [{ start: '18:00', end: '07:00' }], 'the windows travel as a list');
		assert.equal(body.unassignedCount, 0, 'nothing is orphaned on a fresh queue');
	} finally {
		await server.close();
	}
});

test('a task can be created and read back', async () => {
	const server = await startServer();
	try {
		const created = await server.post('/tasks', { prompt: 'do the thing' });
		assert.equal(created.status, 201);
		assert.equal(created.body.task.prompt, 'do the thing');
		assert.equal(created.body.state.tasks.length, 1, 'the mutation returns the new snapshot');
		const read = await server.call('/state?sessionId=' + SESSION_A);
		assert.equal(read.body.tasks[0].prompt, 'do the thing');
	} finally {
		await server.close();
	}
});

test('a blank prompt is rejected with a readable message', async () => {
	const server = await startServer();
	try {
		const { status, body } = await server.post('/tasks', { prompt: '   ' });
		assert.equal(status, 400);
		assert.equal(body.error.code, 'BAD_REQUEST');
		assert.match(body.error.message, /blank/);
	} finally {
		await server.close();
	}
});

test('the full task lifecycle is reachable over the route', async () => {
	const server = await startServer();
	try {
		const created = await server.post('/tasks', { prompt: 'a task' });
		const id = created.body.task.id;

		const edited = await server.post('/tasks/update', { id, prompt: 'renamed' });
		assert.equal(edited.status, 200);
		assert.equal(edited.body.task.prompt, 'renamed');

		const cancelled = await server.post('/tasks/cancel', { id });
		assert.equal(cancelled.body.task.status, 'cancelled');

		const retried = await server.post('/tasks/retry', { id });
		assert.equal(retried.body.task.status, 'queued');

		const ran = await server.post('/tasks/run', { id });
		assert.equal(ran.status, 200);
		assert.deepEqual(server.dispatcher.dispatched, [id], 'run-now ignores the window on purpose');

		const removed = await server.post('/tasks/delete', { id });
		assert.equal(removed.status, 200);
		assert.deepEqual(removed.body.state.tasks, []);
	} finally {
		await server.close();
	}
});

test('an unknown task id is a 404, not a silent success', async () => {
	const server = await startServer();
	try {
		for (const path of ['/tasks/update', '/tasks/delete', '/tasks/retry', '/tasks/cancel']) {
			const { status, body } = await server.post(path, { id: 'nope' });
			assert.ok(status >= 400, `${path} must fail for an unknown id`);
			assert.ok(body.error.code, `${path} must explain itself`);
		}
	} finally {
		await server.close();
	}
});

test('settings are patched and validated by the host', async () => {
	const server = await startServer();
	try {
		const { body } = await server.post('/settings', {
			windows: [{ start: '20:00', end: '06:30' }, { start: '12:00', end: '13:00' }],
			enabled: false,
		});
		assert.deepEqual(body.state.settings.windows, [
			{ start: '20:00', end: '06:30' },
			{ start: '12:00', end: '13:00' },
		]);
		assert.equal(body.state.settings.enabled, false);
		const repaired = await server.post('/settings', { timeZone: 'Mars/Olympus' });
		assert.equal(repaired.body.state.settings.timeZone, 'Asia/Shanghai', 'an invalid value is not applied');
		assert.deepEqual(
			repaired.body.state.settings.windows,
			[{ start: '20:00', end: '06:30' }, { start: '12:00', end: '13:00' }],
			'and it does not disturb the neighbours',
		);
	} finally {
		await server.close();
	}
});

test('a session with no workspace has no queue', async () => {
	const server = await startServer();
	try {
		const read = await server.call('/state?sessionId=session-loose');
		assert.equal(read.status, 200);
		assert.equal(read.body.workspace, null);
		assert.equal(read.body.settings, null);
		assert.deepEqual(read.body.tasks, []);

		const created = await server.call('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: 'session-loose', prompt: 'nowhere to go' }),
		});
		assert.equal(created.status, 409);
		assert.equal(created.body.error.code, 'NO_WORKSPACE');
	} finally {
		await server.close();
	}
});

test('a task in one workspace is invisible and untouchable from another', async () => {
	const server = await startServer();
	try {
		const created = await server.post('/tasks', { prompt: 'belongs to A' });
		const id = created.body.task.id;
		assert.equal(created.body.state.tasks.length, 1);

		// The other workspace's session sees an empty queue…
		const other = await server.call('/state?sessionId=session-b');
		assert.equal(other.body.workspace.id, 'ws-2');
		assert.deepEqual(other.body.tasks, [], 'queues do not leak across workspaces');

		// …and cannot reach the task by id.
		const stolen = await server.post('/tasks/delete', { sessionId: 'session-b', id });
		assert.equal(stolen.status, 404, 'an id from another queue is not-found, not an edit');
		const stillThere = await server.call('/state?sessionId=' + SESSION_A);
		assert.equal(stillThere.body.tasks.length, 1, 'and the task is untouched');
	} finally {
		await server.close();
	}
});

test('unassigned tasks can be adopted into the session\'s workspace', async () => {
	const server = await startServer();
	try {
		server.store.mutate((state) => {
			state.tasks.push({
				id: 'legacy',
				workspaceId: '',
				title: 'legacy',
				prompt: 'from before',
				status: 'queued',
				createdAt: 1,
				updatedAt: 1,
				attempts: 0,
				seq: 1,
			});
		});
		const before = await server.call('/state?sessionId=' + SESSION_A);
		assert.equal(before.body.unassignedCount, 1, 'the page is told they exist');
		const adopted = await server.post('/tasks/adopt', {});
		assert.equal(adopted.body.moved, 1);
		assert.equal(adopted.body.state.unassignedCount, 0);
		assert.equal(adopted.body.state.tasks.length, 1, 'and they are now in this queue');
	} finally {
		await server.close();
	}
});

test('the archive is reachable, restorable, and clearable over the route', async () => {
	const server = await startServer();
	try {
		const created = await server.post('/tasks', { prompt: 'a finished task' });
		const id = created.body.task.id;
		server.store.mutate((state) => {
			const task = state.tasks.find((candidate) => candidate.id === id);
			task.status = 'done';
			task.finishedAt = Date.now();
		});

		const archived = await server.post('/tasks/archive', {});
		assert.equal(archived.status, 200);
		assert.equal(archived.body.archived, 1);
		assert.deepEqual(archived.body.state.tasks, [], 'it left the queue list');
		assert.equal(archived.body.state.archived.length, 1, 'and arrived in the archive');

		const restored = await server.post('/tasks/unarchive', { id });
		assert.equal(restored.status, 200);
		assert.equal(restored.body.state.archived.length, 0);
		assert.equal(restored.body.state.tasks.length, 1);

		// Restoring something that is not archived is a 404, not a silent success.
		const again = await server.post('/tasks/unarchive', { id });
		assert.equal(again.status, 404);
		assert.equal(again.body.error.code, 'TASK_NOT_ARCHIVED');

		await server.post('/tasks/archive', {});
		// Only a `done` task is eligible, so make one again for the clear test.
		server.store.mutate((state) => {
			const task = state.tasks.find((candidate) => candidate.id === id);
			task.status = 'done';
		});
		await server.post('/tasks/archive', {});
		const cleared = await server.post('/tasks/archive/clear', {});
		assert.equal(cleared.body.removed, 1);
		assert.equal(cleared.body.state.archived.length, 0);
		assert.deepEqual(cleared.body.state.tasks, [], 'and the queue list is untouched');
	} finally {
		await server.close();
	}
});

test('archiving is scoped to the calling workspace', async () => {
	const server = await startServer();
	try {
		const mine = await server.post('/tasks', { prompt: 'mine' });
		server.store.mutate((state) => {
			state.tasks.find((task) => task.id === mine.body.task.id).status = 'done';
		});
		// The other workspace's session has nothing to archive and nothing to clear.
		const other = await server.post('/tasks/archive', { sessionId: 'session-b' });
		assert.equal(other.body.archived, 0);
		const cleared = await server.post('/tasks/archive/clear', { sessionId: 'session-b' });
		assert.equal(cleared.body.removed, 0);
		assert.ok(server.store.state.tasks.length === 1, 'the other workspace\'s clear did not touch mine');
	} finally {
		await server.close();
	}
});

test('the snapshot always carries an archive list', async () => {
	const server = await startServer();
	try {
		const { body } = await server.call('/state?sessionId=' + SESSION_A);
		assert.deepEqual(body.archived, [], 'an empty archive is an empty list, not a missing field');
	} finally {
		await server.close();
	}
});

test('a mutating request without a JSON content type is refused', async () => {
	const server = await startServer();
	try {
		const { status, body } = await server.call('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: '{"prompt":"sneaky"}',
		});
		assert.equal(status, 415, 'a cross-site form post cannot reach a mutating route');
		assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
	} finally {
		await server.close();
	}
});

test('a malformed JSON body is a 400, not a crash', async () => {
	const server = await startServer();
	try {
		const { status, body } = await server.call('/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{not json',
		});
		assert.equal(status, 400);
		assert.equal(body.error.code, 'BAD_REQUEST');
	} finally {
		await server.close();
	}
});

test('an unknown route and a wrong method are both refused explicitly', async () => {
	const server = await startServer();
	try {
		const missing = await server.call('/nope');
		assert.equal(missing.status, 404);
		assert.equal(missing.body.error.code, 'NOT_FOUND');
		const wrongMethod = await server.call('/tasks');
		assert.equal(wrongMethod.status, 405);
		assert.equal(wrongMethod.body.error.code, 'METHOD_NOT_ALLOWED');
	} finally {
		await server.close();
	}
});

test('re-queueing a running task is available for a stuck queue', async () => {
	const server = await startServer();
	try {
		const created = await server.post('/tasks', { prompt: 'stuck' });
		const id = created.body.task.id;
		server.store.mutate((state) => {
			state.tasks.find((task) => task.id === id).status = 'running';
		});
		const { status, body } = await server.post('/tasks/requeue-running', {});
		assert.equal(status, 200);
		assert.equal(body.changed, 1);
		assert.equal(body.state.tasks[0].status, 'queued');
	} finally {
		await server.close();
	}
});

test('the loopback and JSON filters accept only what they should', () => {
	assert.equal(isLoopbackAddress('127.0.0.1'), true);
	assert.equal(isLoopbackAddress('::1'), true);
	assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
	assert.equal(isLoopbackAddress('10.0.0.7'), false);
	assert.equal(isLoopbackAddress(undefined), false);
	assert.equal(isJsonContentType('application/json'), true);
	assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
	assert.equal(isJsonContentType('text/plain'), false);
	assert.equal(isJsonContentType(undefined), false);
});

test('a shared setting changed from one workspace applies to every workspace', async () => {
	// The requirement: only the interval is per workspace. Changing the hours from
	// one workspace's page changes the queue as a whole, so the other workspace's
	// session reads the same hours back.
	const server = await startServer();
	try {
		await server.post('/settings', { windows: [{ start: '09:00', end: '17:00' }] });
		const other = await server.call('/state?sessionId=session-b');
		assert.deepEqual(
			other.body.settings.windows,
			[{ start: '09:00', end: '17:00' }],
			'the other workspace sees the shared hours',
		);
	} finally {
		await server.close();
	}
});

test('the interval is the one setting a workspace keeps to itself', async () => {
	// The other half: pacing a batch out in one workspace must not slow the other.
	const server = await startServer();
	try {
		await server.post('/settings', { cooldownMinutes: 30 });
		await server.post('/settings', { sessionId: 'session-b', cooldownMinutes: 0 });

		const first = await server.call('/state?sessionId=session-a');
		const second = await server.call('/state?sessionId=session-b');
		assert.equal(first.body.settings.cooldownMinutes, 30, 'ws-1 keeps its own interval');
		assert.equal(second.body.settings.cooldownMinutes, 0, 'ws-2 keeps a different one');
		// The shared fields have one copy, so the two workspaces cannot disagree.
		assert.deepEqual(first.body.settings.windows, second.body.settings.windows);
	} finally {
		await server.close();
	}
});
