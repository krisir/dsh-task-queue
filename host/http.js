/**
 * The HTTP surface the page talks to.
 *
 * The browser half cannot call a third-party Host plugin through the generated
 * Remote protocol — the client side of that protocol has no source-mode
 * fallback, so it needs a build-time generated artifact this plugin does not
 * have. A plain route on `ctx.webServer` is the supported alternative, and it is
 * what the other third-party plugins in this profile do.
 *
 * Because such a route is reachable by anything that can open a loopback socket,
 * every mutating request is gated twice: it must come from loopback, and it must
 * be JSON. A web page the user visits cannot send a JSON POST without a
 * preflight the browser will refuse, and a non-loopback peer cannot reach the
 * route at all when the Host binds 127.0.0.1 — which is the default.
 *
 * Every request names the **session** it came from, and the Host resolves that
 * to a workspace. The page never sends a workspace id: it does not know one, and
 * a client that named its own workspace could put a task in the wrong queue. Task
 * mutations are then checked against the resolved workspace, so an id belonging
 * to another workspace is a 404 rather than a cross-workspace edit.
 *
 * @module dsh-task-queue/http
 */

import {
	adoptUnassigned,
	archiveCompleted,
	cancelTask,
	clearArchived,
	createTask,
	deleteTask,
	findTask,
	patchSettings,
	reorderTasks,
	retryTask,
	unarchiveTask,
	updateTask,
} from './queue.js';
import { runTaskNow } from './scheduler.js';
import { DOCUMENT_VERSION, TASK_STATUS, UNASSIGNED } from './state.js';

/** The route prefix this plugin owns exclusively. */
export const ROUTE_PREFIX = '/dsh-task-queue/api';

/** Methods that change state, and therefore must be loopback and JSON. */
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The largest request body accepted, in bytes. */
const MAX_BODY = 256 * 1024;

/** The one route that is read with GET. */
const READ_ROUTES = new Set(['/state', '/']);

/** Every path that answers a POST. */
const WRITE_ROUTES = new Set([
	'/tasks',
	'/tasks/update',
	'/tasks/delete',
	'/tasks/cancel',
	'/tasks/retry',
	'/tasks/reorder',
	'/tasks/run',
	'/tasks/adopt',
	'/tasks/requeue-running',
	'/tasks/archive',
	'/tasks/unarchive',
	'/tasks/archive/clear',
	'/settings',
	'/tick',
]);

/**
 * Whether a socket address is the local machine.
 * @param {string | undefined} address - the peer address.
 * @returns {boolean} true for loopback (including IPv4-mapped IPv6).
 */
export function isLoopbackAddress(address) {
	if (typeof address !== 'string') return false;
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Whether a content type is JSON.
 * @param {unknown} value - the `content-type` header.
 * @returns {boolean} true when the body may be parsed as JSON.
 */
export function isJsonContentType(value) {
	if (typeof value !== 'string') return false;
	return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Write a JSON response.
 * @param {object} res - the server response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
function sendJson(res, status, body) {
	if (status === 204 || body === undefined) {
		res.writeHead(status);
		res.end();
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload).toString(),
		'Cache-Control': 'no-store',
	});
	res.end(payload);
}

/**
 * A stable error shape, so the page can show the message rather than guess.
 * @param {string} code - machine-readable code.
 * @param {string} message - human-readable message.
 * @returns {{ error: { code: string, message: string } }} the body.
 */
function errorBody(code, message) {
	return { error: { code, message } };
}

/**
 * Read and parse a JSON request body.
 * @param {object} req - the server request.
 * @returns {Promise<object>} the parsed body, or an empty object.
 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error('request body is too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			if (text.length === 0) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
			} catch {
				reject(new Error('request body is not valid JSON'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * Build the request handler.
 *
 * @param {object} options - handler dependencies.
 * @param {object} options.store - the durable queue store.
 * @param {object} options.scheduler - the scheduler, for window status and waking.
 * @param {object} options.dispatcher - the dispatcher, for manual runs.
 * @param {object} options.privileges - the unattended-execution helper.
 * @param {(sessionId: string) => object | null} options.resolveWorkspace - session → workspace.
 * @param {(message: string) => void} [options.log] - diagnostic sink.
 * @returns {(req: object, res: object) => Promise<void>} the route handler.
 */
export function createHandler({ store, scheduler, dispatcher, privileges, resolveWorkspace, log = () => {} }) {
	/**
	 * The workspace a request came from, or null when the session is not attached
	 * to one.
	 *
	 * A session with no workspace has no queue: tasks belong to a workspace, so
	 * there would be nowhere to put one. The page says so rather than silently
	 * filing the task under a bucket the user cannot see.
	 *
	 * @param {unknown} sessionId - the session named by the request.
	 * @returns {object | null} `{ id, title, path }`, or null.
	 */
	const workspaceFor = (sessionId) => {
		if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
		try {
			return resolveWorkspace(sessionId) ?? null;
		} catch (error) {
			log(`could not resolve the workspace of ${sessionId}: ${String(error)}`);
			return null;
		}
	};

	/** @param {string} workspaceId - the workspace. @returns {object} its settings. */
	const settingsOf = (workspaceId) => store.settingsFor(workspaceId);

	/** The full snapshot the page renders from. */
	const snapshot = (workspace) => ({
		version: DOCUMENT_VERSION,
		now: Date.now(),
		workspace,
		settings: workspace === null ? null : { ...settingsOf(workspace.id) },
		tasks: workspace === null ? [] : store.tasksOf(workspace.id).map((task) => ({ ...task })),
		archived: workspace === null ? [] : store.archivedOf(workspace.id).map((task) => ({ ...task })),
		// Tasks that predate workspace scoping belong to none; the page offers to
		// adopt them rather than hiding them.
		unassignedCount: store.tasksOf(UNASSIGNED).length,
		runtime:
			workspace === null
				? { windowOpen: false, nextWindowChangeAt: null, cooldownUntil: null }
				: {
						windowOpen: scheduler.isDispatchWindowOpen(workspace.id),
						nextWindowChangeAt: scheduler.nextWindowChange(workspace.id) ?? null,
						// When the execution cooldown expires, or null when it is not
						// holding anything back. The page counts this down so a queue
						// that has gone quiet says why.
						cooldownUntil:
							scheduler.cooldownRemaining(workspace.id) > 0
								? Date.now() + scheduler.cooldownRemaining(workspace.id)
								: null,
					},
	});

	/**
	 * The task a request names, proven to belong to the workspace it came from.
	 *
	 * This is what makes "a task belongs to its workspace" true rather than
	 * aspirational: an id from another queue is reported as missing.
	 *
	 * @param {object} workspace - the resolved workspace.
	 * @param {unknown} id - the requested task id.
	 * @returns {object | undefined} the task, when it belongs to this workspace.
	 */
	const ownedTask = (workspace, id) => {
		const task = findTask(store.state, id);
		if (task === undefined || task.workspaceId !== workspace.id) return undefined;
		return task;
	};

	/** Route one already-authorized request. */
	const route = async (req, res, pathname, body, query) => {
		const method = (req.method ?? 'GET').toUpperCase();

		// The path is resolved before the method, so an unknown route is a 404 and
		// a known route called the wrong way is a 405. Reporting 405 for a path
		// that does not exist sends the caller looking for a bug in their method
		// rather than in their URL.
		if (READ_ROUTES.has(pathname)) {
			if (method !== 'GET') {
				sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `${method} is not allowed on ${pathname}`));
				return;
			}
			sendJson(res, 200, snapshot(workspaceFor(query.get('sessionId'))));
			return;
		}
		if (!WRITE_ROUTES.has(pathname)) {
			sendJson(res, 404, errorBody('NOT_FOUND', `unknown route ${pathname}`));
			return;
		}
		if (method !== 'POST') {
			sendJson(res, 405, errorBody('METHOD_NOT_ALLOWED', `${method} is not allowed on ${pathname}`));
			return;
		}

		// The loop's own wake is the one mutating route that belongs to no
		// workspace: it is the diagnostic "look again right now".
		if (pathname === '/tick') {
			scheduler.wake();
			sendJson(res, 200, { ok: true });
			return;
		}

		const workspace = workspaceFor(body.sessionId);
		if (workspace === null) {
			sendJson(
				res,
				409,
				errorBody('NO_WORKSPACE', 'this session is not attached to a workspace, so it has no queue'),
			);
			return;
		}

		switch (pathname) {
			case '/tasks': {
				const created = store.mutate((state) => createTask(state, workspace.id, body));
				sendJson(res, 201, { task: findTask(store.state, created.id), state: snapshot(workspace) });
				return;
			}
			case '/tasks/adopt': {
				const moved = store.mutate((state) => adoptUnassigned(state, workspace.id));
				scheduler.wake();
				sendJson(res, 200, { moved, state: snapshot(workspace) });
				return;
			}
			case '/tasks/requeue-running': {
				const changed = store.mutate((state) => {
					let count = 0;
					for (const task of state.tasks) {
						if (task.workspaceId !== workspace.id) continue;
						if (task.status !== TASK_STATUS.running) continue;
						task.status = TASK_STATUS.queued;
						task.error = 're-queued by the user';
						count += 1;
					}
					return count;
				});
				dispatcher.dispose();
				scheduler.wake();
				sendJson(res, 200, { changed, state: snapshot(workspace) });
				return;
			}
			case '/tasks/archive': {
				const archived = store.mutate((state) => archiveCompleted(state, workspace.id, Date.now()));
				sendJson(res, 200, { archived, state: snapshot(workspace) });
				return;
			}
			case '/tasks/archive/clear': {
				const removed = store.mutate((state) => clearArchived(state, workspace.id));
				sendJson(res, 200, { removed, state: snapshot(workspace) });
				return;
			}
			case '/tasks/reorder': {
				store.mutate((state) => reorderTasks(state, workspace.id, body.ids));
				sendJson(res, 200, { state: snapshot(workspace) });
				return;
			}
			case '/settings': {
				const settings = store.mutate((state) =>
					patchSettings(state, workspace.id, body, store.seedSettings),
				);
				// A settings change can open a window (the user just moved it to now)
				// or close it, so the loop re-evaluates immediately instead of waiting
				// out a sleep armed under the old settings.
				dispatcher.resumeManagedSessions();
				scheduler.wake();
				sendJson(res, 200, { settings, state: snapshot(workspace) });
				return;
			}
			default: {
				// Every remaining route is a task verb, so the workspace check runs
				// once here instead of in each branch.
				const task = ownedTask(workspace, body.id);
				if (task === undefined) {
					sendJson(res, 404, errorBody('TASK_NOT_FOUND', `no task "${String(body.id)}" in this workspace`));
					return;
				}
				switch (pathname) {
					case '/tasks/update': {
						const updated = store.mutate((state) => updateTask(state, body.id, body));
						sendJson(res, 200, { task: updated, state: snapshot(workspace) });
						return;
					}
					case '/tasks/delete': {
						store.mutate((state) => deleteTask(state, body.id));
						sendJson(res, 200, { state: snapshot(workspace) });
						return;
					}
					case '/tasks/cancel': {
						const cancelled = store.mutate((state) => cancelTask(state, body.id));
						if (cancelled === undefined) {
							sendJson(res, 409, errorBody('TASK_NOT_CANCELLABLE', 'the task is already running'));
							return;
						}
						sendJson(res, 200, { task: cancelled, state: snapshot(workspace) });
						return;
					}
					case '/tasks/unarchive': {
						const restored = store.mutate((state) => unarchiveTask(state, body.id));
						if (restored === undefined) {
							sendJson(res, 404, errorBody('TASK_NOT_ARCHIVED', `task "${String(body.id)}" is not archived`));
							return;
						}
						sendJson(res, 200, { task: restored, state: snapshot(workspace) });
						return;
					}
					case '/tasks/retry': {
						const retried = store.mutate((state) => retryTask(state, body.id));
						scheduler.wake();
						sendJson(res, 200, { task: retried, state: snapshot(workspace) });
						return;
					}
					case '/tasks/run': {
						const outcome = await runTaskNow({ store, dispatcher, taskId: body.id });
						if (!outcome.ok) {
							sendJson(res, 409, errorBody('TASK_NOT_RUNNABLE', outcome.error ?? 'the task could not be started'));
							return;
						}
						sendJson(res, 200, { task: findTask(store.state, body.id), state: snapshot(workspace) });
						return;
					}
					default:
						sendJson(res, 404, errorBody('NOT_FOUND', `unknown route ${pathname}`));
				}
			}
		}
	};

	/**
	 * The registered prefix handler.
	 * @param {object} req - the server request.
	 * @param {object} res - the server response.
	 */
	return async function handle(req, res) {
		try {
			const raw = String(req.url ?? '/');
			const url = new URL(raw, 'http://localhost');
			const pathOnly = raw.split('?')[0];
			const pathname = (pathOnly.startsWith(ROUTE_PREFIX) ? pathOnly.slice(ROUTE_PREFIX.length) : pathOnly) || '/';
			const method = (req.method ?? 'GET').toUpperCase();

			if (MUTATIONS.has(method)) {
				if (!isLoopbackAddress(req.socket?.remoteAddress)) {
					sendJson(res, 403, errorBody('FORBIDDEN', 'state-changing requests are loopback-only'));
					return;
				}
				if (method !== 'DELETE' && !isJsonContentType(req.headers?.['content-type'])) {
					sendJson(res, 415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
					return;
				}
			}

			let body = {};
			if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
				try {
					body = await readJsonBody(req);
				} catch (error) {
					sendJson(res, 400, errorBody('BAD_REQUEST', error.message));
					return;
				}
			}

			await route(req, res, pathname, body, url.searchParams);
		} catch (error) {
			// A validation failure is the caller's fault and gets a 400 with the
			// message; anything else is ours, and is logged before it is reported so
			// a broken queue shows up in the Host log rather than only in a page the
			// user may not have open.
			const message = error instanceof Error ? error.message : String(error);
			const expected = error instanceof TypeError;
			if (!expected) log(`request failed: ${message}`);
			sendJson(res, expected ? 400 : 500, errorBody(expected ? 'BAD_REQUEST' : 'INTERNAL', message));
		}
	};
}
