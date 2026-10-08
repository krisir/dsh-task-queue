/**
 * Client smoke test.
 *
 * It loads the real generated `client.js` — not the sources — into a stub module
 * loader, applies it against a stub client context, and then drives the page the
 * way a user does: read the queue, open the settings tab, change the window, save.
 *
 * React is stubbed rather than installed, because the point is not to test React
 * but to prove four things the runtime cannot check for us: that the bundle
 * requires nothing outside the seed table, that both dictionaries cover exactly
 * the same key set (a missing key renders as the raw key in front of a user),
 * that the view registers beside the shipped ones without taking their cell, and
 * that nothing on the page captures the pointer — the bug that made the settings
 * tab look dead. The translator here throws on an unknown key, so any `t()` call
 * the dictionaries do not cover fails the test rather than silently shipping.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

// The Host's own field list, so the browser half's payload can be checked against
// the thing that actually has to accept it rather than against a copy of it.
import { DEFAULT_WORKSPACE_SETTINGS } from '../host/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** The session the page is mounted for in these tests. */
const SESSION = 'session-viewing';

const FRAGMENT = Symbol('react.fragment');

/**
 * A React stub: enough of the real surface for these components, no rendering
 * engine, no scheduler.
 */
function makeReact() {
	return {
		createElement(type, props, ...children) {
			const merged = { ...(props ?? {}) };
			if (children.length === 1) merged.children = children[0];
			else if (children.length > 1) merged.children = children;
			return { $$element: true, type, props: merged };
		},
		Fragment: FRAGMENT,
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useRef: (initial) => ({ current: initial ?? null }),
		// Effects run inline, once per render. There is no reconciler here to run
		// them after paint or to diff dependencies, and running them is what makes
		// the page's initial host read happen at all — without it every assertion
		// would be checking a loading state.
		useEffect: (effect) => {
			effect();
		},
		useLayoutEffect: (effect) => {
			effect();
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
	};
}

/** Load the bundle and hand back its registered factory. */
function loadBundle() {
	let registration = null;
	/** Poll callbacks the page armed, so a test can fire one on demand. */
	const polls = [];
	// The page polls while it is on screen. The callback is kept so a test can
	// fire a poll on demand: a refresh landing mid-edit is exactly the situation
	// that must not disturb what the user has typed, and nothing else can drive
	// it from the outside.
	const context = {
		window: {
			__ModuleLoader__: {
				load(entry) {
					registration = entry;
				},
			},
			setInterval: (callback) => {
				polls.push(callback);
				return polls.length;
			},
			clearInterval: () => {},
			innerWidth: 1440,
			innerHeight: 900,
		},
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {}, remove() {} }),
			head: { appendChild() {} },
		},
		// The bundle runs in its own realm, so it cannot see the test's globals.
		// `fetch` is delegated rather than copied so each test's stub wins.
		fetch: (...args) => globalThis.fetch(...args),
		Intl,
		Date,
		JSON,
		Object,
		Array,
		Math,
		Number,
		String,
		Boolean,
		Symbol,
		Error,
		Set,
		Map,
		RegExp,
		AbortController,
	};
	context.globalThis = context;
	runInNewContext(bundle, context, { filename: 'client.js' });
	assert.ok(registration !== null, 'client.js must register a factory via window.__ModuleLoader__.load');
	assert.equal(registration.id, 'dsh-plugin-task-queue', 'the bundle id must equal the package name');
	return { registration, polls };
}

/** The module the factory produces. */
function loadModule() {
	const { registration, polls } = loadBundle();
	const react = makeReact();
	const require = (spec) => {
		if (spec === 'react') return react;
		throw new Error(`unexpected require("${spec}")`);
	};
	return { module: registration.factory(require), react, polls };
}

/** A client context stub that records what the plugin registers. */
function makeCtx() {
	const registrations = [];
	const localeCalls = [];
	return {
		registrations,
		localeCalls,
		effect(fn) {
			const dispose = fn();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		locale: {
			register(ns, dicts) {
				localeCalls.push({ ns, dicts });
				return () => {};
			},
			// The plugin binds once to label its view tab; the stub resolves the
			// key against whatever dictionary the plugin registered.
			bind(ns) {
				return (key) => {
					const call = localeCalls.find((entry) => entry.ns === ns);
					return call === undefined ? key : call.dicts.zh[key];
				};
			},
		},
		slots: {
			inject(slotName, callback) {
				callback();
				return () => {};
			},
			register(descriptor, component) {
				registrations.push({ descriptor, component });
				return () => {};
			},
		},
	};
}

/**
 * Expand an element tree into leaf text and a flat list of every element.
 *
 * Function components are invoked, which means a hook used outside the top level
 * of a component surfaces here as a real error rather than a silent pass.
 */
function render(node, collected = { texts: [], elements: [] }) {
	if (node === null || node === undefined || typeof node === 'boolean') return collected;
	if (Array.isArray(node)) {
		for (const child of node) render(child, collected);
		return collected;
	}
	if (typeof node === 'string' || typeof node === 'number') {
		collected.texts.push(String(node));
		return collected;
	}
	if (typeof node === 'object' && node.$$element === true) {
		collected.elements.push(node);
		if (node.type === FRAGMENT || typeof node.type === 'symbol') {
			render(node.props.children, collected);
			return collected;
		}
		if (typeof node.type === 'function') {
			render(node.type({ ...node.props, children: node.props.children }), collected);
			return collected;
		}
		render(node.props.children, collected);
		return collected;
	}
	return collected;
}

/** Find every element whose props satisfy a predicate. */
function findAll(tree, predicate) {
	return render(tree).elements.filter((element) => predicate(element));
}

/** A realistic host snapshot, shaped exactly like `GET /state`. */
function snapshot(overrides = {}) {
	return {
		version: 2,
		now: Date.parse('2025-01-01T09:00:00Z'),
		workspace: { id: 'ws-1', title: '我的项目', path: '/tmp/p' },
		settings: {
			enabled: true,
			windows: [{ start: '18:00', end: '07:00' }],
			timeZone: 'Asia/Shanghai',
			autoApprove: true,
			targetMode: 'shared',
			runnerSessionId: '',
			taskTimeoutMinutes: 360,
			cooldownMinutes: 0,
			compactBeforeTask: false,
		},
		unassignedCount: 0,
		tasks: [
			{
				id: 'aaaaaaaa-1111',
				prompt: '把 src 下的 console.log 都删掉',
				status: 'queued',
				createdAt: Date.parse('2025-01-01T08:00:00Z'),
				updatedAt: Date.parse('2025-01-01T08:00:00Z'),
				attempts: 0,
				seq: 1,
			},
			{
				id: 'bbbbbbbb-2222',
				prompt: '跑一遍完整测试并总结失败项',
				status: 'failed',
				createdAt: Date.parse('2025-01-01T07:00:00Z'),
				updatedAt: Date.parse('2025-01-01T07:30:00Z'),
				attempts: 1,
				seq: 2,
				error: 'model exploded',
			},
		],
		archived: [],
		runtime: { windowOpen: false, nextWindowChangeAt: Date.parse('2025-01-01T10:00:00Z'), cooldownUntil: null },
		...overrides,
	};
}

/** Install a fetch stub that serves one snapshot and records mutations. */
function installFetch(state) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		const raw = String(url).replace('/dsh-task-queue/api', '');
		const path = raw.split('?')[0];
		calls.push({ path, raw, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => JSON.stringify(path === '/state' ? state : { state }),
		};
	};
	return calls;
}

/** A translator that throws on an unknown key, so a missing entry cannot hide. */
function makeTranslator(dict) {
	return (key, vars) => {
		if (!(key in dict)) throw new Error(`missing locale key: ${key}`);
		const text = dict[key];
		if (vars === undefined) return text;
		return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
	};
}

/**
 * Apply the plugin and settle the read it kicks off.
 *
 * The page is mounted by the shell, so there is no launcher to click: the view
 * entry itself is the whole surface, and rendering it is what a user sees.
 */
async function setup(state = snapshot()) {
	const { module, polls } = loadModule();
	const ctx = makeCtx();
	const calls = installFetch(state);
	module.apply(ctx);
	const dicts = ctx.localeCalls[0].dicts;
	const view = ctx.registrations.find((entry) => entry.descriptor.name === 'conversation.view');
	assert.ok(view, 'the page is registered as a conversation view');
	const t = makeTranslator(dicts.zh);
	await new Promise((resolve) => setImmediate(resolve));
	/** Render the page with a translator the test controls. */
	// The slot injects the session the page was opened from; the shell would pass
	// it the same way.
	const injected = view.descriptor.inject === undefined ? {} : view.descriptor.inject(SESSION);
	const page = () => view.component({ ...injected, t });
	// Mounting is what runs the page's effect, and the effect is what reads the
	// host. Render once and let that read land, so every caller sees a loaded page.
	page();
	await new Promise((resolve) => setImmediate(resolve));
	/** Fire the page's own poll, and let the read it starts land. */
	const poll = async () => {
		assert.ok(polls.length > 0, 'the page armed a poll');
		for (const callback of polls) callback();
		await new Promise((resolve) => setImmediate(resolve));
	};
	return { module, ctx, calls, dicts, view, t, page, injected, poll };
}

/** Click the first element matching a predicate, then let the call settle. */
async function click(tree, predicate) {
	const target = findAll(tree, predicate)[0];
	assert.ok(target, 'the expected control is on the page');
	target.props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
}

/** Whether an element's children include a given label, array or not. */
function labelled(element, text) {
	const children = element.props.children;
	if (children === text) return true;
	return Array.isArray(children) && children.includes(text);
}

/** The settings tab, selected by its visible label. */
const settingsTab = (element) => element.props.className === 'tq-tab' && labelled(element, '设置');

/**
 * The inline edit control on a card.
 *
 * It is an icon button, so its label is in `aria-label`/`title` rather than in
 * its children — matching on the accessible name is what a user's screen reader
 * would do, and it is the only name the button has.
 */
const editButton = () => (element) =>
	typeof element.props.onClick === 'function' && element.props['aria-label'] === '编辑';

/** The footer's save button: the last primary button on the page. */
const saveButton = (element) => element.props.className === 'tq-btn tq-btn-primary';

/** A clickable control carrying a given label. */
const action = (label) => (element) =>
	typeof element.props.onClick === 'function' && labelled(element, label);

test('the page registers beside the shipped views without taking their cell', async () => {
	const { module, view, ctx } = await setup();
	// The array comes from another realm, so compare its contents, not its identity.
	assert.equal(module.inject.join(','), 'slots,locale');
	assert.equal(ctx.localeCalls[0].ns, 'taskQueue');
	assert.equal(view.descriptor.id, 'task-queue', 'a fresh id, never `chat` or `trajectory`');
	assert.ok(view.descriptor.order > 10, 'ordered after the shipped trajectory view (order 10)');
	assert.equal(view.descriptor.locale, 'taskQueue');
	assert.equal(view.descriptor.label(), '任务', 'the tab label comes from the dictionary, not the raw id');
});

test('both dictionaries cover exactly the same keys', async () => {
	const { dicts } = await setup();
	const zhKeys = Object.keys(dicts.zh).sort();
	const enKeys = Object.keys(dicts.en).sort();
	assert.deepEqual(enKeys, zhKeys, 'a key present in one dictionary and not the other renders as the raw key');
	const empty = zhKeys.filter((key) => dicts.zh[key].trim() === '' || dicts.en[key].trim() === '');
	assert.deepEqual(empty, [], 'an empty translation is worse than a missing one');
});

test('nothing on the page captures the pointer', async () => {
	// A drag handler that captures the pointer on pointerdown also swallows the
	// click of every button inside it, which is exactly how the settings tab came
	// to look dead. The page owns no gesture, so it must own no capture either.
	const { page } = await setup();
	const gestures = findAll(page(), (element) => typeof element.props.onPointerDown === 'function');
	assert.deepEqual(gestures, [], 'the page must not install a pointer-capturing gesture');
});

test('the page shows its title, both tabs, and the queue', async () => {
	const { page } = await setup();
	const rendered = render(page());
	assert.ok(rendered.texts.includes('任务队列'), 'the page names itself');
	assert.ok(rendered.texts.includes('队列'), 'the queue tab is present');
	assert.ok(rendered.texts.includes('设置'), 'the settings tab is present');
	// A card has no title: its heading is the instruction's first line.
	assert.ok(rendered.texts.includes('把 src 下的 console.log 都删掉'), 'the first task renders');
	assert.ok(rendered.texts.includes('跑一遍完整测试并总结失败项'), 'the second task renders');
	assert.ok(rendered.texts.includes('排队中'), 'the queued card carries its status');
	assert.ok(rendered.texts.includes('失败'), 'the failed card carries its status');
	assert.ok(rendered.texts.includes('model exploded'), 'a failure shows its reason');
});

test('typing in the composer does not disturb the queue on screen', async () => {
	// The regression this test exists for: one keystroke made the whole page
	// vanish. The composer wrote its draft through the store's callback form,
	// which replaced the state instead of merging it, so the loaded snapshot was
	// erased and the page fell back to its loading state — looking exactly like
	// "typing triggered a query".
	//
	// The second render deliberately does not await: the point is what the store
	// holds immediately after the keystroke, which is precisely the state a real
	// React render would read.
	const { page } = await setup();
	const prompt = findAll(page(), (element) => element.type === 'textarea')[0];
	assert.ok(prompt, 'the composer is on screen');
	prompt.props.onChange({ target: { value: '把缓存清掉' } });

	const after = render(page());
	const texts = after.texts.join(' | ');
	assert.ok(after.texts.includes('把 src 下的 console.log 都删掉'), 'the queue is still on screen');
	assert.ok(after.texts.includes('新建任务'), 'the composer is still on screen');
	assert.doesNotMatch(texts, /正在读取任务列表|正在读取队列/, 'and it is not showing its loading state');

	const typed = findAll(page(), (element) => element.type === 'textarea')[0];
	assert.equal(typed.props.value, '把缓存清掉', 'the typed text is kept');
});

test('the settings tab opens when it is clicked', async () => {
	// The regression this test exists for: the tab was clickable in the markup and
	// dead in the browser.
	const { page } = await setup();
	assert.ok(findAll(page(), settingsTab).length === 1, 'the settings tab is rendered');
	await click(page(), settingsTab);
	const rendered = render(page());
	assert.ok(rendered.texts.includes('执行时段'), 'the window group is on screen');
	assert.ok(rendered.texts.includes('保存设置'), 'and the save button is reachable in the footer');
});

test('the window fields show the configured times and can be changed', async () => {
	const { page } = await setup();
	await click(page(), settingsTab);

	const timeInputs = findAll(page(), (element) => element.type === 'input' && element.props.type === 'time');
	assert.equal(timeInputs.length, 2, 'start and end are editable times');
	assert.deepEqual(
		timeInputs.map((element) => element.props.value),
		['18:00', '07:00'],
		'the fields show the configured window',
	);

	// Changing the start time marks the form dirty and enables save.
	timeInputs[0].props.onChange({ target: { value: '20:30' } });
	const save = findAll(page(), saveButton).at(-1);
	assert.equal(save.props.disabled, false, 'save becomes available once the form differs');
	const preview = render(page()).texts.some((text) => text.includes('20:30 ～ 次日 07:00'));
	assert.ok(preview, 'the preview follows the edit');
});

test('saving posts the window and then adopts the host result', async () => {
	const { page, calls } = await setup();
	await click(page(), settingsTab);
	const timeInputs = findAll(page(), (element) => element.type === 'input' && element.props.type === 'time');
	timeInputs[0].props.onChange({ target: { value: '20:30' } });
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);

	const saved = calls.find((call) => call.path === '/settings');
	assert.ok(saved, 'the settings patch was sent');
	const patch = JSON.parse(saved.body);
	assert.deepEqual(patch.windows, [{ start: '20:30', end: '07:00' }], 'the edited window is sent whole');
	assert.equal(patch.timeZone, 'Asia/Shanghai', 'and so are the untouched fields');
	assert.equal(patch.sessionId, SESSION, 'the request names the session it came from');
});

test('every request names the session, which is how the host scopes the queue', async () => {
	// The page never sends a workspace id: the host resolves the session, so a
	// client cannot file a task in a queue it is not looking at.
	const { page, calls } = await setup();
	const read = calls.find((call) => call.path === '/state');
	assert.ok(read.raw.includes('sessionId=' + SESSION), 'the read names its session');

	await click(page(), (element) => element.props.title === '删除');
	const removed = calls.find((call) => call.path === '/tasks/delete');
	assert.ok(removed, 'a mutation was sent');
	assert.equal(JSON.parse(removed.body).sessionId, SESSION);
	assert.ok(!JSON.stringify(JSON.parse(removed.body)).includes('workspaceId'), 'and never a workspace id');
});

test('the header names the workspace the queue belongs to', async () => {
	const { page } = await setup();
	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /我的项目/, 'so there is no doubt which queue is on screen');
});

test('several windows can be added and removed in the settings face', async () => {
	const { page, calls } = await setup();
	await click(page(), settingsTab);
	assert.equal(findAll(page(), (element) => element.type === 'input' && element.props.type === 'time').length, 2);

	await click(page(), (element) => labelled(element, '添加时段'));
	const after = findAll(page(), (element) => element.type === 'input' && element.props.type === 'time');
	assert.equal(after.length, 4, 'a second window is editable straight away');

	// Remove the first window and save.
	await click(page(), (element) => element.props.title === '删除第 1 个时段');
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);
	const saved = calls.find((call) => call.path === '/settings');
	const patch = JSON.parse(saved.body);
	assert.equal(patch.windows.length, 1, 'the removal is part of the saved list');
	assert.deepEqual(patch.windows[0], { start: '09:00', end: '18:00' }, 'the added window is what remains');
});

test('the execution settings carry the interval and the compaction switch', async () => {
	const { page, calls } = await setup();
	await click(page(), settingsTab);

	const cooldown = findAll(page(), (element) => element.props.id === 'tq-cooldown')[0];
	assert.ok(cooldown, 'the interval field is on screen');
	assert.equal(cooldown.props.value, 0, 'and starts at "no wait"');
	cooldown.props.onChange({ target: { value: '30' } });

	const compact = findAll(page(), (element) => element.type === 'input' && element.props.type === 'checkbox');
	assert.ok(compact.length > 0, 'the toggles are on screen');

	await click(page(), (element) => saveButton(element) && element.props.disabled === false);
	const patch = JSON.parse(calls.find((call) => call.path === '/settings').body);
	assert.equal(patch.cooldownMinutes, 30, 'half an hour is sent');
	assert.equal(typeof patch.compactBeforeTask, 'boolean', 'and so is the compaction switch');
});

test('the compaction switch is saved and sent back', async () => {
	const { page, calls } = await setup();
	await click(page(), settingsTab);
	// The switch is the checkbox labelled with the compaction text; find it by
	// walking the labels rather than by position.
	const labels = findAll(page(), (element) => element.type === 'label' && element.props.className === 'tq-toggle');
	const compaction = labels.find((label) =>
		JSON.stringify(label.props.children).includes('压缩'),
	);
	assert.ok(compaction, 'the compaction toggle is on screen');
	const checkbox = compaction.props.children.find((child) => child.type === 'input');
	assert.equal(checkbox.props.checked, false, 'off by default');
	checkbox.props.onChange({ target: { checked: true } });
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);
	assert.equal(JSON.parse(calls.find((call) => call.path === '/settings').body).compactBeforeTask, true);
});

test('an untouched form cannot be saved', async () => {
	const { page } = await setup();
	await click(page(), settingsTab);
	const save = findAll(page(), saveButton).at(-1);
	assert.equal(save.props.disabled, true, 'there is nothing to commit until something changes');
});

test('edits survive switching between the two faces', async () => {
	// The draft lives in the plugin store rather than in the component, so a
	// glance at the queue does not silently discard a half-typed window.
	const { page } = await setup();
	await click(page(), settingsTab);
	const timeInputs = findAll(page(), (element) => element.type === 'input' && element.props.type === 'time');
	timeInputs[0].props.onChange({ target: { value: '21:15' } });
	await click(page(), (element) => element.props.className === 'tq-tab' && element.props.children === '队列');
	await click(page(), settingsTab);
	const again = findAll(page(), (element) => element.type === 'input' && element.props.type === 'time');
	assert.equal(again[0].props.value, '21:15', 'the edit is still there');
});

test('the status line says the window is closed and when it opens', async () => {
	const { page } = await setup();
	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /时段外/, 'outside the window');
	assert.match(texts, /18:00/, 'the next opening time is shown');
});

test('the time until the window opens is rendered against the host clock', async () => {
	// `now` and `nextWindowChangeAt` come from the same snapshot; reading the
	// clock from anywhere else turns every relative time into NaN, which the
	// translator would happily render as "less than a minute".
	const soon = snapshot();
	soon.now = Date.parse('2025-01-01T07:00:00Z'); // 15:00 in Shanghai
	soon.runtime = { windowOpen: false, nextWindowChangeAt: Date.parse('2025-01-01T10:00:00Z'), cooldownUntil: null };
	const { page } = await setup(soon);
	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /18:00/, 'the opening wall-clock time is shown');
	assert.match(texts, /3 小时后/, 'and a real interval, not a placeholder');
	assert.doesNotMatch(texts, /NaN/, 'an unreadable clock must never reach the user');
});

test('inside the window the status line reports live counts', async () => {
	const live = snapshot({
		runtime: { windowOpen: true, nextWindowChangeAt: Date.parse('2025-01-01T23:00:00Z'), cooldownUntil: null },
	});
	const { page } = await setup(live);
	assert.match(render(page()).texts.join(' | '), /正在执行时段内/);
});

test('a paused queue says so instead of pretending a window will open', async () => {
	const paused = snapshot();
	paused.settings.enabled = false;
	const { page } = await setup(paused);
	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /已暂停/);
	assert.doesNotMatch(texts, /将于/, 'a paused queue must not promise a start time');
});

test('moving a task up swaps it with its neighbour and posts the new order', async () => {
	// Two queued tasks: only a waiting task has a place in the line to move.
	const state = snapshot();
	state.tasks = state.tasks.map((task) => ({ ...task, status: 'queued', error: undefined }));
	const { page, calls } = await setup(state);
	assert.equal(findAll(page(), (element) => element.props.title === '上移一位').length, 1, 'only the second card can move up');
	await click(page(), (element) => element.props.title === '上移一位');
	const reorder = calls.find((call) => call.path === '/tasks/reorder');
	assert.ok(reorder, 'a reorder request was sent');
	assert.deepEqual(JSON.parse(reorder.body).ids, ['bbbbbbbb-2222', 'aaaaaaaa-1111'], 'the two tasks swapped');
});

test('a task typed into the composer is posted and the form clears', async () => {
	const { page, calls } = await setup();
	const prompt = findAll(page(), (element) => element.type === 'textarea')[0];
	assert.ok(prompt, 'the composer is a single instruction field');
	assert.equal(findAll(page(), (element) => element.props.id === 'tq-new-title').length, 0, 'there is no title field');
	prompt.props.onChange({ target: { value: '把 src 下的 console.log 都删掉' } });

	await click(page(), (element) => saveButton(element) && element.props.disabled === false);
	const posted = calls.find((call) => call.path === '/tasks' && call.method === 'POST');
	assert.ok(posted, 'the task was sent');
	assert.deepEqual(JSON.parse(posted.body), {
		sessionId: SESSION,
		prompt: '把 src 下的 console.log 都删掉',
	});

	// The composer is still mounted and now empty, rather than the page resetting.
	const after = render(page());
	assert.ok(after.texts.includes('新建任务'), 'the composer survived the write');
	const textareas = findAll(page(), (element) => element.type === 'textarea');
	assert.equal(textareas[0].props.value, '', 'and the form cleared itself');
});

test('every card shows its place in the execution order', async () => {
	const { page } = await setup();
	const ordinals = findAll(page(), (element) => element.props.className === 'tq-ordinal').map(
		(element) => element.props.children,
	);
	assert.deepEqual(ordinals, ['#1', '#2'], 'the order is on the card, not inferred from position');
});

test('the archive tab carries the number of filed-away tasks', async () => {
	const state = snapshot();
	state.archived = [
		{ id: 'old-1', prompt: '归档的旧任务', status: 'done', createdAt: 1, finishedAt: 2, result: '做完了' },
	];
	const { page } = await setup(state);
	const counts = findAll(page(), (element) => element.props.className === 'tq-tab-count');
	assert.equal(counts.length, 1, 'only the archive tab is badged');
	assert.equal(counts[0].props.children, '1');
});

test('the archive face lists what was filed away, with its result', async () => {
	const state = snapshot();
	state.archived = [
		{ id: 'old-1', prompt: '归档的旧任务', status: 'done', createdAt: 1, finishedAt: 2, result: '做完了' },
	];
	const { page } = await setup(state);
	await click(page(), (element) => element.props.className === 'tq-tab' && labelled(element, '归档'));
	const rendered = render(page());
	assert.ok(rendered.texts.includes('归档的旧任务'), 'the archived task is shown');
	assert.ok(rendered.texts.includes('做完了'), 'with what it produced');
	assert.ok(rendered.texts.includes('移回队列'), 'and a way back out');
	assert.ok(
		!rendered.texts.includes('新建任务'),
		'and the composer is not on the history face',
	);
});

test('archiving completed tasks is one click', async () => {
	const { page, calls } = await setup();
	await click(page(), action('归档已完成'));
	const posted = calls.find((call) => call.path === '/tasks/archive');
	assert.ok(posted, 'the archive request was sent');
	assert.equal(posted.method, 'POST');
});

test('the bulk archive button sits above the task list, not below it', async () => {
	// It acts on the list as a whole, so it belongs where the list starts. Below
	// the last card it is a control you have to scroll past every task to reach,
	// which is backwards on a queue that is read top-down.
	const { page } = await setup();
	const elements = render(page()).elements;

	const button = elements.findIndex((element) => action('归档已完成')(element));
	// Cards carry `tq-card tq-card-<status>`, so this matches the class as a word
	// rather than as the whole attribute.
	const firstCard = elements.findIndex((element) =>
		String(element.props.className ?? '')
			.split(' ')
			.includes('tq-card'),
	);
	const composer = elements.findIndex((element) => element.type === 'form');

	assert.ok(button !== -1, 'the archive button is on the queue face');
	assert.ok(firstCard !== -1, 'the queue face has cards to archive');
	assert.ok(button < firstCard, 'and the button comes before the first card');
	assert.ok(button > composer, 'but after the composer, which is what creates tasks');
});

test('clearing the archive asks first, and only then deletes', async () => {
	// The one irreversible bulk action: the first click arms it, the second
	// confirms. "One click" is not worth losing history over.
	const state = snapshot();
	state.archived = [{ id: 'old-1', prompt: 'x', status: 'done', createdAt: 1, archivedAt: 2 }];
	const { page, calls } = await setup(state);
	await click(page(), (element) => element.props.className === 'tq-tab' && labelled(element, '归档'));

	await click(page(), action('清空归档'));
	assert.ok(!calls.some((call) => call.path === '/tasks/archive/clear'), 'nothing was deleted yet');
	assert.ok(render(page()).texts.includes('确认清空？'), 'the button says what the next click does');
	assert.ok(render(page()).texts.includes('清空后无法恢复。'), 'and warns that it cannot be undone');

	await click(page(), action('确认清空？'));
	assert.ok(calls.some((call) => call.path === '/tasks/archive/clear'), 'the second click deletes');
});

test('an empty archive cannot be cleared', async () => {
	const { page } = await setup();
	await click(page(), (element) => element.props.className === 'tq-tab' && labelled(element, '归档'));
	const clear = findAll(page(), action('清空归档'))[0];
	assert.equal(clear.props.disabled, true, 'there is nothing to clear');
});

test('the settings offer exactly two execution places, shared by default', async () => {
	const { page, calls } = await setup();
	await click(page(), settingsTab);
	const select = findAll(page(), (element) => element.props.id === 'tq-target')[0];
	assert.deepEqual(
		select.props.children.map((option) => option.props.value),
		['shared', 'fresh'],
		'shared first, and no pinned-session mode',
	);
	assert.equal(select.props.value, 'shared', 'the recommended one is selected');

	assert.equal(findAll(page(), (element) => element.props.id === 'tq-concurrent').length, 0, 'concurrency is not a setting');
	assert.equal(findAll(page(), (element) => element.props.id === 'tq-runner').length, 0, 'nor is a pinned session id');

	// Make a change so there is something to commit.
	findAll(page(), (element) => element.props.id === 'tq-cooldown')[0].props.onChange({ target: { value: '10' } });
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);
	const patch = JSON.parse(calls.find((call) => call.path === '/settings').body);
	assert.equal(patch.targetMode, 'shared');
	assert.equal(findAll(page(), (element) => element.props.id === 'tq-concurrent').length, 0);
});

test('the settings form sends exactly the fields the host knows', async () => {
	// The regression this test exists for: the Host stopped having a concurrency
	// setting and the browser half kept sending it, so every save reported a
	// refused field for a key that no longer existed. Checking the payload against
	// the Host's own defaults is what makes that class of drift impossible — the
	// two halves cannot disagree without this failing.
	const { page, calls } = await setup();
	await click(page(), settingsTab);
	findAll(page(), (element) => element.props.id === 'tq-cooldown')[0].props.onChange({ target: { value: '7' } });
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);

	const posted = JSON.parse(calls.find((call) => call.path === '/settings').body);
	const known = new Set([...Object.keys(DEFAULT_WORKSPACE_SETTINGS), 'sessionId']);
	const unknown = Object.keys(posted).filter((key) => !known.has(key));
	assert.deepEqual(unknown, [], 'the form must not invent a setting the host will drop');
	assert.ok('compactBeforeTask' in posted && 'cooldownMinutes' in posted, 'and must send the ones it shows');
});

test('a setting the host refuses is named instead of silently reverting', async () => {
	// The reported symptom was a switch that would not stay on: the running Host
	// did not know the key, dropped it, and the form quietly snapped back. Saying
	// which field was refused turns that into something actionable.
	const { page, calls } = await setup();
	// The host echoes a snapshot that lacks the change, as an older build would.
	globalThis.fetch = async (url, init) => {
		const path = String(url).replace('/dsh-task-queue/api', '').split('?')[0];
		calls.push({ path, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body });
		const body = JSON.parse(init?.body ?? '{}');
		const state = snapshot();
		delete state.settings.compactBeforeTask;
		// A read answers with the snapshot itself; a mutation answers with a
		// snapshot under `state`, exactly as the real route does.
		const payload = path === '/state' ? state : { state, echoed: body };
		return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(payload) };
	};
	await click(page(), settingsTab);
	const labels = findAll(page(), (element) => element.type === 'label' && element.props.className === 'tq-toggle');
	const compaction = labels.find((label) => JSON.stringify(label.props.children).includes('压缩'));
	const checkbox = compaction.props.children.find((child) => child.type === 'input');
	checkbox.props.onChange({ target: { checked: true } });
	await click(page(), (element) => saveButton(element) && element.props.disabled === false);

	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /宿主未接受/, 'the refusal is reported');
	assert.match(texts, /compactBeforeTask/, 'and names the field');
});

test('the composer refuses a blank task', async () => {
	const { page } = await setup();
	const add = findAll(page(), saveButton)[0];
	assert.equal(add.props.disabled, true, 'an empty composer cannot submit');
});

test('a host failure is surfaced instead of rendering an empty queue', async () => {
	const { module } = loadModule();
	const ctx = makeCtx();
	globalThis.fetch = async () => {
		throw new Error('connection refused');
	};
	module.apply(ctx);
	const view = ctx.registrations.find((entry) => entry.descriptor.name === 'conversation.view');
	const injected = view.descriptor.inject(SESSION);
	const t = makeTranslator(ctx.localeCalls[0].dicts.zh);
	view.component({ ...injected, t }); // mount, which starts the failing read
	await new Promise((resolve) => setImmediate(resolve));
	const texts = render(view.component({ ...injected, t })).texts.join(' | ');
	assert.match(texts, /connection refused/, 'the transport error is shown to the user');
});

test('a session with no workspace says so instead of showing an empty queue', async () => {
	const { page } = await setup(snapshot({ workspace: null, settings: null, tasks: [] }));
	const texts = render(page()).texts.join(' | ');
	assert.match(texts, /没有归属任何工作区/, 'the page explains the problem');
	assert.doesNotMatch(texts, /队列是空的/, 'and does not pretend the queue is simply empty');
});

test('a poll landing mid-edit does not disturb the composer', async () => {
	// A running task is refreshed from the host every five seconds, so the poll
	// lands while the user is typing. What they have typed is theirs, and a read
	// of the queue must never be what takes it away.
	const state = snapshot();
	state.tasks[0].status = 'running';
	const { page, poll } = await setup(state);

	const textarea = findAll(page(), (element) => element.type === 'textarea')[0];
	textarea.props.onChange({ target: { value: '把日志清理干净' } });
	assert.equal(
		findAll(page(), (element) => element.type === 'textarea')[0].props.value,
		'把日志清理干净',
		'the draft is on screen',
	);

	await poll();

	assert.equal(
		findAll(page(), (element) => element.type === 'textarea')[0].props.value,
		'把日志清理干净',
		'and the poll leaves it alone',
	);
});

test('a poll landing mid-edit does not disturb the settings form', async () => {
	const state = snapshot();
	state.tasks[0].status = 'running';
	const { page, poll } = await setup(state);

	await click(page(), (element) => element.props.className === 'tq-tab' && labelled(element, '设置'));

	const cooldown = findAll(page(), (element) => element.props.id === 'tq-cooldown')[0];
	cooldown.props.onChange({ target: { value: '45' } });
	assert.equal(
		findAll(page(), (element) => element.props.id === 'tq-cooldown')[0].props.value,
		45,
		'the new interval is in the form',
	);

	await poll();

	assert.equal(
		findAll(page(), (element) => element.props.id === 'tq-cooldown')[0].props.value,
		45,
		'and the poll does not reset it to what the host still has',
	);
});

test('a poll does not throw the user off the face they are on', async () => {
	const state = snapshot();
	state.tasks[0].status = 'running';
	const { page, poll } = await setup(state);

	await click(page(), (element) => element.props.className === 'tq-tab' && labelled(element, '设置'));
	await poll();

	const texts = render(page()).texts.join(' | ');
	assert.ok(texts.includes('执行间隔'), 'the settings face is still the one showing after a refresh');
});

test('a half-finished inline edit survives a poll', async () => {
	// The reported bug: with a task running, the page pulls a fresh snapshot every
	// five seconds and that read must not reach into the field the user is typing
	// in. The draft is the store's for exactly this reason.
	const state = snapshot();
	state.tasks[0].status = 'running';
	const { page, poll } = await setup(state);

	await click(page(), editButton());
	const edited = () => {
		const areas = findAll(page(), (element) => element.type === 'textarea');
		return areas[areas.length - 1];
	};
	edited().props.onChange({ target: { value: '只改了一半的内容' } });
	assert.equal(edited().props.value, '只改了一半的内容', 'the edit is in the field');

	await poll();

	assert.equal(edited().props.value, '只改了一半的内容', 'and the poll did not take it away');
});

test('a half-finished inline edit survives the page being remounted', async () => {
	// A task starting a session can make the shell rebuild the view list, which
	// remounts this page. Nothing the user has typed lives in component state, so
	// a remount is invisible to them — which is the point.
	const state = snapshot();
	state.tasks[0].status = 'running';
	const { page } = await setup(state);

	await click(page(), editButton());
	const areas = () => findAll(page(), (element) => element.type === 'textarea');
	areas()[areas().length - 1].props.onChange({ target: { value: '重挂载也不该丢' } });

	// Render again from scratch, as a remount does.
	const after = findAll(page(), (element) => element.type === 'textarea');
	assert.equal(after[after.length - 1].props.value, '重挂载也不该丢', 'the edit came back with the page');
});

test('cancelling an edit does not leave its text behind for the next one', async () => {
	// The draft is cleared when the editor closes, so the next task edited starts
	// from its own text rather than inheriting the abandoned one.
	const state = snapshot();
	const { page } = await setup(state);

	await click(page(), editButton());
	const areas = () => findAll(page(), (element) => element.type === 'textarea');
	areas()[areas().length - 1].props.onChange({ target: { value: '放弃掉的草稿' } });
	await click(page(), action('取消'));

	// Relative to the task's own text, so the store holds no draft of its own.
	assert.equal(areas()[areas().length - 1].props.value, '', 'the composer is the only area left');
});

test('the settings draft is seeded once and then owns the form', async () => {
	// The first edit seeds the draft from the host; afterwards the draft is the
	// truth for the form, so a poll landing mid-edit cannot pull a field back to
	// the value the host still has.
	const { page, poll } = await setup();
	await click(page(), settingsTab);

	const cooldown = () => findAll(page(), (element) => element.props.id === 'tq-cooldown')[0];
	cooldown().props.onChange({ target: { value: '45' } });
	await poll();
	cooldown().props.onChange({ target: { value: '50' } });

	assert.equal(cooldown().props.value, 50, 'the second edit built on the first, not on the host value');
});

test('the interval field says it is per workspace', async () => {
	// The setting is stored per workspace, and nothing in the UI used to say so —
	// which is what made "set it for this workspace" read as a missing feature.
	const { page } = await setup();
	await click(page(), settingsTab);

	const hints = findAll(page(), (element) => element.props.className === 'tq-hint').map(
		(element) => element.props.children,
	);
	const cooldownHint = hints.find(
		(text) => typeof text === 'string' && text.startsWith('上一个任务结束后'),
	);
	assert.ok(cooldownHint, 'the interval field has its hint');
	assert.match(cooldownHint, /当前工作区/, 'and it names the scope');
});
