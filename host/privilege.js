/**
 * Unattended execution: making a queue-owned session run without ever stopping
 * to ask a human.
 *
 * An overnight task has nobody to answer a prompt, and the Host's `never`
 * approval policy answers one by *rejecting* it — which would fail the task at
 * the exact moment it needed to act. So "skip every authorization" is not a
 * side effect of some other setting; it is three deliberate layers, all scoped
 * to sessions this plugin drives:
 *
 * 1. `sandbox/mode` is set to `danger-full-access` on the task's session, so
 *    the filesystem and shell tools do not need an escalation in the first
 *    place. This is the layer that decides whether the work can actually
 *    happen, since a confined call that is refused never reaches step 2.
 * 2. A `tools/pre-execute` listener answers `allow` for a managed session.
 *    This is the real bypass: it short-circuits the tool pipeline *before* an
 *    `ask` decision can become an approval request, and it works regardless of
 *    which approval policy the session carries.
 * 3. An `approval/request` listener answers `allowed-once` for a managed
 *    session, which covers a tool body that asks the approval service directly
 *    instead of expressing its need as a pre-execute decision.
 *
 * Layer 2 alone would be enough for the shipped tools; layers 1 and 3 exist so
 * that the guarantee holds for tools this plugin has never seen. Every layer
 * checks {@link Privileges.isManaged} first, so a session the user is typing
 * into is never affected — including the session running this conversation.
 *
 * The switch is per workspace, so it is tracked per session: a workspace with
 * `autoApprove` off simply never has its sessions managed, and one that had it on
 * keeps its grants until no queued or running task can still use them.
 *
 * @module dsh-task-queue/privilege
 */

/** The sandbox mode an unattended task runs under. */
export const UNATTENDED_SANDBOX_MODE = 'danger-full-access';

/** The approval policy that lets a managed session's asks reach the answerers. */
const REACHABLE_APPROVAL_POLICY = 'ask';

/** The only approval outcome that grants an action. */
const GRANT = 'allowed-once';

/**
 * Tracks which sessions belong to the queue and exposes the bypass hooks.
 */
export class Privileges {
	/** @type {Set<string>} session ids the queue currently drives. */
	managed = new Set();

	/**
	 * @param {object} ctx - Host plugin context.
	 * @param {object} [options] - construction options.
	 * @param {object} [options.services] - live handles to optional services.
	 * @param {(message: string) => void} [options.log] - diagnostic sink.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		// Cordis throws on a property read for a service the plugin did not
		// declare, so optional services arrive as live handles the plugin fills
		// in through `ctx.inject` rather than as properties reached for here.
		this.services = options.services ?? {};
		this.log = options.log ?? (() => {});
	}

	/**
	 * Arm the bypass hooks on the Host context.
	 *
	 * Both listeners are registered with `prepend: true`. That is not an
	 * optimization: the Web GUI registers its own `approval/request` answerer, and
	 * a listener that only delegates when it has no opinion is still a race if
	 * something else answers first. Being first means the grant is decided before
	 * any other answerer is consulted, and a managed session can never end up
	 * waiting on a prompt nobody is awake to answer.
	 *
	 * @returns {() => void} a disposer that disarms them.
	 */
	install() {
		const disposers = [
			this.ctx.on(
				'tools/pre-execute',
				(exec, next) => {
					const sessionId = exec?.agent?.session?.id;
					if (!this.isManaged(sessionId)) return next();
					return { kind: 'allow' };
				},
				{ prepend: true },
			),
			this.ctx.on(
				'approval/request',
				(request, next) => {
					const sessionId = request?.agent?.session?.id;
					if (!this.isManaged(sessionId)) return next();
					return GRANT;
				},
				{ prepend: true },
			),
		];
		return () => {
			for (const dispose of disposers) dispose();
		};
	}

	/**
	 * Whether a session is one the bypass may act on.
	 * @param {unknown} sessionId - candidate session id.
	 * @returns {boolean} true when the session belongs to the queue.
	 */
	isManaged(sessionId) {
		return typeof sessionId === 'string' && this.managed.has(sessionId);
	}

	/**
	 * Take ownership of a session, so the bypass covers it.
	 * @param {string} sessionId - the session to claim.
	 * @returns {void}
	 */
	manage(sessionId) {
		if (typeof sessionId === 'string' && sessionId.length > 0) this.managed.add(sessionId);
	}

	/**
	 * Release a session.
	 *
	 * Called when no queued or running task can still use it, so a session the
	 * user opens later is back under normal interactive rules.
	 *
	 * @param {string} sessionId - the session to release.
	 * @returns {void}
	 */
	release(sessionId) {
		this.managed.delete(sessionId);
	}

	/**
	 * Relax one live session for unattended work, when its workspace asks for it.
	 *
	 * Both writes are the documented durable write path for their knob — the same
	 * `session.append` the sandbox-policy and approval services use — so a resumed
	 * session replays the same relaxed state instead of quietly coming back
	 * confined, and nothing depends on a service being mounted at the moment the
	 * task starts.
	 *
	 * `ask` is required, not cosmetic: under the `never` policy the approval
	 * service answers `rejected` *before* any answerer runs, so the grant in layer
	 * 3 would never be consulted and a tool that genuinely needed a decision would
	 * fail the task instead of proceeding.
	 *
	 * @param {object} agent - the live Agent that will run the task.
	 * @param {boolean} enabled - whether this task's workspace skips authorizations.
	 * @returns {void}
	 */
	harden(agent, enabled) {
		const session = agent?.session;
		if (session === undefined) return;
		if (!enabled) {
			// A workspace that does not skip authorizations never manages its
			// sessions, so there is nothing to undo: nothing was granted.
			this.release(session.id);
			return;
		}
		this.manage(session.id);
		try {
			session.append('sandbox/mode', { mode: UNATTENDED_SANDBOX_MODE });
		} catch (error) {
			this.log(`could not set the sandbox mode for ${session.id}: ${String(error)}`);
		}
		try {
			const approval = this.services.approval;
			// The service method also tells the model the policy changed; the raw
			// append is what the permission-presets service itself uses for a
			// programmatic switch, and is the fallback when approval is absent.
			if (approval !== undefined && typeof approval.setPolicy === 'function') {
				approval.setPolicy(agent, REACHABLE_APPROVAL_POLICY);
			} else {
				session.append('approval/policy', { policy: REACHABLE_APPROVAL_POLICY });
			}
		} catch (error) {
			try {
				session.append('approval/policy', { policy: REACHABLE_APPROVAL_POLICY });
			} catch (inner) {
				// Layers 1 and 2 still carry the guarantee for the shipped tools.
				this.log(`could not relax the approval policy for ${session.id}: ${String(inner ?? error)}`);
			}
		}
	}
}
