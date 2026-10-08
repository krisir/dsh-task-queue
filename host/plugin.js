/**
 * Host half of the task-queue plugin: wiring, config, and lifecycle.
 *
 * The plugin owns one durable queue and one timer. It is the half that must be
 * correct, because it is the half that runs at 03:00 with nobody watching: the
 * browser half only describes what the queue should do, and every guarantee —
 * the window, the claim order, the unattended permissions, the completion
 * bookkeeping — is enforced here.
 *
 * Composition: the plugin needs the Host Web Session controller (to create a
 * session and admit a prompt) and the web server (to serve the panel). It
 * reads the approval, sandbox, and workspace services opportunistically, so it
 * still loads — just with less to offer — in a composition that omits them.
 *
 * @module dsh-task-queue
 */

import { Scheduler } from './scheduler.js';
import { Dispatcher } from './dispatch.js';
import { Privileges } from './privilege.js';
import { TaskStore, normalizeWorkspaceSettings, defaultFilePath } from './state.js';
import { createHandler, ROUTE_PREFIX } from './http.js';

/** The Cordis plugin name, which also names the loader row. */
export const name = 'dsh-task-queue';

/**
 * Services activation waits for.
 *
 * `sessionController` and `webServer` are hard requirements: without the first
 * there is nothing to dispatch to, and without the second the page has no way to
 * reach the queue. `agents` is the live-agent registry the dispatcher falls back
 * to when the session controller hands back no agent, and `sessions` is how a
 * request's session is resolved to a workspace. Everything else is picked up
 * through {@link OPTIONAL_SERVICES}, so a leaner composition degrades instead of
 * refusing to load.
 *
 * Every one of these must be declared, not merely reached for: Cordis throws on
 * a property read for an undeclared service, so an undeclared access inside a
 * try/catch is a bug that hides behind its own fallback.
 */
export const inject = ['sessionController', 'webServer', 'agents', 'sessions'];

/** Optional services the queue uses when the composition provides them. */
const OPTIONAL_SERVICES = ['approval', 'workspaceRegistry', 'compaction'];

/**
 * The plugin's composition config, validated through Cordis' standard-schema
 * seam.
 *
 * These values are a *seed*, not an override: they are written into the queue
 * the first time it is created, and after that the durable document — which the
 * user edits in the panel — is the truth. A composition config that reasserted
 * itself on every restart would undo the window the user just set.
 *
 * `file` is carried alongside the settings rather than inside them because it
 * chooses where the durable document lives; it is not a preference the panel
 * edits. Dropping it here would silently make the documented `file` option do
 * nothing.
 */
export const Config = {
	'~standard': {
		version: 1,
		vendor: 'dsh-task-queue',
		/**
		 * @param {unknown} value - the raw composition config.
		 * @returns {{ value: object }} the normalized seed settings.
		 */
		validate(value) {
			const raw = value !== null && typeof value === 'object' ? value : {};
			return {
				value: {
					...normalizeWorkspaceSettings(raw),
					file: typeof raw.file === 'string' ? raw.file.trim() : '',
				},
			};
		},
	},
};

/**
 * Start the queue.
 *
 * @param {object} ctx - the Host plugin context.
 * @param {object} config - the validated composition config.
 * @returns {void}
 */
export function apply(ctx, config) {
	/** Route diagnostics into the Host log, where an overnight failure is visible. */
	const log = (message) => {
		try {
			ctx.logger?.info?.(`task-queue: ${message}`);
		} catch {
			/* A logger that will not accept the message must not break the queue. */
		}
	};

	const configuredFile = typeof config?.file === 'string' ? config.file.trim() : '';
	const store = new TaskStore({
		file: configuredFile.length > 0 ? configuredFile : defaultFilePath(),
		seedSettings: config,
		onError: (error) => log(`queue file error: ${String(error)}`),
	});
	store.load();

	// Cordis throws on a property read for a service the plugin did not declare,
	// so an optional dependency is picked up through `ctx.inject` instead: the
	// handle appears when the service mounts, is withdrawn if it unmounts, and
	// the absence is never an exception. Reaching for `ctx.approval` directly
	// and catching the throw would look like it worked while silently disabling
	// the richer path forever.
	const optionalServices = {};
	for (const key of OPTIONAL_SERVICES) {
		ctx.inject([key], (scoped) => {
			optionalServices[key] = scoped[key];
			return () => {
				optionalServices[key] = undefined;
			};
		});
	}

	/**
	 * The workspace a session belongs to.
	 *
	 * Ownership is asked of the registry first, because that is the authoritative
	 * answer: a workspace keeps the ids of the sessions attached to it. A session
	 * that was never attached — one created before this plugin existed, or by a
	 * path that does not attach — falls back to matching its working directory
	 * against a workspace path, which is right in every case where the two agree.
	 *
	 * A session that matches nothing has no queue, and the page says so rather
	 * than filing its tasks somewhere the user cannot see.
	 *
	 * @param {string} sessionId - the session named by a request.
	 * @returns {{ id: string, title: string, path: string } | undefined} its workspace.
	 */
	const resolveWorkspace = (sessionId) => {
		const registry = optionalServices.workspaceRegistry;
		if (registry === undefined) return undefined;
		const listed = registry.list() ?? [];
		for (const workspace of listed) {
			const ids = workspace?.sessionIds ?? [];
			if (ids.some((id) => String(id) === sessionId)) return describe(workspace);
		}
		let cwd = '';
		try {
			cwd = ctx.sessions.get(sessionId)?.header?.cwd ?? '';
		} catch {
			// A session that is not live simply cannot be matched by directory.
			cwd = '';
		}
		if (cwd.length > 0) {
			for (const workspace of listed) {
				if (String(workspace?.path ?? '') === cwd) return describe(workspace);
			}
		}
		return undefined;
	};

	/** @param {object} workspace - a registry workspace. @returns {object} its wire shape. */
	const describe = (workspace) => ({
		id: String(workspace.id),
		title: typeof workspace.title === 'string' ? workspace.title : '',
		path: typeof workspace.path === 'string' ? workspace.path : '',
	});

	const privileges = new Privileges(ctx, { services: optionalServices, log });

	const dispatcher = new Dispatcher({
		ctx,
		store,
		privileges,
		services: optionalServices,
		workspaceOfSession: resolveWorkspace,
		log,
	});
	const scheduler = new Scheduler({ store, dispatcher, log });
	const handler = createHandler({
		store,
		scheduler,
		dispatcher,
		privileges,
		resolveWorkspace,
		log,
	});

	// Registration order is teardown order reversed, and the reverse order is
	// the one that matters: routes stop accepting work, then the loop stops
	// claiming, then in-flight deadlines are dropped, then the permission hooks
	// come down. Nothing can be dispatched into a half-torn-down plugin.
	ctx.effect(() => privileges.install(), 'task-queue: unattended-execution hooks');
	ctx.effect(() => dispatcher.install(), 'task-queue: completion watcher');
	ctx.effect(() => {
		scheduler.start();
		return () => scheduler.stop();
	}, 'task-queue: scheduler loop');
	ctx.effect(() => () => dispatcher.dispose(), 'task-queue: task deadlines');
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
		'task-queue: control routes',
	);

	// A task that was running when the Host stopped has already been re-queued
	// by the store's repair, and its session keeps the permissions it was given.
	dispatcher.resumeManagedSessions();
	log(`ready: ${store.tasks.length} task(s) across ${store.workspacesWithTasks().length} workspace(s)`);
}
