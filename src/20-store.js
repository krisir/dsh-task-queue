/**
 * Page state: one observable store.
 *
 * The queue itself is not stored here. It lives on the host, because that is
 * where the scheduler runs and where a restart must not lose it; the page keeps
 * a mirror it refreshes. Nothing in this module touches browser storage — the
 * page has no geometry of its own to remember, because the shell owns the layout
 * it is mounted into.
 *
 * The store also remembers **which session** its snapshot belongs to. The page
 * is mounted per session and a queue is per workspace, so a snapshot left over
 * from another session must never be rendered as if it were this one's.
 */

/** Create a minimal observable store. */
function createStore(initial) {
	let state = initial;
	const listeners = new Set();
	return {
		get: () => state,
		/**
		 * Merge a patch and notify every subscriber synchronously.
		 *
		 * Both call styles merge, and that is the whole point: when the callback
		 * form returned its object *as* the next state, a write that mentioned one
		 * field silently dropped every other one. That is not a subtle failure — a
		 * single keystroke in the composer reduced the store to `{ draft }`, which
		 * erased the loaded snapshot, and the page replaced itself with its loading
		 * state the moment the user started typing.
		 *
		 * @param {object | ((state: object) => object)} patch - fields to merge.
		 */
		set(patch) {
			const partial = typeof patch === 'function' ? patch(state) : patch;
			const next = { ...state, ...partial };
			let changed = false;
			for (const key of Object.keys(next)) {
				if (!Object.is(next[key], state[key])) {
					changed = true;
					break;
				}
			}
			if (!changed) return;
			state = next;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Subscribe a component to one store; `select` must return a stable value. */
function useStore(store, select = (value) => value) {
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.get()),
		() => select(store.get()),
	);
}

/** The page store. */
const uiStore = createStore({
	/** Which face of the page is showing. */
	view: 'queue',
	/** The last snapshot from the host, or null before the first read. */
	snapshot: null,
	/** The session that snapshot describes, so it is never shown for another. */
	snapshotSessionId: null,
	/** The last transport or host failure, or null. */
	error: null,
	/** The id of the task currently being mutated, so its buttons can disable. */
	busy: null,
	/** The composer's in-progress text, kept while the user switches faces. */
	draft: { title: '', prompt: '' },
	/** The id of the task being edited inline, or null. */
	editingId: null,
	/**
	 * The text of the inline edit in progress, or null when it is untouched.
	 *
	 * It lives here rather than in the card's own state for the same reason the
	 * composer's draft does: the page is remounted whenever the shell rebuilds the
	 * conversation view list, which a task starting a session is enough to cause.
	 * Local state would be thrown away by that remount while `editingId` survived
	 * it, so the editor would reopen holding the *old* text — looking exactly like
	 * the page had reset what the user was halfway through typing.
	 */
	editDraft: null,
	/** The settings form's uncommitted values, or null while it is untouched. */
	settingsDraft: null,
	/** Whether the archive-clear button is armed and waiting for a second click. */
	confirmClearArchive: false,
	/**
	 * Fields the Host normalized away on the last save, so the form can say what
	 * it refused instead of quietly reverting the control.
	 */
	refusedFields: [],
});

/**
 * Re-read the queue for one session from the host.
 *
 * Called after every mutation and on a slow poll while the page is mounted, so
 * the page shows the scheduler's decisions — a task being claimed at 18:00, a
 * run finishing at 02:00 — without the user having to reload.
 *
 * @param {string} sessionId - the session whose workspace to read.
 * @returns {Promise<void>} resolves when the read settles.
 */
async function refresh(sessionId) {
	try {
		const snapshot = await api.state(sessionId);
		uiStore.set({ snapshot, snapshotSessionId: sessionId, error: null });
	} catch (error) {
		uiStore.set({ error: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Run one mutating call and refresh from its response.
 *
 * Every mutation returns a full snapshot, so the page never shows a stale queue
 * after a click — and a failed call leaves the last good snapshot in place while
 * surfacing the reason.
 *
 * @param {string} sessionId - the session whose workspace is being changed.
 * @param {string | null} taskId - the task being mutated, for the busy marker.
 * @param {() => Promise<object>} operation - the call to make.
 * @returns {Promise<boolean>} whether it succeeded.
 */
async function mutate(sessionId, taskId, operation) {
	uiStore.set({ busy: taskId ?? 'global', error: null });
	try {
		const result = await operation();
		if (result && result.state) uiStore.set({ snapshot: result.state, snapshotSessionId: sessionId });
		uiStore.set({ busy: null });
		return true;
	} catch (error) {
		uiStore.set({ busy: null, error: error instanceof Error ? error.message : String(error) });
		return false;
	}
}
