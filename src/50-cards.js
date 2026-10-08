/**
 * The task card and the composer that adds one.
 *
 * One task is one card, and the card is the whole lifecycle in one place: what
 * the task says, what the queue decided about it, what happened when it ran, and
 * the buttons that make the next thing happen. Finished tasks stay in the list
 * rather than disappearing, because the morning question is "what did it do
 * overnight?" and a list that empties itself cannot answer it.
 *
 * The one action that is not an icon is **执行**. Running a task by hand is the
 * thing a user reaches for when a task is sitting there and they want it now —
 * and an icon-only control in a row of five other icons is a control they have to
 * learn. It is a labelled button, on every card that can still run.
 *
 * Every card belongs to a workspace, and the page only ever renders one
 * workspace's cards, so the mutations need nothing but the session the page was
 * opened from.
 */

/** The badge for one status. */
function StatusBadge({ t, status }) {
	return h('span', { className: 'tq-badge tq-badge-' + status }, t('status.' + status));
}

/**
 * The composer: an instruction and a button.
 *
 * There is no title to write. A card headings itself from the instruction's first
 * line, so a title field only ever asked the user to name what they had already
 * written — and then to keep the two in step.
 */
function TaskComposer({ t, sessionId }) {
	const draft = useStore(uiStore, (state) => state.draft);
	const busy = useStore(uiStore, (state) => state.busy);
	const submitting = busy === 'global';
	const canSubmit = draft.prompt.trim().length > 0 && !submitting;

	/** Patch the persisted draft, so switching faces does not lose typing. */
	const editDraft = (patch) => {
		uiStore.set((state) => ({ draft: { ...state.draft, ...patch } }));
	};

	/** Add the draft to the queue and clear the form. */
	const submit = async () => {
		if (!canSubmit) return;
		const ok = await mutate(sessionId, 'global', () => api.createTask(sessionId, { prompt: draft.prompt.trim() }));
		if (ok) uiStore.set({ draft: { prompt: '' } });
	};

	return h(
		'div',
		{ className: 'tq-settings-group' },
		h(
			'div',
			{ className: 'tq-field' },
			h('label', { className: 'tq-label', htmlFor: 'tq-new-prompt' }, t('compose.prompt')),
			h('textarea', {
				id: 'tq-new-prompt',
				className: 'tq-textarea tq-textarea-new',
				value: draft.prompt,
				placeholder: t('compose.promptPlaceholder'),
				onChange: (event) => editDraft({ prompt: event.target.value }),
				onKeyDown: (event) => {
					// Ctrl/Cmd+Enter submits; a bare Enter must stay a newline,
					// because a task instruction is usually several lines.
					if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void submit();
					}
				},
			}),
		),
		h(
			'div',
			{ className: 'tq-row-end tq-row' },
			h('span', { className: 'tq-hint' }, t('compose.hint')),
			h(
				'button',
				{ type: 'button', className: 'tq-btn tq-btn-primary', disabled: !canSubmit, onClick: () => void submit() },
				IconPlus(),
				t('compose.add'),
			),
		),
	);
}

/**
 * A bulk action that acts on every finished task at once.
 *
 * The archive button is safe — archiving is reversible — so it is one click. The
 * clear button deletes, so it arms first and says what it will do; "one click" a
 * few pixels from the search field is not a good enough reason to lose history.
 */
function BulkAction({ t, label, confirmLabel, count, armed, disabled, onClick }) {
	return h(
		'button',
		{
			type: 'button',
			className: 'tq-btn' + (armed ? ' tq-btn-danger tq-btn-armed' : ''),
			disabled: disabled || count === 0,
			onClick,
		},
		// The label and the count are separate children so the label stays an exact
		// string — findable by assistive technology and by anything else that looks
		// for the action by name.
		...(armed ? [confirmLabel] : [label, h('span', { className: 'tq-bulk-count' }, String(count))]),
	);
}

/**
 * One archived task, as a card.
 *
 * Archive is a filing decision, so the card is deliberately inert: no running,
 * no reordering, no editing. The result is what you came here to read, and the
 * one action is the way back out of the archive.
 */
function ArchivedCard({ t, sessionId, task }) {
	const busy = useStore(uiStore, (state) => state.busy === task.id);
	const parts = splitPrompt(task.prompt);
	return h(
		'div',
		{ className: 'tq-card tq-card-' + task.status },
		h(
			'div',
			{ className: 'tq-card-head' },
			h('div', { className: 'tq-card-title' }, excerpt(parts.heading, 160)),
			h(StatusBadge, { t, status: task.status }),
		),
		parts.rest.length > 0 ? h('div', { className: 'tq-card-body' }, excerpt(parts.rest, 320)) : null,
		task.error ? h('div', { className: 'tq-result tq-result-error' }, task.error) : null,
		!task.error && task.result ? h('div', { className: 'tq-result' }, task.result) : null,
		h(
			'div',
			{ className: 'tq-card-foot' },
			h('span', null, stamp(task.createdAt)),
			task.finishedAt ? h('span', null, t('card.finishedAt', { time: stamp(task.finishedAt) })) : null,
			task.sessionId ? h('span', { title: task.sessionId }, t('card.session', { id: shortId(task.sessionId) })) : null,
			h(
				'div',
				{ className: 'tq-row' },
				h(
					'button',
					{
						type: 'button',
						className: 'tq-btn',
						title: t('archive.restoreHint'),
						disabled: busy,
						onClick: () => void mutate(sessionId, task.id, () => api.unarchiveTask(sessionId, task.id)),
					},
					IconRetry(),
					t('archive.restore'),
				),
				h(
					'button',
					{
						type: 'button',
						className: 'tq-icon-btn tq-btn-danger',
						title: t('card.delete'),
						'aria-label': t('card.delete'),
						disabled: busy,
						onClick: () => void mutate(sessionId, task.id, () => api.deleteTask(sessionId, task.id)),
					},
					IconTrash(),
				),
			),
		),
	);
}

/**
 * One task, as a card.
 *
 * `isFirst` and `isLast` only disable the move buttons; the host owns the real
 * order, and the page never guesses it.
 */
function TaskCard({ t, sessionId, task, order, ordinal, isFirst, isLast }) {
	const editing = useStore(uiStore, (state) => state.editingId === task.id);
	const busy = useStore(uiStore, (state) => state.busy === task.id);
	const [promptDraft, setPromptDraft] = useState(task.prompt);

	// Re-seed the draft whenever the card opens for editing, so a cancelled or
	// externally-changed task never reappears with stale text.
	useEffect(() => {
		if (editing) setPromptDraft(task.prompt);
	}, [editing, task.prompt]);

	const parts = splitPrompt(task.prompt);

	const runnable = task.status !== 'running';
	const movers = task.status === 'queued';

	/** Move this card one slot up or down by swapping order with its neighbour. */
	const move = async (direction, ids) => {
		const index = ids.indexOf(task.id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= ids.length) return;
		const next = ids.slice();
		next[index] = next[target];
		next[target] = task.id;
		await mutate(sessionId, null, () => api.reorderTasks(sessionId, next));
	};

	const stopEditing = () => uiStore.set({ editingId: null });

	return h(
		'div',
		{ className: 'tq-card tq-card-' + task.status },
		editing
			? h(
					'div',
					{ className: 'tq-field' },
					h('textarea', {
						className: 'tq-textarea',
						value: promptDraft,
						'aria-label': t('card.editPrompt'),
						onChange: (event) => setPromptDraft(event.target.value),
					}),
				)
			: h(
					'div',
					{ className: 'tq-card-head' },
					// The ordinal is the task's place in the line, so the execution
					// order is readable without inferring it from vertical position.
					h('span', { className: 'tq-ordinal' }, '#' + ordinal),
					h('div', { className: 'tq-card-title' }, excerpt(parts.heading, 160)),
					h(StatusBadge, { t, status: task.status }),
				),

		editing
			? h(
					'div',
					{ className: 'tq-row tq-row-end' },
					h('button', { type: 'button', className: 'tq-btn', onClick: stopEditing }, t('card.cancelEdit')),
					h(
						'button',
						{
							type: 'button',
							className: 'tq-btn tq-btn-primary',
							disabled: promptDraft.trim().length === 0,
							onClick: async () => {
								const ok = await mutate(sessionId, task.id, () =>
									api.updateTask(sessionId, task.id, { prompt: promptDraft }),
								);
								if (ok) stopEditing();
							},
						},
						IconCheck(),
						t('card.save'),
					),
				)
			: parts.rest.length > 0
				? h('div', { className: 'tq-card-body' }, excerpt(parts.rest, 320))
				: null,

		!editing && task.error ? h('div', { className: 'tq-result tq-result-error' }, task.error) : null,
		!editing && !task.error && task.result ? h('div', { className: 'tq-result' }, task.result) : null,

		h(
			'div',
			{ className: 'tq-card-foot' },
			h('span', null, stamp(task.createdAt)),
			task.attempts > 0 ? h('span', null, t('card.attempts', { count: task.attempts })) : null,
			task.sessionId ? h('span', { title: task.sessionId }, t('card.session', { id: shortId(task.sessionId) })) : null,
			editing
				? null
				: h(
						'div',
						{ className: 'tq-row' },
						// The one labelled action: run it by hand, right now.
						runnable
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-btn tq-btn-run',
										title: t('card.runNowHint'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.runTask(sessionId, task.id)),
									},
									IconPlay(),
									t('card.runNow'),
								)
							: null,
						movers && !isFirst
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.moveUp'),
										'aria-label': t('card.moveUp'),
										disabled: busy,
										onClick: () => void move(-1, order),
									},
									IconUp(),
								)
							: null,
						movers && !isLast
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.moveDown'),
										'aria-label': t('card.moveDown'),
										disabled: busy,
										onClick: () => void move(1, order),
									},
									IconDown(),
								)
							: null,
						h(
							'button',
							{
								type: 'button',
								className: 'tq-icon-btn',
								title: t('card.edit'),
								'aria-label': t('card.edit'),
								disabled: busy || task.status === 'running',
								onClick: () => uiStore.set({ editingId: task.id }),
							},
							IconEdit(),
						),
						task.status === 'failed' || task.status === 'done' || task.status === 'cancelled'
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.retry'),
										'aria-label': t('card.retry'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.retryTask(sessionId, task.id)),
									},
									IconRetry(),
								)
							: null,
						task.status === 'queued'
							? h(
									'button',
									{
										type: 'button',
										className: 'tq-icon-btn',
										title: t('card.cancel'),
										'aria-label': t('card.cancel'),
										disabled: busy,
										onClick: () => void mutate(sessionId, task.id, () => api.cancelTask(sessionId, task.id)),
									},
									IconCancel(),
								)
							: null,
						h(
							'button',
							{
								type: 'button',
								className: 'tq-icon-btn tq-btn-danger',
								title: t('card.delete'),
								'aria-label': t('card.delete'),
								disabled: busy,
								onClick: () => void mutate(sessionId, task.id, () => api.deleteTask(sessionId, task.id)),
							},
							IconTrash(),
						),
					),
		),
	);
}
