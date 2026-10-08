/**
 * The scheduler: deciding, over and over, whether each workspace's queue may move.
 *
 * The rule the user asked for is simple — "before 18:00 only create tasks, do
 * not run them; after 18:00 claim and dispatch" — and the whole difficulty is in
 * the words *after 18:00*. A queue that only looked at the clock when the user
 * pressed a button would never start by itself, and a queue that polled every
 * minute would be up to a minute late at exactly the boundary the user cares
 * about. So this loop does both:
 *
 * - it arms a one-shot timer for the exact next boundary crossing, so the first
 *   task of the night is claimed within milliseconds of 18:00, and
 * - it keeps a coarse poll underneath, because a laptop that slept through the
 *   boundary has a stale timer and the poll is what notices.
 *
 * Every pass re-reads the clock, the settings, and the queue rather than trusting
 * state captured when the timer was armed, so a settings change, a clock change,
 * or a suspend/resume cycle all converge on the same answer without a code path
 * of their own.
 *
 * Each workspace is evaluated on its own: its own windows, its own concurrency
 * limit, its own tasks. One workspace being outside its hours says nothing about
 * another.
 *
 * @module dsh-task-queue/scheduler
 */

import { cooldownRemaining, nextQueued, runningCount } from './queue.js';
import { isOpen, nextBoundary } from './window.js';

/**
 * How often the loop re-reads the clock when no boundary is nearer.
 *
 * This is an implementation detail rather than a setting: the boundary timer is
 * exact, and this only exists so a clock that moved while the Host slept is
 * noticed within seconds.
 */
const POLL_INTERVAL_MS = 15000;

/**
 * The maximum a single timer is allowed to sleep, in milliseconds.
 *
 * Long timers are how a suspended machine loses a schedule: the timer fires late
 * and the correction has to come from somewhere. Capping the sleep means the poll
 * itself is that correction, and nothing here has to reason about suspend,
 * resume, or a clock jump.
 */
const MAX_SLEEP = 30000;

/**
 * The scheduler loop.
 */
export class Scheduler {
	/** @type {ReturnType<typeof setTimeout> | undefined} the single armed timer. */
	timer;

	/** @type {boolean} set while a pass is executing, so passes never overlap. */
	running = false;

	/** @type {boolean} set once disposed, so a queued pass cannot restart the loop. */
	stopped = false;

	/**
	 * @param {object} options - construction options.
	 * @param {object} options.store - the durable queue store.
	 * @param {object} options.dispatcher - the task dispatcher.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 * @param {() => number} [options.now] - injectable clock, for tests.
	 * @param {object} [options.timers] - injectable timer functions, for tests.
	 */
	constructor({ store, dispatcher, log = () => {}, now = Date.now, timers }) {
		this.store = store;
		this.dispatcher = dispatcher;
		this.log = log;
		this.now = now;
		this.setTimeout = timers?.setTimeout ?? setTimeout;
		this.clearTimeout = timers?.clearTimeout ?? clearTimeout;
	}

	/** Start the loop with an immediate first pass. */
	start() {
		this.stopped = false;
		this.wake();
	}

	/** Stop the loop and drop the armed timer. */
	stop() {
		this.stopped = true;
		if (this.timer !== undefined) this.clearTimeout(this.timer);
		this.timer = undefined;
	}

	/**
	 * Run one pass as soon as possible, cancelling any pending sleep.
	 *
	 * Used by the timer, by a settings change, and by the "run now" path, so a
	 * user pressing a button never waits for the current sleep to elapse.
	 *
	 * @returns {void}
	 */
	wake() {
		if (this.stopped) return;
		if (this.timer !== undefined) {
			this.clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.#schedule(0);
	}

	/**
	 * Arm the next pass.
	 * @param {number} delayMs - milliseconds to wait.
	 */
	#schedule(delayMs) {
		if (this.stopped) return;
		if (this.timer !== undefined) this.clearTimeout(this.timer);
		this.timer = this.setTimeout(() => {
			this.timer = undefined;
			void this.tick();
		}, delayMs);
		if (typeof this.timer?.unref === 'function') this.timer.unref();
	}

	/**
	 * How long to sleep before the next pass.
	 *
	 * The boundary timer is exact, so sleeping until then costs nothing; the cap
	 * is what keeps a suspended or clock-shifted machine honest. The earliest
	 * boundary across all workspaces is the one that matters, because any of them
	 * opening is a reason to wake.
	 *
	 * The cooldown is included so the next task starts when the wait expires rather
	 * than on the next poll after it — a half-hour pause should end on time.
	 *
	 * @param {number} now - the current instant.
	 * @returns {number} milliseconds until the next pass.
	 */
	#delay(now) {
		const pollMs = POLL_INTERVAL_MS;
		let soonest = pollMs;
		for (const workspaceId of this.store.workspacesWithTasks()) {
			const boundary = nextBoundary(now, this.store.settingsFor(workspaceId));
			if (boundary !== undefined) soonest = Math.min(soonest, Math.max(0, boundary - now));
			const waiting = this.cooldownRemaining(workspaceId);
			if (waiting > 0) soonest = Math.min(soonest, waiting);
		}
		return Math.min(MAX_SLEEP, pollMs, soonest);
	}

	/**
	 * One pass: for every workspace with work and an open window, claim and
	 * dispatch while a slot is free.
	 *
	 * Only one pass runs at a time. A dispatch can take seconds (a cold session is
	 * restored, a prompt is admitted), and two overlapping passes would both see
	 * the same queued task and both claim it.
	 *
	 * @returns {Promise<void>} resolves once the pass has settled.
	 */
	async tick() {
		if (this.stopped || this.running) return;
		this.running = true;
		try {
			await this.#pass();
		} catch (error) {
			this.log(`scheduler pass failed: ${String(error)}`);
		} finally {
			this.running = false;
			if (!this.stopped) this.#schedule(this.#delay(this.now()));
		}
	}

	/** The body of one pass, workspace by workspace. */
	async #pass() {
		const now = this.now();
		const state = this.store.state;
		for (const workspaceId of this.store.workspacesWithTasks()) {
			if (this.stopped) return;
			const settings = this.store.settingsFor(workspaceId);
			if (!isOpen(now, settings)) continue;
			// The execution cooldown paces a batch out: after a task finishes, the
			// next one waits. It is checked before the slots rather than inside the
			// claim, because it is a property of the queue's rhythm, not of a task.
			if (this.cooldownRemaining(workspaceId) > 0) continue;
			// One task at a time, always. Tasks in one workspace share a session by
			// default, and two of them in one conversation is not parallelism — it is
			// the second task queueing behind the first while both count as running.
			while (!this.stopped) {
				if (runningCount(state, workspaceId) >= 1) break;
				const task = nextQueued(state, workspaceId);
				if (task === undefined) break;
				try {
					await this.dispatcher.dispatch(task, settings);
				} catch (error) {
					// `dispatch` has already marked the task failed; stopping this
					// workspace's pass is what keeps one broken session from draining
					// its whole queue into failures in a single tick.
					this.log(`task ${task.id} failed to dispatch: ${String(error)}`);
					break;
				}
			}
		}
	}

	/**
	 * Whether one workspace may dispatch right now, for the page's status line.
	 * @param {string} workspaceId - the workspace to report on.
	 * @returns {boolean} true while that workspace's window is open.
	 */
	isDispatchWindowOpen(workspaceId) {
		return isOpen(this.now(), this.store.settingsFor(workspaceId));
	}

	/**
	 * How long one workspace must still wait before its next task starts.
	 *
	 * The page shows this, because a queue that has gone quiet for half an hour
	 * needs to say why or it reads as broken.
	 *
	 * @param {string} workspaceId - the workspace to report on.
	 * @returns {number} milliseconds still to wait, 0 when it may start now.
	 */
	cooldownRemaining(workspaceId) {
		return cooldownRemaining({
			now: this.now(),
			settings: this.store.settingsFor(workspaceId),
			lastFinishedAt: this.store.lastFinishedAt(workspaceId),
			running: runningCount(this.store.state, workspaceId),
		});
	}

	/**
	 * The next instant one workspace's window opens or closes.
	 * @param {string} workspaceId - the workspace to report on.
	 * @returns {number | undefined} the boundary instant, or undefined.
	 */
	nextWindowChange(workspaceId) {
		return nextBoundary(this.now(), this.store.settingsFor(workspaceId));
	}
}

/**
 * Dispatch one specific task regardless of its window.
 *
 * This is the page's "run now": the user has decided, at this moment, that the
 * queue's hours do not apply. It is deliberately a separate entry point rather
 * than a flag on the pass, so the unattended path can never be reached by
 * accident from the manual one.
 *
 * The task keeps its own workspace, so a manual run still creates its session in
 * the right place — the hours are skipped, the scoping is not.
 *
 * @param {object} options - dispatch options.
 * @param {object} options.store - the durable queue store.
 * @param {object} options.dispatcher - the task dispatcher.
 * @param {string} options.taskId - the task to run.
 * @returns {Promise<{ ok: boolean, error?: string }>} the outcome.
 */
export async function runTaskNow({ store, dispatcher, taskId }) {
	const task = store.state.tasks.find((candidate) => candidate.id === taskId);
	if (task === undefined) return { ok: false, error: 'task not found' };
	if (task.status === 'running') return { ok: false, error: 'task is already running' };
	store.mutate((state) => {
		const stored = state.tasks.find((candidate) => candidate.id === taskId);
		if (stored !== undefined) {
			stored.status = 'queued';
			stored.seq = 0;
		}
	});
	try {
		const settings = store.settingsFor(task.workspaceId);
		await dispatcher.dispatch(store.state.tasks.find((candidate) => candidate.id === taskId), settings);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true };
}
