/**
 * Where the browser e2e stack listens. The defaults avoid the dev servers' ports; the
 * variables let two stacks run on one machine (two worktrees' `check:push` at once — the
 * gate picks free ports itself). launch-stack.ts, playwright.config.ts and the specs that
 * call the API directly all read these, so a port lives in one place.
 */
export const API_PORT = Number(process.env.OPTIO_E2E_API_PORT) || 4931;
export const WEB_PORT = Number(process.env.OPTIO_E2E_WEB_PORT) || 3131;
export const API = `http://127.0.0.1:${API_PORT}`;
export const WEB = `http://127.0.0.1:${WEB_PORT}`;
