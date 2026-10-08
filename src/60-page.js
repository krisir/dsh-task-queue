/**
 * The task queue page, mounted beside 对话 and 轨迹 in `conversation.view`.
 *
 * It is a full page rather than a floating panel for a reason that turned out to
 * be a bug report: a floating panel needs a drag handler on its header, and a
 * drag handler that captures the pointer on `pointerdown` also swallows the
 * `click` of every button inside that header. The page has no drag, so its
 * controls simply work.
 *
 * The page is a **workspace's** page. It is mounted per session, the host
 * resolves that session to a workspace, and everything shown — the queue, the
 * hours, the concurrency limit — belongs to that workspace alone. Nothing here
 * asks the user which workspace they meant, because the answer is wherever they
 * opened it.
 */

/** How many minutes since midnight an `HH:mm` names, or -1 when unparseable. */
function toMinutes(value) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
	if (match === null) return -1;
	return Number(match[1]) * 60 + Number(match[2]);
}

/** One window rendered as a phrase, with "next day" when it wraps midnight. */
function describeWindow(window, t) {
	return toMinutes(window.start) > toMinutes(window.end)
		? t('window.overnight', { start: window.start, end: window.end })
		: t('window.sameDay', { start: window.start, end: window.end });
}

/** Every window as one line, or the two distinct kinds of "nothing scheduled". */
function describeWindows(settings, t) {
	const windows = settings.windows ?? [];
	if (windows.length === 0) return t('window.none');
	return windows.map((window) => describeWindow(window, t)).join(' · ');
}

/** The status pill plus the sentence beside it. */
function describeQueueStatus(t, snapshot) {
	const settings = snapshot.settings;
	const runtime = snapshot.runtime;
	const running = snapshot.tasks.filter((task) => task.status === 'running').length;
	const queued = snapshot.tasks.filter((task) => task.status === 'queued').length;
	const windows = settings.windows ?? [];

	if (!settings.enabled) {
		return {
			pill: h('span', { className: 'tq-pill tq-pill-off' }, h('span', { className: 'tq-dot' }), t('status.paused')),
			note: t('status.pausedNote'),
		};
	}
	if (windows.length === 0) {
		return {
			pill: h('span', { className: 'tq-pill tq-pill-off' }, h('span', { className: 'tq-dot' }), t('status.noWindow')),
			note: t('status.noWindowNote'),
		};
	}
	if (runtime.windowOpen) {
		const until = runtime.nextWindowChangeAt;
		// A queue waiting out its execution interval looks exactly like a queue
		// that has stopped working, so the wait is named rather than left to be
		// inferred from the clock.
		const waiting = runtime.cooldownUntil === null ? 0 : Math.max(0, runtime.cooldownUntil - snapshot.now);
		const note =
			waiting > 0 && queued > 0
				? t('status.cooldownNote', {
						amount: humanDuration(waiting, t),
						queued,
						minutes: settings.cooldownMinutes,
					})
				: t('status.openNote', { running, queued });
		return {
			pill: h('span', { className: 'tq-pill tq-pill-open' }, h('span', { className: 'tq-dot' }), t('status.open')),
			note:
				note +
				(waiting > 0 && queued > 0
					? ''
					: until === null
						? ''
						: ' · ' + t('status.closesIn', { amount: humanDuration(until - snapshot.now, t) })),
		};
	}
	const until = runtime.nextWindowChangeAt;
	return {
		pill: h('span', { className: 'tq-pill tq-pill-closed' }, h('span', { className: 'tq-dot' }), t('status.closed')),
		note:
			t('status.closedNote', { queued }) +
			(until === null
				? ''
				: ' · ' +
					t('status.opensAt', {
						time: clockIn(until, settings.timeZone),
						amount: humanDuration(until - snapshot.now, t),
					})),
	};
}

/** The queue face: status, composer, and the cards. */
function QueueView({ t, sessionId, snapshot }) {
	const tasks = snapshot.tasks;
	const order = tasks.map((task) => task.id);
	const adoptable = snapshot.unassignedCount ?? 0;
	const done = tasks.filter((task) => task.status === 'done').length;
	const busy = useStore(uiStore, (state) => state.busy);

	return h(
		React.Fragment,
		null,
		h('div', { className: 'tq-note' }, describeQueueStatus(t, snapshot).note),
		adoptable > 0
			? h(
					'div',
					{ className: 'tq-note' },
					h('span', null, t('queue.unassigned', { count: adoptable })),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-btn',
							onClick: () => void mutate(sessionId, 'global', () => api.adoptUnassigned(sessionId)),
						},
						t('queue.adopt'),
					),
				)
			: null,
		h('h3', { className: 'tq-section-title' }, t('queue.addTitle')),
		h(TaskComposer, { t, sessionId }),
		tasks.length === 0
			? h('div', { className: 'tq-empty' }, t('queue.empty'))
			: tasks.map((task, index) =>
					h(TaskCard, {
						key: task.id,
						t,
						sessionId,
						task,
						order,
						ordinal: index + 1,
						isFirst: index === 0,
						isLast: index === tasks.length - 1,
					}),
				),
		h(
			'div',
			{ className: 'tq-row-end tq-row tq-bulk' },
			h(BulkAction, {
				t,
				label: t('queue.archiveDone'),
				confirmLabel: t('queue.archiveDone'),
				count: done,
				armed: false,
				disabled: busy === 'global',
				onClick: () => void mutate(sessionId, 'global', () => api.archiveCompleted(sessionId)),
			}),
		),
	);
}

/**
 * The settings face.
 *
 * Edits are held in a draft and applied by the footer's save button. That is
 * deliberate: a time field fires a change for every keystroke, and patching the
 * host on each one would make the queue briefly hold a window the user never
 * meant — say `1` while typing `18:00` — while the time-zone field would fight
 * the user on every character, because half a zone name is not a zone.
 *
 * The workspace and its directory are deliberately absent. A task belongs to the
 * workspace the page was opened from, so there is nothing to choose.
 */
function SettingsView({ t, snapshot, values, set }) {
	/** The turn every field needs: a number input yields a string. */
	const numeric = (raw, fallback) => {
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	};

	const windows = values.windows ?? [];

	/** Replace one window's field. */
	const setWindow = (index, patch) =>
		set({ windows: windows.map((window, at) => (at === index ? { ...window, ...patch } : window)) });

	/** Remove one window. An empty list is a real answer: schedule nothing. */
	const removeWindow = (index) => set({ windows: windows.filter((_, at) => at !== index) });

	/** Append a window. A daytime slot, so adding one is visibly different. */
	const addWindow = () => set({ windows: [...windows, { start: '09:00', end: '18:00' }] });

	return h(
		'div',
		{ className: 'tq-settings' },
		h(
			'div',
			{ className: 'tq-settings-group' },
			h('div', { className: 'tq-label' }, t('settings.windowGroup')),
			h('span', { className: 'tq-hint' }, t('settings.windowGroupHint')),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.enabled,
					onChange: (event) => set({ enabled: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.enabled')),
					h('span', { className: 'tq-hint' }, t('settings.enabledHint')),
				),
			),
			windows.map((window, index) =>
				h(
					'div',
					{ className: 'tq-window-row', key: String(index) },
					h('input', {
						className: 'tq-input',
						type: 'time',
						value: window.start,
						'aria-label': t('settings.windowStart', { index: index + 1 }),
						onChange: (event) => setWindow(index, { start: event.target.value }),
					}),
					h('span', { className: 'tq-window-dash' }, '～'),
					h('input', {
						className: 'tq-input',
						type: 'time',
						value: window.end,
						'aria-label': t('settings.windowEnd', { index: index + 1 }),
						onChange: (event) => setWindow(index, { end: event.target.value }),
					}),
					h('span', { className: 'tq-window-desc' }, describeWindow(window, t)),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-icon-btn tq-btn-danger',
							title: t('settings.removeWindow', { index: index + 1 }),
							'aria-label': t('settings.removeWindow', { index: index + 1 }),
							onClick: () => removeWindow(index),
						},
						IconTrash(),
					),
				),
			),
			windows.length === 0 ? h('span', { className: 'tq-hint' }, t('settings.windowEmpty')) : null,
			h(
				'div',
				{ className: 'tq-row' },
				h('button', { type: 'button', className: 'tq-btn', onClick: addWindow }, IconPlus(), t('settings.addWindow')),
			),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-tz' }, t('settings.timeZone')),
				h('input', {
					id: 'tq-tz',
					className: 'tq-input',
					type: 'text',
					value: values.timeZone,
					placeholder: 'Asia/Shanghai',
					onChange: (event) => set({ timeZone: event.target.value }),
				}),
				h('span', { className: 'tq-hint' }, t('settings.timeZoneHint', { zone: browserZone() })),
			),
			h('span', { className: 'tq-hint' }, t('settings.windowPreview', { window: describeWindows(values, t) })),
		),

		h(
			'div',
			{ className: 'tq-settings-group' },
			h('div', { className: 'tq-label' }, t('settings.execGroup')),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.autoApprove,
					onChange: (event) => set({ autoApprove: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.autoApprove')),
					h('span', { className: 'tq-hint' }, t('settings.autoApproveHint')),
				),
			),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-target' }, t('settings.targetMode')),
				h(
					'select',
					{
						id: 'tq-target',
						className: 'tq-select',
						value: values.targetMode,
						onChange: (event) => set({ targetMode: event.target.value }),
					},
					h('option', { value: 'shared' }, t('settings.targetShared')),
					h('option', { value: 'fresh' }, t('settings.targetFresh')),
				),
				h('span', { className: 'tq-hint' }, t('settings.targetHint')),
			),
			h(
				'label',
				{ className: 'tq-toggle' },
				h('input', {
					type: 'checkbox',
					checked: values.compactBeforeTask,
					onChange: (event) => set({ compactBeforeTask: event.target.checked }),
				}),
				h(
					'span',
					{ className: 'tq-toggle-text' },
					h('span', null, t('settings.compact')),
					h('span', { className: 'tq-hint' }, t('settings.compactHint')),
				),
			),
			h(
				'div',
				{ className: 'tq-field' },
				h('label', { className: 'tq-label', htmlFor: 'tq-cooldown' }, t('settings.cooldown')),
				h('input', {
					id: 'tq-cooldown',
					className: 'tq-input',
					type: 'number',
					min: 0,
					max: 1440,
					step: 5,
					value: values.cooldownMinutes,
					onChange: (event) => set({ cooldownMinutes: numeric(event.target.value, 0) }),
				}),
				h('span', { className: 'tq-hint' }, t('settings.cooldownHint')),
			),
			h(
				'div',
				{ className: 'tq-grid-2' },
				h(
					'div',
					{ className: 'tq-field' },
					h('label', { className: 'tq-label', htmlFor: 'tq-timeout' }, t('settings.timeout')),
					h('input', {
						id: 'tq-timeout',
						className: 'tq-input',
						type: 'number',
						min: 1,
						max: 1440,
						value: values.taskTimeoutMinutes,
						onChange: (event) => set({ taskTimeoutMinutes: numeric(event.target.value, 360) }),
					}),
				),
			),
		),
	);
}

/** The archive face: what was filed away, and the one button that empties it. */
function ArchiveView({ t, sessionId, snapshot }) {
	const archived = snapshot.archived ?? [];
	const armed = useStore(uiStore, (state) => state.confirmClearArchive);
	const busy = useStore(uiStore, (state) => state.busy);

	return h(
		React.Fragment,
		null,
		archived.length === 0
			? h('div', { className: 'tq-empty' }, t('archive.empty'))
			: archived.map((task) => h(ArchivedCard, { key: task.id, t, sessionId, task })),
		h(
			'div',
			{ className: 'tq-row-end tq-row tq-bulk' },
			armed ? h('span', { className: 'tq-hint' }, t('archive.clearWarning')) : null,
			h(BulkAction, {
				t,
				label: t('archive.clear'),
				confirmLabel: t('archive.clearConfirm'),
				count: archived.length,
				armed,
				disabled: busy === 'global',
				onClick: async () => {
					if (!armed) {
						uiStore.set({ confirmClearArchive: true });
						return;
					}
					const ok = await mutate(sessionId, 'global', () => api.clearArchived(sessionId));
					uiStore.set({ confirmClearArchive: false });
					if (!ok) uiStore.set({ error: t('archive.clearFailed') });
				},
			}),
		),
	);
}

/** The browser's own zone, offered as a hint when the field is empty or wrong. */
function browserZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * The fields the form owns, as one patch.
 *
 * Only these are sent, so a setting the form does not render can never be
 * cleared by saving. They must also be exactly the fields the Host knows: a key
 * this side invents is dropped by the Host's sanitizer, and the save then reports
 * it as refused — which is how a removed setting left behind in this list turns
 * into a complaint on screen rather than a silent no-op.
 *
 * `test/client.test.mjs` checks this list against the Host's defaults.
 *
 * @param {object} values - the form's current values.
 * @returns {object} the patch.
 */
function settingsPatch(values) {
	return {
		enabled: values.enabled,
		windows: values.windows,
		timeZone: values.timeZone,
		autoApprove: values.autoApprove,
		targetMode: values.targetMode,
		taskTimeoutMinutes: values.taskTimeoutMinutes,
		cooldownMinutes: values.cooldownMinutes,
		compactBeforeTask: values.compactBeforeTask,
	};
}

/** The settings footer: the only place a settings change is committed. */
function SettingsFooter({ t, sessionId, values, dirty, refused, onDiscard }) {
	return h(
		'div',
		{ className: 'tq-page-foot' },
		dirty ? h('span', { className: 'tq-hint' }, t('settings.unsaved')) : null,
		refused.length > 0
			? h('span', { className: 'tq-hint tq-hint-warn' }, t('settings.refused', { fields: refused.join('、') }))
			: null,
		h(
			'button',
			{ type: 'button', className: 'tq-btn', disabled: !dirty, onClick: onDiscard },
			t('settings.discard'),
		),
		h(
			'button',
			{
				type: 'button',
				className: 'tq-btn tq-btn-primary',
				disabled: !dirty,
				onClick: async () => {
					const patch = settingsPatch(values);
					const ok = await mutate(sessionId, 'global', () => api.patchSettings(sessionId, patch));
					if (!ok) return;
					// The Host is the authority: it repairs what it cannot use. Diffing the
					// reply against what was sent is what turns "I clicked save and it went
					// back" into a sentence naming the field it refused — otherwise a
					// setting the running Host is too old to know about reverts in silence.
					const applied = uiStore.get().snapshot?.settings ?? {};
					const refusedFields = Object.keys(patch).filter(
						(key) => JSON.stringify(applied[key]) !== JSON.stringify(patch[key]),
					);
					uiStore.set({ settingsDraft: null, refusedFields });
				},
			},
			IconCheck(),
			t('settings.save'),
		),
	);
}

/**
 * The page root: header, the active face, and the settings footer.
 *
 * @param {object} props - `t` from the locale namespace, `sessionId` from the
 *   slot's inject.
 */
function TaskQueuePage({ t, sessionId }) {
	const view = useStore(uiStore, (state) => state.view);
	const stored = useStore(uiStore, (state) => state.snapshot);
	const storedSessionId = useStore(uiStore, (state) => state.snapshotSessionId);
	const error = useStore(uiStore, (state) => state.error);
	const settingsDraft = useStore(uiStore, (state) => state.settingsDraft);
	const refusedFields = useStore(uiStore, (state) => state.refusedFields);

	// The shell mounts one page per session and remounts it when the session
	// changes; this effect re-reads on that change and polls while the page is
	// actually on screen, which is the only time anyone is looking.
	useEffect(() => {
		void refresh(sessionId);
		const timer = window.setInterval(() => void refresh(sessionId), 5000);
		return () => window.clearInterval(timer);
	}, [sessionId]);

	// A snapshot from another session is not this session's queue.
	const snapshot = storedSessionId === sessionId ? stored : null;
	const workspace = snapshot?.workspace ?? null;
	const values = settingsDraft ?? snapshot?.settings ?? null;
	const dirty =
		settingsDraft !== null && snapshot !== null && JSON.stringify(values) !== JSON.stringify(snapshot.settings);

	/** Patch the settings draft, seeding it from the host on first edit. */
	const set = (patch) => {
		uiStore.set({ settingsDraft: { ...(settingsDraft ?? snapshot.settings), ...patch } });
	};

	const status = snapshot === null || workspace === null ? null : describeQueueStatus(t, snapshot);
	const archivedCount = snapshot?.archived?.length ?? 0;

	return h(
		'div',
		{ className: 'tq-page' },
		h(
			'div',
			{ className: 'tq-page-head' },
			h(
				'div',
				{ className: 'tq-page-title' },
				IconQueue(),
				t('page.title'),
				workspace === null ? null : h('span', { className: 'tq-workspace' }, workspace.title || workspace.path),
				status === null ? null : status.pill,
			),
			h('div', { className: 'tq-page-spacer' }),
			h(
				'div',
				{ className: 'tq-tabs' },
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'queue' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'queue',
						onClick: () => uiStore.set({ view: 'queue', editingId: null }),
					},
					t('page.tabQueue'),
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'archive' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'archive',
						onClick: () => uiStore.set({ view: 'archive', editingId: null, confirmClearArchive: false }),
					},
					t('page.tabArchive'),
					archivedCount > 0 ? h('span', { className: 'tq-tab-count' }, String(archivedCount)) : null,
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-tab' + (view === 'settings' ? ' tq-tab-active' : ''),
						'aria-pressed': view === 'settings',
						onClick: () => uiStore.set({ view: 'settings', editingId: null, refusedFields: [] }),
					},
					t('page.tabSettings'),
				),
			),
		),
		h(
			'div',
			{ className: 'tq-page-body' },
			h(
				'div',
				{ className: 'tq-page-inner' },
				error !== null ? h('div', { className: 'tq-note tq-note-error' }, error) : null,
				snapshot === null
					? h('div', { className: 'tq-empty' }, t('page.loading'))
					: workspace === null
						? h('div', { className: 'tq-note tq-note-error' }, t('page.noWorkspace'))
						: view === 'settings'
							? h(SettingsView, { t, snapshot, values, set })
							: view === 'archive'
								? h(ArchiveView, { t, sessionId, snapshot })
								: h(QueueView, { t, sessionId, snapshot }),
			),
		),
		view === 'settings' && snapshot !== null && values !== null
			? h(SettingsFooter, {
					t,
					sessionId,
					values,
					dirty,
					refused: refusedFields,
					onDiscard: () => uiStore.set({ settingsDraft: null, refusedFields: [] }),
				})
			: null,
	);
}
