#!/usr/bin/env node
/**
 * Build `client.js` from the numbered sources in `src/`.
 *
 * The browser bundle format the DSH client module system consumes is a single
 * self-contained script that registers one lazy factory:
 *
 *     window.__ModuleLoader__.load({ id, factory(require) { ... } })
 *
 * Relative `require()` calls inside a factory are NOT resolved — only the nine
 * platform seed words, already-materialized modules, and compiler-generated
 * async chunks are. So the sources are concatenated into one factory body
 * instead of bundled, and every source file shares that single function scope.
 * That is why the files are numbered: `function` declarations hoist, but `const`
 * initialisers run in filename order.
 *
 * The only module this plugin takes from the seed table is `react`. The DSH
 * client packages are deliberately not imported: a plain-JS plugin has no type
 * check against them, they change without notice, and a throwing component
 * blanks the slot entry it was registered into.
 *
 * Usage: node build.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

const files = readdirSync(srcDir)
	.filter((name) => name.endsWith('.js'))
	.sort();

if (files.length === 0) throw new Error('build: no sources in src/');

const banner = `/**
 * ${pkg.name} — browser half.
 *
 * GENERATED FILE — do not edit. Edit src/*.js and run \`node build.mjs\`.
 * Sources are concatenated in filename order into one factory body; see
 * build.mjs for why they cannot be separate modules.
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

\t\tconst React = require("react");
\t\tconst { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React;
\t\tconst h = React.createElement;

`;

const chapters = files.map((name) => {
	const body = readFileSync(join(srcDir, name), 'utf8');
	return `\t\t//#region src/${name}\n${body.replace(/\n$/, '')}\n\t\t//#endregion\n`;
});

const footer = `
\t\texports.inject = inject;
\t\texports.apply = apply;
\t\treturn module.exports;
\t},
});
`;

// A whole stylesheet is held in a template literal, so a single backtick in a
// CSS comment closes it early and the build fails with a syntax error pointing
// at the wrong place. Check the literal bodies directly and say what is wrong.
for (const name of files) {
	const body = readFileSync(join(srcDir, name), 'utf8');
	for (const match of body.matchAll(/=\s*`([\s\S]*?)`;/g)) {
		if (match[1].includes('`')) {
			throw new Error(
				`build: ${name} has a backtick inside a template literal. ` +
					'In a stylesheet that means a backtick in a CSS comment — remove it.',
			);
		}
	}
}

// Guard the one invariant the runtime cannot check for us: the bundle may only
// require seed words. A relative or third-party specifier would throw at
// materialization time, inside the browser, where the failure is a blank panel.
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);
const out = banner + chapters.join('\n') + footer;
for (const match of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
	if (!allowed.has(match[2])) {
		throw new Error(`build: client.js may not require("${match[2]}") — only react ships in the client seed table`);
	}
}

writeFileSync(join(here, 'client.js'), out);
process.stdout.write(`built client.js from ${files.length} sources (${out.length} bytes)\n`);
