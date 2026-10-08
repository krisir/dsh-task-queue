/**
 * The page's link to the host half.
 *
 * The browser cannot call a third-party host plugin through the generated
 * Remote protocol — the client side of that protocol needs a build-time
 * generated artifact this plugin does not have — so the plugin exposes a plain
 * HTTP route and the page talks to it with `fetch`. Relative URLs work in both
 * hosts: the shipped Web server serves the route directly, and the desktop
 * shell carries `fetch` over its IPC bridge.
 *
 * Every call names the **session** the page is showing. The host resolves that
 * to a workspace, which is what makes a queue belong to a workspace: the page
 * never sends a workspace id, because it does not know one and a client that
 * named its own could file a task in the wrong queue.
 *
 * Every response is `{ error: { code, message } }` on failure, so the page
 * always has something specific to show instead of a bare status code.
 */

/** The route prefix the host half registers. */
const API_BASE = '/dsh-task-queue/api';

/** An error carrying the host's machine-readable code. */
class ApiError extends Error {
	constructor(status, code, message) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

/**
 * Perform one request against the queue route.
 * @param {string} path - route path below the prefix.
 * @param {object} [init] - fetch options.
 * @returns {Promise<object>} the parsed body.
 */
async function apiRequest(path, init) {
	let response;
	try {
		response = await fetch(API_BASE + path, init);
	} catch (error) {
		throw new ApiError(0, 'UNREACHABLE', String(error && error.message ? error.message : error));
	}
	const text = await response.text();
	let body = null;
	if (text.length > 0) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	if (!response.ok) {
		const detail = body && body.error ? body.error : {};
		throw new ApiError(
			response.status,
			detail.code || 'HTTP_' + response.status,
			detail.message || response.statusText,
		);
	}
	return body ?? {};
}

/** POST a JSON body. */
function post(path, body) {
	return apiRequest(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body ?? {}),
	});
}

/** The queue API, as the page uses it. Every call carries its session. */
const api = {
	/** Read the snapshot for one session's workspace. */
	state: (sessionId) => apiRequest('/state?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' }),
	createTask: (sessionId, input) => post('/tasks', { sessionId, ...input }),
	updateTask: (sessionId, id, input) => post('/tasks/update', { sessionId, id, ...input }),
	deleteTask: (sessionId, id) => post('/tasks/delete', { sessionId, id }),
	cancelTask: (sessionId, id) => post('/tasks/cancel', { sessionId, id }),
	retryTask: (sessionId, id) => post('/tasks/retry', { sessionId, id }),
	reorderTasks: (sessionId, ids) => post('/tasks/reorder', { sessionId, ids }),
	runTask: (sessionId, id) => post('/tasks/run', { sessionId, id }),
	adoptUnassigned: (sessionId) => post('/tasks/adopt', { sessionId }),
	archiveCompleted: (sessionId) => post('/tasks/archive', { sessionId }),
	unarchiveTask: (sessionId, id) => post('/tasks/unarchive', { sessionId, id }),
	clearArchived: (sessionId) => post('/tasks/archive/clear', { sessionId }),
	patchSettings: (sessionId, patch) => post('/settings', { sessionId, ...patch }),
};
