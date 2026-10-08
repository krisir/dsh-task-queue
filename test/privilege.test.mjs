/**
 * Unattended-execution tests.
 *
 * The point of these is the boundary: the queue's own sessions never stop to
 * ask, and every other session in the Host keeps its normal permissions. A
 * bypass that leaked into the user's interactive session would be a far worse
 * bug than one that failed to apply, so the negative cases here matter as much
 * as the positive ones.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Privileges, UNATTENDED_SANDBOX_MODE } from '../host/privilege.js';

/** A Host context stub that records listener registration and policy changes. */
function buildCtx() {
	const listeners = new Map();
	const policies = [];
	return {
		listeners,
		policies,
		approval: {
			setPolicy(agent, policy) {
				policies.push({ sessionId: agent.session.id, policy });
			},
		},
		on(event, listener, options) {
			const list = listeners.get(event) ?? [];
			list.push({ listener, options });
			listeners.set(event, list);
			return () => {};
		},
	};
}

/** A session stub that records the events appended to its log. */
function buildSession(id) {
	const events = [];
	return {
		id,
		events,
		append(type, data) {
			events.push({ type, data });
		},
	};
}

/** Arm a privilege set and hand back the installed listeners. */
function arm(ctx, services) {
	const privileges = new Privileges(ctx, {
		services: services ?? { approval: ctx.approval },
		log: () => {},
	});
	privileges.install();
	return privileges;
}

/** Invoke the single listener registered for an event. */
function fire(ctx, event, ...args) {
	const entries = ctx.listeners.get(event) ?? [];
	assert.equal(entries.length, 1, `expected exactly one ${event} listener`);
	return entries[0].listener(...args);
}

test('both hooks are registered first in their waterfall', () => {
	const ctx = buildCtx();
	arm(ctx);
	for (const event of ['tools/pre-execute', 'approval/request']) {
		const entries = ctx.listeners.get(event);
		assert.ok(entries, `${event} is hooked`);
		assert.equal(entries[0].options?.prepend, true, `${event} must outrank the Web GUI answerer`);
	}
});

test('a managed session gets its tool calls allowed', () => {
	const ctx = buildCtx();
	const privileges = arm(ctx);
	privileges.manage('session-task');
	const decision = fire(ctx, 'tools/pre-execute', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	assert.deepEqual(decision, { kind: 'allow' });
});

test('an unmanaged session is left completely alone', () => {
	const ctx = buildCtx();
	arm(ctx);
	const delegated = fire(ctx, 'tools/pre-execute', { agent: { session: { id: 'session-mine' } } }, () => 'delegated');
	assert.equal(delegated, 'delegated', 'the caller\'s own session keeps normal permissions');
});

test('an unmanaged approval request falls through to the normal answerers', () => {
	const ctx = buildCtx();
	arm(ctx);
	const delegated = fire(ctx, 'approval/request', { agent: { session: { id: 'session-mine' } } }, () => 'delegated');
	assert.equal(delegated, 'delegated');
});

test('a managed approval request is granted rather than queued for a sleeping human', () => {
	const ctx = buildCtx();
	const privileges = arm(ctx);
	privileges.manage('session-task');
	const outcome = fire(ctx, 'approval/request', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	assert.equal(outcome, 'allowed-once');
});

test('a workspace that does not skip authorizations never grants anything', () => {
	// The switch is per workspace, so it arrives with each task rather than
	// living on the helper: hardening with it off leaves the session unmanaged.
	const ctx = buildCtx();
	const privileges = arm(ctx);
	const session = buildSession('session-task');
	privileges.harden({ session }, false);
	assert.equal(privileges.isManaged('session-task'), false);
	assert.deepEqual(session.events, [], 'nothing is relaxed on the session log either');
	const tool = fire(ctx, 'tools/pre-execute', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	const approval = fire(ctx, 'approval/request', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	assert.equal(tool, 'delegated');
	assert.equal(approval, 'delegated');
});

test('turning a workspace off releases a session that was already relaxed', () => {
	const ctx = buildCtx();
	const privileges = arm(ctx);
	const session = buildSession('session-task');
	privileges.harden({ session }, true);
	assert.equal(privileges.isManaged('session-task'), true);
	privileges.harden({ session }, false);
	assert.equal(privileges.isManaged('session-task'), false, 'the grants stop with the setting');
	const tool = fire(ctx, 'tools/pre-execute', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	assert.equal(tool, 'delegated');
});

test('hardening a session relaxes the sandbox and makes asks reachable', () => {
	const ctx = buildCtx();
	const privileges = arm(ctx);
	const session = buildSession('session-task');
	privileges.harden({ session }, true);
	assert.deepEqual(session.events, [{ type: 'sandbox/mode', data: { mode: UNATTENDED_SANDBOX_MODE } }]);
	assert.deepEqual(ctx.policies, [{ sessionId: 'session-task', policy: 'ask' }]);
	assert.equal(privileges.isManaged('session-task'), true, 'the session is tracked by harden alone');
});

test('a released session is back under normal rules', () => {
	const ctx = buildCtx();
	const privileges = arm(ctx);
	privileges.manage('session-task');
	privileges.release('session-task');
	const decision = fire(ctx, 'tools/pre-execute', { agent: { session: { id: 'session-task' } } }, () => 'delegated');
	assert.equal(decision, 'delegated');
});

test('a malformed event cannot crash the tool pipeline', () => {
	const ctx = buildCtx();
	arm(ctx);
	const decision = fire(ctx, 'tools/pre-execute', {}, () => 'delegated');
	assert.equal(decision, 'delegated', 'a missing agent delegates instead of throwing');
});

test('hardening survives a service that refuses the policy change', () => {
	const ctx = buildCtx();
	ctx.approval.setPolicy = () => {
		throw new Error('nope');
	};
	const privileges = arm(ctx);
	const session = buildSession('session-task');
	privileges.harden({ session }, true);
	// The log-only write path is the fallback, so the knob still moves.
	assert.deepEqual(session.events.at(-1), { type: 'approval/policy', data: { policy: 'ask' } });
});

test('hardening works in a composition that has no approval service at all', () => {
	// Cordis throws on a property read for an undeclared service, so this path
	// is reached by absence of a handle, never by catching that throw.
	const ctx = buildCtx();
	const privileges = arm(ctx, {});
	const session = buildSession('session-task');
	privileges.harden({ session }, true);
	assert.deepEqual(session.events, [
		{ type: 'sandbox/mode', data: { mode: UNATTENDED_SANDBOX_MODE } },
		{ type: 'approval/policy', data: { policy: 'ask' } },
	]);
	assert.equal(privileges.isManaged('session-task'), true);
});
