#!/usr/bin/env node
/**
 * Install / uninstall / inspect this plugin in a DSH profile.
 *
 * DSH resolves a Loader row's package name from the profile directory, so a
 * plugin that lives outside npm is installed as two things:
 *
 *   1. a symlink under `<profile>/node_modules/<package name>`, which is what
 *      Node resolution (and therefore the host Loader and the browser bundle
 *      server) finds, and
 *   2. one `insert` row in the profile's `cordis.patch.yml`, between markers
 *      this script owns so it can remove exactly what it added.
 *
 * The profile's own `package.json` is never touched, so nothing here interacts
 * with pnpm, lockfiles, or the bundle list. `dsh plugin --profile <p> add
 * <path>` is the alternative route when you want the package to become a real
 * profile dependency.
 *
 * Usage:
 *   node install.mjs [install|uninstall|status] [--profile <name>]
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const action = args.find((arg) => !arg.startsWith('-')) ?? 'status';
const profileFlag = args.indexOf('--profile');
const profileName = profileFlag >= 0 ? args[profileFlag + 1] : process.env.DSH_PROFILE || 'web';

const home = process.env.DSH_HOME || join(process.env.HOME, '.dsh');
const profileDir = join(home, 'profiles', profileName);
const patchPath = join(profileDir, 'cordis.patch.yml');
const linkPath = join(profileDir, 'node_modules', ...pkg.name.split('/'));

const BEGIN = `# >>> ${pkg.name} (managed by install.mjs — do not edit between the markers)`;
const END = `# <<< ${pkg.name}`;

const block = `${BEGIN}
- insert:
    - id: task-queue
      name: '${pkg.name}'
${END}
`;

/** Fail with a readable message rather than a stack trace. */
function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

/** Whether the path exists *as* a symlink, dangling or not. */
function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Write the symlink, replacing anything already there. */
function link() {
	mkdirSync(dirname(linkPath), { recursive: true });
	if (existsSync(linkPath) || isSymlink(linkPath)) {
		if (!isSymlink(linkPath)) {
			fail(`refusing to replace ${linkPath}: it is a real directory, not a symlink`);
		}
		if (resolve(dirname(linkPath), readlinkSync(linkPath)) === pkgRoot) return 'already linked';
		unlinkSync(linkPath);
	}
	symlinkSync(pkgRoot, linkPath, 'dir');
	return 'linked';
}

/** Add the patch block exactly once. */
function patch() {
	const text = readFileSync(patchPath, 'utf8');
	if (text.includes(BEGIN)) return 'already patched';
	const separator = text.endsWith('\n') ? '' : '\n';
	writeFileSync(patchPath, `${text}${separator}${block}`);
	return 'patched';
}

/** Remove the patch block this script added. */
function unpatch() {
	const text = readFileSync(patchPath, 'utf8');
	if (!text.includes(BEGIN)) return 'not patched';
	const lines = text.split('\n');
	const start = lines.findIndex((line) => line.startsWith(BEGIN));
	const end = lines.findIndex((line) => line.startsWith(END));
	if (start < 0 || end < start) fail(`the markers in ${patchPath} are inconsistent; remove the block by hand`);
	const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
	writeFileSync(patchPath, kept.join('\n').replace(/\n{3,}$/, '\n'));
	return 'unpatched';
}

if (!existsSync(profileDir)) fail(`no profile directory at ${profileDir}`);

if (action === 'install') {
	if (!existsSync(join(pkgRoot, 'client.js'))) fail('client.js is missing — run `node build.mjs` first');
	process.stdout.write(`${link()}: ${linkPath}\n`);
	process.stdout.write(`${patch()}: ${patchPath}\n`);
	process.stdout.write(`\nInstalled into profile "${profileName}".\n`);
	process.stdout.write('The running dsh watches cordis.patch.yml and hot-loads the plugin; if it does not appear, reload the page.\n');
} else if (action === 'uninstall') {
	if (existsSync(linkPath) || isSymlink(linkPath)) {
		unlinkSync(linkPath);
		process.stdout.write(`unlinked: ${linkPath}\n`);
	} else {
		process.stdout.write(`not linked: ${linkPath}\n`);
	}
	process.stdout.write(`${unpatch()}: ${patchPath}\n`);
} else if (action === 'status') {
	process.stdout.write(`package:  ${pkg.name} @ ${pkgRoot}\n`);
	process.stdout.write(`profile:  ${profileName} (${profileDir})\n`);
	process.stdout.write(`symlink:  ${existsSync(linkPath) ? 'present' : 'absent'} — ${linkPath}\n`);
	const text = readFileSync(patchPath, 'utf8');
	process.stdout.write(`patch:    ${text.includes(BEGIN) ? 'present' : 'absent'} — ${patchPath}\n`);
	process.stdout.write(`bundle:   ${existsSync(join(pkgRoot, 'client.js')) ? 'built' : 'NOT BUILT'}\n`);
} else {
	fail(`unknown action "${action}"; expected install, uninstall or status`);
}
