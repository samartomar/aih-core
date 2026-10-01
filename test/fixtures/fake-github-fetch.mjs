// Test-only `--import` preload: serves GitHub REST fixtures to a CLI subprocess.
// AIH_TEST_GITHUB_FIXTURE names a JSON file { routes, networkError? }; AIH_TEST_GITHUB_CALLS optionally
// names a file receiving one JSON line per request (pathname and authorization header).
import { appendFileSync, readFileSync } from 'node:fs';
import { respond } from './github-org.mjs';

const fixture = JSON.parse(readFileSync(process.env.AIH_TEST_GITHUB_FIXTURE, 'utf8'));
globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(String(url)).pathname;
  if (process.env.AIH_TEST_GITHUB_CALLS)
    appendFileSync(process.env.AIH_TEST_GITHUB_CALLS, JSON.stringify({ pathname, authorization: init.headers?.authorization }) + '\n');
  if (fixture.networkError) throw new TypeError('fetch failed');
  const current = JSON.parse(readFileSync(process.env.AIH_TEST_GITHUB_FIXTURE, 'utf8'));
  return respond(current.routes[pathname]);
};
