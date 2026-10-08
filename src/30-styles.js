/**
 * The page's whole stylesheet, as one owned `<style>` element.
 *
 * Every colour comes from the theme tokens (`--dsw-alias-*`), so the page
 * follows the app's light and dark themes without a single literal colour.
 *
 * The page is mounted into `conversation.view`, whose container the shell sizes
 * as `display: flex; flex-direction: column; flex: 1 1 0; min-height: 0;
 * overflow: hidden`. That contract decides the two rules below: the root is a
 * flex column that fills that box, and the body — not the root — is what
 * scrolls, because the parent hides its own overflow and a scroller anywhere
 * else would be clipped rather than scroll.
 */

const STYLE_TAG_ID = 'dsh-task-queue/page.css';

const STYLES = `
.tq-page {
	display: flex;
	flex-direction: column;
	flex: 1 1 0;
	min-height: 0;
	height: 100%;
	background: var(--dsw-alias-bg-base, #141414);
	color: var(--dsw-alias-label-primary, #eee);
	font-family: var(--dsw-font-family, inherit);
	font-size: 13px;
	line-height: 1.5;
}

.tq-page-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 20px;
	border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	flex: 0 0 auto;
	flex-wrap: wrap;
}
.tq-page-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 14px;
	font-weight: 600;
	white-space: nowrap;
}
.tq-page-spacer { flex: 1 1 auto; }
.tq-workspace {
	max-width: 32ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	padding: 1px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	color: var(--dsw-alias-label-secondary, #aaa);
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
}

.tq-section-title {
	margin: 4px 0 0;
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-secondary, #aaa);
}

.tq-tabs {
	display: inline-flex;
	gap: 2px;
	padding: 2px;
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
	flex: 0 0 auto;
}
.tq-tab {
	padding: 4px 12px;
	border: none;
	border-radius: calc(var(--dsw-radius-md, 10px) - 3px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #aaa);
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.tq-tab:hover { color: var(--dsw-alias-label-primary, #eee); }
.tq-tab-active {
	background: var(--dsw-alias-bg-base, #141414);
	color: var(--dsw-alias-label-primary, #eee);
	font-weight: 600;
}
.tq-tab {
	display: inline-flex;
	align-items: center;
	gap: 5px;
}
.tq-tab-count {
	min-width: 16px;
	padding: 0 4px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 26%, transparent);
	font-size: 10px;
	font-weight: 700;
	justify-content: center;
}

.tq-page-body {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 16px 20px 28px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.tq-page-inner {
	width: 100%;
	max-width: var(--dsh-chat-content-width, 780px);
	margin: 0 auto;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.tq-pill {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 2px 9px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 500;
	white-space: nowrap;
	border: 1px solid transparent;
}
.tq-pill-open {
	color: var(--dsw-alias-state-success-primary, #4ade80);
	background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 14%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 34%, transparent);
}
.tq-pill-closed {
	color: var(--dsw-alias-label-secondary, #aaa);
	background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 12%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 26%, transparent);
}
.tq-pill-off {
	color: var(--dsw-alias-state-warn-primary, #fbbf24);
	background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 14%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fbbf24) 34%, transparent);
}
.tq-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: currentColor;
	flex: 0 0 auto;
}

.tq-icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: 1px solid transparent;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-secondary, #aaa);
	cursor: pointer;
	flex: 0 0 auto;
}
.tq-icon-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
	color: var(--dsw-alias-label-primary, #eee);
}
.tq-icon-btn:disabled { opacity: 0.4; cursor: default; }

.tq-note {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 9px 12px;
	border-radius: var(--dsw-radius-md, 10px);
	font-size: 12px;
	background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05));
	color: var(--dsw-alias-label-secondary, #aaa);
}
.tq-note-error {
	color: var(--dsw-alias-state-error-primary, #f87171);
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 12%, transparent);
}

.tq-field { display: flex; flex-direction: column; gap: 4px; }
.tq-label {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--dsw-alias-label-secondary, #aaa);
}
.tq-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); }

.tq-input,
.tq-textarea,
.tq-select {
	width: 100%;
	box-sizing: border-box;
	padding: 6px 9px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
	border-radius: var(--dsw-radius-sm, 6px);
	background: var(--dsw-alias-bg-layer-1, #1e1e1e);
	color: var(--dsw-alias-label-primary, #eee);
	font-family: inherit;
	font-size: 12px;
	resize: vertical;
}
.tq-input:focus,
.tq-textarea:focus,
.tq-select:focus {
	outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d8dff));
	outline-offset: -1px;
}
.tq-textarea { min-height: 68px; line-height: 1.55; }

.tq-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	padding: 5px 12px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	color: var(--dsw-alias-label-primary, #eee);
	font-family: inherit;
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.tq-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08)); }
.tq-btn:disabled { opacity: 0.45; cursor: default; }
.tq-btn-primary {
	background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d8dff));
	border-color: transparent;
	color: var(--dsw-alias-label-primary-foreground, #fff);
	font-weight: 600;
}
.tq-btn-primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d8dff)); }
.tq-btn-danger:hover { color: var(--dsw-alias-state-error-primary, #f87171); }
/* The one labelled card action: run this task by hand. */
.tq-btn-run {
	padding: 3px 10px;
	color: var(--dsw-alias-brand-primary, #4d8dff);
	border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 42%, transparent);
	font-weight: 600;
}
.tq-btn-run:hover {
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 16%, transparent);
}
.tq-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tq-row-end { justify-content: flex-end; }

.tq-card {
	border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04));
	padding: 10px 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}
.tq-card-running { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 55%, transparent); }
.tq-card-done { opacity: 0.72; }
.tq-card-failed { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 50%, transparent); }

.tq-card-head { display: flex; align-items: flex-start; gap: 8px; }

/* The task's place in the line, so execution order is readable at a glance
   rather than inferred from how far down the card sits. */
.tq-ordinal {
	flex: 0 0 auto;
	min-width: 2.2em;
	padding-top: 1px;
	font-variant-numeric: tabular-nums;
	font-size: 12px;
	font-weight: 600;
	color: var(--dsw-alias-label-tertiary, #888);
}
.tq-card-title {
	flex: 1 1 auto;
	font-weight: 600;
	font-size: 13px;
	word-break: break-word;
}
.tq-card-body {
	font-size: 12px;
	color: var(--dsw-alias-label-secondary, #aaa);
	word-break: break-word;
	white-space: pre-wrap;
}
.tq-card-foot {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-wrap: wrap;
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
}
.tq-card-foot .tq-row { margin-left: auto; }

.tq-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 1px 8px;
	border-radius: 999px;
	font-size: 11px;
	font-weight: 600;
	flex: 0 0 auto;
}
.tq-badge-queued { color: var(--dsw-alias-label-secondary, #aaa); background: color-mix(in srgb, var(--dsw-alias-label-secondary, #aaa) 16%, transparent); }
.tq-badge-running { color: var(--dsw-alias-brand-primary, #4d8dff); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d8dff) 18%, transparent); }
.tq-badge-done { color: var(--dsw-alias-state-success-primary, #4ade80); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #4ade80) 16%, transparent); }
.tq-badge-failed { color: var(--dsw-alias-state-error-primary, #f87171); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 16%, transparent); }
.tq-badge-cancelled { color: var(--dsw-alias-label-dimmed, #777); background: color-mix(in srgb, var(--dsw-alias-label-dimmed, #777) 16%, transparent); }

.tq-result {
	font-size: 12px;
	color: var(--dsw-alias-label-secondary, #aaa);
	background: var(--dsw-alias-bg-base, #141414);
	border-radius: var(--dsw-radius-sm, 6px);
	padding: 8px 10px;
	max-height: 160px;
	overflow-y: auto;
	white-space: pre-wrap;
	word-break: break-word;
}
.tq-result-error { color: var(--dsw-alias-state-error-primary, #f87171); }

.tq-note .tq-btn { flex: 0 0 auto; margin-left: auto; }

.tq-empty {
	text-align: center;
	padding: 34px 12px;
	color: var(--dsw-alias-label-tertiary, #888);
	font-size: 12px;
}

.tq-settings { display: flex; flex-direction: column; gap: 14px; }
.tq-settings-group {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 12px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03));
}
.tq-settings-group > .tq-label { font-size: 12px; color: var(--dsw-alias-label-primary, #eee); }
.tq-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tq-window-row {
	display: grid;
	grid-template-columns: 7.5em auto 7.5em 1fr auto;
	align-items: center;
	gap: 8px;
}
.tq-window-dash { color: var(--dsw-alias-label-tertiary, #888); text-align: center; }
.tq-window-desc {
	font-size: 11px;
	color: var(--dsw-alias-label-tertiary, #888);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.tq-toggle { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 12px; }
.tq-toggle input { margin: 2px 0 0; flex: 0 0 auto; }
.tq-toggle-text { display: flex; flex-direction: column; gap: 1px; }

/* Bulk actions are kept clear of whatever sits beside them: a destructive one
   should not be flush against a card's own controls. The queue face puts this
   row above its list, the archive face below — the shared margin is the gap,
   and each face supplies its own separation. */
.tq-bulk { margin-top: 4px; }

.tq-btn-armed {
	color: var(--dsw-alias-state-error-primary, #f87171);
	border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 55%, transparent);
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f87171) 12%, transparent);
	font-weight: 600;
}

.tq-hint-warn { color: var(--dsw-alias-state-warn-primary, #fbbf24); }

/* The settings footer sits outside the scroller, so the save button is never
   the thing that is off screen — which is exactly how a window setting ends up
   looking unsettable. */
.tq-page-foot {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	justify-content: flex-end;
	padding: 10px 20px;
	border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
	background: var(--dsw-alias-bg-base, #141414);
}
.tq-page-foot .tq-hint { margin-right: auto; }
`;

/**
 * Add the stylesheet, once.
 * @returns {() => void} a disposer that removes it.
 */
function installStyles() {
	if (typeof document === 'undefined') return () => {};
	if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')) return () => {};
	const tag = document.createElement('style');
	tag.dataset.plugin = 'dsh-plugin-task-queue';
	tag.dataset.pluginCss = STYLE_TAG_ID;
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	return () => tag.remove();
}
