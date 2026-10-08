/**
 * dsh-task-queue — package entry.
 *
 * Cordis reads `name`, `inject`, `Config`, and `apply` off the module the
 * loader row resolves, so re-exporting them here is the whole host wiring.
 * The browser half is `client.js`, discovered from the `dsh.client` manifest in
 * package.json.
 */
export { name, inject, Config, apply } from './host/plugin.js';
