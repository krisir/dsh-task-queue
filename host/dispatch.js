/**
 * Claiming a task and handing it to a session.
 *
 * The dispatch path is the part of the queue that has to be exactly right,
 * because it is the only place where a wrong assumption costs the user a whole
 * night of work. Three things are handled here rather than left implicit:
 *
 * - **Which session.** A task either shares its workspace's long-lived runner —
 *   the default, so the tasks can build on each other and the results are all in
 *   one conversation to read in the morning — or gets a fresh session of its own.
 *   The runner is per workspace, so two workspaces never share a conversation.
 * - **Knowing when it is over.** A prompt is accepted synchronously but the turn
 *   is not, so completion is observed rather than awaited: the queue watches
 *   `agent/status` for the transition `running → idle`, and only accepts an
 *   `idle` that it saw preceded by a `running`. Without that guard the very
 *   first idle — observed in the moment between admission and the turn actually
 *   starting — would mark every task done instantly.
 * - **Not hanging forever.** A turn that never settles would hold a concurrency
 *   slot until the Host restarts, so each task carries a deadline and is
 *   cancelled and failed when it passes.
 *
 * @module dsh-task-queue/dispatch
 */

import { TASK_STATUS, TARGET_MODE, UNASSIGNED } from './state.js';
import { findTask, markWorkspaceFinished, patchSettings } from './queue.js';

/** How much of a finished task's reply is kept for the page. */
const RESULT_EXCERPT = 4000;

/**
 * The prompt a task is dispatched as.
 *
 * The framing is deliberate: the executing agent is told what it is, that
 * nobody is watching, and that it must not stop to ask — because an unattended
 * turn that ends in a question has silently produced nothing. The task's own
 * text is left exactly as written, with no heading of its own, because the
 * instruction is the whole task.
 *
 * @param {object} task - the task being dispatched.
 * @returns {string} the text sent to the session.
 */
export function renderPrompt(task) {
	return [
		'【定时任务队列 · 自动派发】',
		'',
		task.prompt,
		'',
		'---',
		'本任务由「任务队列」在预约时段内自动派发。当前没有人在场，请不要请求确认或授权，' +
			'直接按你认为最合适的方案执行；如果需要做选择，选你判断最合理的那个并继续。' +
			'完成后用一段简短的中文说明你做了什么、结果如何。',
	].join('\n');
}

/**
 * Extract the newest assistant text from a session.
 *
 * Read from the session log rather than from the stream, so it also works for a
 * task that finished while the page was not open.
 *
 * @param {object} session - a live session.
 * @returns {string | undefined} the excerpt, or undefined when there is none.
 */
export function lastAssistantText(session) {
	try {
		const events = session.snapshotEvents();
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== 'assistant/message') continue;
			const blocks = event.data?.message?.content ?? [];
			const text = blocks
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text)
				.join('\n')
				.trim();
			if (text.length === 0) continue;
			return text.length > RESULT_EXCERPT ? `${text.slice(0, RESULT_EXCERPT)}…` : text;
		}
	} catch {
		/* A session that will not read back simply has no excerpt. */
	}
	return undefined;
}

/** A short, human-readable rendering of an arbitrary thrown value. */
function errorText(error) {
	if (error === undefined || error === null) return 'unknown error';
	if (typeof error === 'string') return error;
	if (error instanceof Error) return error.message;
	if (typeof error.message === 'string') return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * The live dispatcher: turns a queued task into a running one, and a running
 * one into a finished one.
 */
export class Dispatcher {
	/** @type {Map<string, object>} session id → in-flight record. */
	inFlight = new Map();

	/**
	 * @param {object} options - construction options.
	 * @param {object} options.ctx - Host plugin context.
	 * @param {object} options.store - the durable queue store.
	 * @param {object} options.privileges - the unattended-execution helper.
	 * @param {object} [options.services] - live handles to optional services.
	 * @param {(sessionId: string) => object | undefined} [options.workspaceOfSession] - session → workspace.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 * @param {() => number} [options.now] - injectable clock, for tests.
	 */
	constructor({
		ctx,
		store,
		privileges,
		services = {},
		workspaceOfSession = () => undefined,
		log = () => {},
		now = Date.now,
	}) {
		this.ctx = ctx;
		this.store = store;
		this.privileges = privileges;
		this.services = services;
		this.workspaceOfSession = workspaceOfSession;
		this.log = log;
		this.now = now;
		this.timeouts = new Map();
	}

	/**
	 * Observe agent activity so a dispatched task can be completed.
	 * @returns {() => void} a disposer that removes the listeners.
	 */
	install() {
		const disposers = [
			this.ctx.on('agent/status', (payload) => this.#onStatus(payload)),
			this.ctx.on('agent/error', (payload) => this.#onError(payload)),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	/**
	 * Re-arm the bypass for the sessions the queue already owns.
	 *
	 * Called at startup and after a settings change, so a shared runner keeps the
	 * permissions its workspace asked for even though no task is in flight.
	 */
	resumeManagedSessions() {
		for (const record of this.inFlight.values()) this.privileges.manage(record.sessionId);
		const settings = this.store.globalSettings();
		if (!settings.autoApprove) return;
		if (settings.targetMode === TARGET_MODE.fresh) return;
		// Every workspace keeps its own runner, so every workspace's runner has to
		// be re-managed. Reading one id for the whole queue would leave all but one
		// workspace's shared session unmanaged — it would keep running tasks while
		// asking for approvals nobody is awake to answer.
		for (const runner of this.store.runnerSessionIds()) {
			if (runner.length > 0) this.privileges.manage(runner);
		}
	}

	/**
	 * Whether a session currently has a task in flight.
	 * @param {string} sessionId - session to test.
	 * @returns {boolean} true when a task is already using it.
	 */
	isBusy(sessionId) {
		return this.inFlight.has(sessionId);
	}

	/**
	 * Resolve the session a task should run in, creating one when the mode asks
	 * for a fresh session.
	 *
	 * The workspace comes from the task, never from a setting: a task created in a
	 * workspace runs in that workspace, and its session is attached there so the
	 * results are waiting in the sidebar. The controller derives the working
	 * directory from the workspace, which is why nothing stores a path.
	 *
	 * A session that already exists is **returned, never re-created**. Adopting one
	 * through `create({ sessionId })` looks idempotent and is not: with no
	 * workspace named, the controller derives the working directory from its own
	 * process default and then refuses to adopt a session whose recorded directory
	 * differs —
	 *
	 *     session "session-…" belongs to "/Users/me/project", not "/Users/me/.dsh/profiles/desktop"
	 *
	 * — which is a directory conflict reported for a call that had no business
	 * creating anything. Resuming through `resolveAgent` instead uses the session's
	 * own persisted directory, so there is nothing to conflict with.
	 *
	 * @param {object} task - the task being dispatched.
	 * @param {object} settings - the task's workspace settings.
	 * @returns {Promise<string>} the session id to prompt.
	 */
	async resolveSession(task, settings) {
		// The runner id is read back from the store rather than from the settings
		// snapshot the caller passed. A pass claims several tasks with one snapshot,
		// so the second task of a shared runner would otherwise still see an empty
		// id — the one written moments earlier while creating the runner — and mint
		// a second session for the same workspace.
		//
		// It is read per workspace, and stored per workspace. When it lived in the
		// plugin-wide settings, every workspace resolved this field to the same
		// value, so the first workspace to dispatch claimed the runner slot and the
		// next workspace's tasks were prompted into *that* conversation — a task
		// running outside the workspace that owns it.
		const runner = this.store.settingsFor(task.workspaceId).runnerSessionId;
		if (settings.targetMode === TARGET_MODE.shared && runner.length > 0) return runner;

		const request = task.workspaceId === UNASSIGNED ? {} : { workspaceId: task.workspaceId };
		const created = await this.ctx.sessionController.create(request);
		if (settings.targetMode === TARGET_MODE.shared) {
			this.store.mutate((state) => {
				patchSettings(state, task.workspaceId, { runnerSessionId: created.sessionId }, this.store.seedSettings);
			});
		}
		return created.sessionId;
	}

	/**
	 * Claim a task and send it to its session.
	 *
	 * The task is marked `running` and persisted *before* the prompt is admitted.
	 * If the Host dies in between, the store's restart repair puts the task back
	 * in the queue rather than losing it — the opposite order would lose the task
	 * entirely.
	 *
	 * @param {object} task - the queued task to dispatch.
	 * @param {object} settings - the task's workspace settings.
	 * @returns {Promise<void>} resolves once the prompt is admitted.
	 */
	async dispatch(task, settings) {
		const now = this.now();
		this.store.mutate((state) => {
			const stored = findTask(state, task.id);
			if (stored === undefined) return;
			stored.status = TASK_STATUS.running;
			stored.startedAt = now;
			stored.updatedAt = now;
			stored.attempts = (stored.attempts ?? 0) + 1;
			delete stored.error;
		});

		let sessionId;
		try {
			sessionId = await this.resolveSession(task, settings);
			const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
			if (resolved !== undefined && 'error' in resolved) throw resolved.error;
			// The controller returns the live agent; the registry is only a second
			// look for the case where it returned neither, and the explicit guard
			// keeps that path a clear error rather than a throw from further down.
			const agent = resolved?.agent ?? this.ctx.agents.get(sessionId);
			if (agent === undefined || agent === null || agent.session === undefined) {
				throw new Error(`session "${sessionId}" could not be activated`);
			}

			this.privileges.harden(agent, settings.autoApprove !== false);

			// Registered before the prompt so a turn that starts and finishes within
			// the same tick is still observed as running.
			this.inFlight.set(sessionId, { taskId: task.id, sessionId, sawRunning: false, error: undefined });

			await this.#compactBeforeTask(agent, settings);
			// Compaction can take a while, and the deadline may have closed this task
			// out during it. Starting a turn for a task that is already finished
			// would run work the queue no longer owns.
			if (this.inFlight.get(sessionId)?.taskId !== task.id) return;

			await this.ctx.sessionController.prompt(
				{
					sessionId,
					content: [{ type: 'text', text: renderPrompt(task) }],
					requestId: `task-queue-${task.id}-${task.attempts ?? 0}`,
				},
				new AbortController().signal,
			);

			this.store.mutate((state) => {
				const stored = findTask(state, task.id);
				if (stored !== undefined) stored.sessionId = sessionId;
			});
			this.#armDeadline(task.id, sessionId, settings.taskTimeoutMinutes);
		} catch (error) {
			this.inFlight.delete(sessionId);
			this.#finish(task.id, TASK_STATUS.failed, errorText(error));
			throw error;
		}
	}

	/**
	 * Compact a shared session before the next task starts, when asked.
	 *
	 * `compactNow` is the deliberate call rather than `compactIfNeeded`: the point
	 * is to keep each task starting from a summary, not to wait until the context
	 * has grown past a threshold and is already the problem. It is a no-op on a
	 * session with nothing worth compacting, which is why it is safe to ask for on
	 * every task.
	 *
	 * Best-effort by design. Compaction is an optimization; if no implementation is
	 * mounted, or the model call fails, the task still has to run — losing the
	 * optimization is not a reason to lose the night's work.
	 *
	 * @param {object} agent - the live Agent that will run the task.
	 * @param {object} settings - the task's workspace settings.
	 * @returns {Promise<void>} resolves once compaction settled or was skipped.
	 */
	async #compactBeforeTask(agent, settings) {
		if (settings.compactBeforeTask !== true) return;
		// A fresh session per task has nothing behind it, and compacting one would
		// spend a call to summarize nothing.
		if (settings.targetMode === TARGET_MODE.fresh) return;
		const compaction = this.services.compaction;
		if (compaction === undefined || typeof compaction.compactNow !== 'function') {
			this.log('compaction was requested but no compaction service is mounted');
			return;
		}
		// `compactNow` starts an idle maintenance task, so it cannot run while a turn
		// is open. That only happens when several tasks share one session at once.
		if (agent.status !== 'idle') {
			this.log(`skipped compaction of ${agent.session.id}: the agent is not idle`);
			return;
		}
		try {
			const result = await compaction.compactNow(agent, new AbortController().signal);
			if (result !== null && result !== undefined) {
				this.log(`compacted ${agent.session.id} before dispatch`);
			}
		} catch (error) {
			this.log(`could not compact ${agent.session.id} before dispatch: ${errorText(error)}`);
		}
	}

	/**
	 * Start the deadline that fails a task nothing ever settles.
	 * @param {string} taskId - the dispatched task.
	 * @param {string} sessionId - its session.
	 * @param {number} minutes - how long the task may run.
	 */
	#armDeadline(taskId, sessionId, minutes) {
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		this.#clearDeadline(taskId);
		const timer = setTimeout(() => {
			this.log(`task ${taskId} exceeded ${minutes} minutes; cancelling`);
			try {
				this.ctx.sessionController.cancel({ sessionId });
			} catch (error) {
				this.log(`could not cancel ${sessionId}: ${errorText(error)}`);
			}
			this.#finish(taskId, TASK_STATUS.failed, `timed out after ${minutes} minutes`);
		}, minutes * 60 * 1000);
		if (typeof timer.unref === 'function') timer.unref();
		this.timeouts.set(taskId, timer);
	}

	/** Drop a task's deadline, if it has one. */
	#clearDeadline(taskId) {
		const timer = this.timeouts.get(taskId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.timeouts.delete(taskId);
	}

	/**
	 * Observe one status change.
	 * @param {{ agent: object, status: string }} payload - the event payload.
	 */
	#onStatus({ agent, status }) {
		const sessionId = agent?.session?.id;
		const record = this.inFlight.get(sessionId);
		if (record === undefined) return;
		if (status === 'running') {
			record.sawRunning = true;
			return;
		}
		if (status !== 'idle' || !record.sawRunning) return;
		this.#finish(
			record.taskId,
			record.error === undefined ? TASK_STATUS.done : TASK_STATUS.failed,
			record.error,
			agent.session,
		);
	}

	/**
	 * Remember that a managed session errored; the failure is recorded when the
	 * turn closes, so the page never shows a task failed while it is still making
	 * progress.
	 * @param {{ agent: object, error: unknown }} payload - the event payload.
	 */
	#onError({ agent, error }) {
		const record = this.inFlight.get(agent?.session?.id);
		if (record === undefined) return;
		record.error = errorText(error);
	}

	/**
	 * Close out a task and release its session.
	 *
	 * @param {string} taskId - the task to close.
	 * @param {string} status - the terminal status.
	 * @param {string} [error] - failure text.
	 * @param {object} [session] - the session to excerpt a result from.
	 */
	#finish(taskId, status, error, session) {
		this.#clearDeadline(taskId);
		let sessionId;
		for (const [id, record] of this.inFlight) {
			if (record.taskId === taskId) {
				sessionId = id;
				break;
			}
		}
		if (sessionId !== undefined) this.inFlight.delete(sessionId);
		const result = session === undefined ? undefined : lastAssistantText(session);
		const finishedAt = this.now();
		this.store.mutate((state) => {
			const stored = findTask(state, taskId);
			if (stored === undefined) return;
			stored.status = status;
			stored.finishedAt = finishedAt;
			stored.updatedAt = finishedAt;
			if (error !== undefined) stored.error = error;
			else delete stored.error;
			if (result !== undefined) stored.result = result;
			// The execution cooldown measures from here, so the anchor is written in
			// the same commit as the finish — a crash in between cannot leave a task
			// closed with no idea when the next one may start.
			markWorkspaceFinished(state, stored.workspaceId, finishedAt);
		});
		if (sessionId !== undefined) this.#releaseIfUnused(sessionId);
	}

	/**
	 * Release a session's relaxed permissions once nothing else needs them.
	 *
	 * A shared runner belongs to its workspace, so it stays managed; every other
	 * session — which is every session in `fresh` mode — is released the moment
	 * its task ends.
	 *
	 * The decision is made against the runner ids the document actually holds, not
	 * against the mode. The mode is a plugin-wide setting any workspace's settings
	 * page may change, while a runner belongs to one workspace: reading the mode
	 * here let a workspace switching to `fresh` release *another* workspace's
	 * runner — its session then ran the rest of the night with the relaxed
	 * permissions withdrawn until the next dispatch happened to re-arm them. Asking
	 * whether this session is still somebody's runner is the question that stays
	 * correct whatever mode anyone is in.
	 *
	 * @param {string} sessionId - the session to reconsider.
	 */
	#releaseIfUnused(sessionId) {
		if (!this.store.runnerSessionIds().includes(sessionId)) this.privileges.release(sessionId);
	}

	/** Fail every in-flight task and forget it, without touching the queue. */
	dispose() {
		for (const timer of this.timeouts.values()) clearTimeout(timer);
		this.timeouts.clear();
		this.inFlight.clear();
	}
}
