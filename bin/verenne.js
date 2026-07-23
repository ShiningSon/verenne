#!/usr/bin/env node

import { main } from '../src/cli.js';
import { createAbortError, isAbortError } from '../src/process.js';
import { APP_NAME } from '../src/utils.js';

const controller = new AbortController();
let requestedExitCode;
const handlers = new Map([
  ['SIGINT', () => cancel('SIGINT', 130)],
  ['SIGTERM', () => cancel('SIGTERM', 143)],
]);

function cancel(signalName, exitCode) {
  if (controller.signal.aborted) {
    process.exit(requestedExitCode ?? exitCode);
  }
  requestedExitCode = exitCode;
  process.exitCode = exitCode;
  controller.abort(createAbortError(`Cancelled by ${signalName}.`));
}

for (const [signalName, handler] of handlers) process.once(signalName, handler);

main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
  const debug = process.env.VERENNE_DEBUG === '1' || process.argv.includes('--debug');
  const message = debug ? (error?.stack || error?.message || String(error)) : (error?.message || String(error));
  process.stderr.write(`\n${APP_NAME}: ${message}\n`);
  process.exitCode = isAbortError(error) ? (requestedExitCode ?? 130) : 1;
}).finally(() => {
  for (const [signalName, handler] of handlers) process.off(signalName, handler);
});
