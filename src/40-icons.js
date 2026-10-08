/**
 * Inline SVG icons.
 *
 * The plugin ships its own glyphs rather than importing the app's icon set: a
 * third-party browser half must not `require` DSH client packages, because they
 * change without notice and a throwing import blanks the slot the plugin is
 * registered into. These are drawn on a 16px grid with `currentColor`, so they
 * inherit the theme wherever they are used.
 */

/**
 * Build one icon element.
 * @param {string} path - the SVG path data.
 * @param {number} [size] - pixel size.
 * @returns {object} a React element.
 */
function icon(path, size = 16) {
	return h(
		'svg',
		{
			width: size,
			height: size,
			viewBox: '0 0 16 16',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			strokeLinejoin: 'round',
			'aria-hidden': 'true',
			focusable: 'false',
		},
		h('path', { d: path }),
	);
}

/** The queue mark: a stack of rows. */
function IconQueue(props) {
	return h(
		'svg',
		{
			width: props?.size ?? 16,
			height: props?.size ?? 16,
			viewBox: '0 0 16 16',
			fill: 'none',
			stroke: 'currentColor',
			strokeWidth: 1.5,
			strokeLinecap: 'round',
			'aria-hidden': 'true',
			focusable: 'false',
		},
		h('path', { d: 'M2.5 4h11M2.5 8h11M2.5 12h7' }),
	);
}

/** Close. */
function IconClose() {
	return icon('M4 4l8 8M12 4l-8 8');
}

/** Settings: a slider row. */
function IconSettings() {
	return icon('M2.5 4.5h4M9.5 4.5h4M2.5 11.5h4M9.5 11.5h4M6.5 2.8v3.4M11 9.8v3.4');
}

/** Back to the queue. */
function IconBack() {
	return icon('M9.5 3.5L5 8l4.5 4.5');
}

/** Run now. */
function IconPlay() {
	return icon('M5 3.2l7 4.8-7 4.8z');
}

/** Retry. */
function IconRetry() {
	return icon('M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5h-3');
}

/** Cancel: a slash through a circle. */
function IconCancel() {
	return icon('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM4.4 4.4l7.2 7.2');
}

/** Delete. */
function IconTrash() {
	return icon('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2M6.8 7v3.4M9.2 7v3.4');
}

/** Move up in the queue. */
function IconUp() {
	return icon('M8 12.5V4M4.5 7.5L8 4l3.5 3.5');
}

/** Move down in the queue. */
function IconDown() {
	return icon('M8 3.5V12M4.5 8.5L8 12l3.5-3.5');
}

/** Edit. */
function IconEdit() {
	return icon('M11.2 2.9l1.9 1.9-7.6 7.6-2.4.5.5-2.4z');
}

/** Check. */
function IconCheck() {
	return icon('M3.5 8.5l3 3 6-6.5');
}

/** The resize grip. */
function IconGrip() {
	return icon('M13 6L6 13M13 10l-3 3', 14);
}

/** Plus. */
function IconPlus() {
	return icon('M8 3.5v9M3.5 8h9');
}
