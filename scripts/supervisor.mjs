// Pure decision helpers for the process supervisor in start-all.mjs.
// Kept separate (and free of side effects) so the exit semantics can be tested
// without spawning real processes.

/**
 * What the parent should do when a critical child process ends.
 *
 * Both children are critical and neither is supposed to end on its own: the web
 * server and the bot are meant to run for the lifetime of the container. So ANY
 * exit outside a shutdown is a failure — including exit code 0, which would
 * otherwise leave the parent alive and Railway believing the deploy is healthy
 * while the bot is silently dead and sales have stopped.
 *
 * Restarting is deliberately NOT our job: an in-process restart loop hides a
 * crash-looping deploy behind a "running" container. We exit non-zero and let
 * Railway's restart policy handle it, where it is visible.
 */
export function decideOnChildExit({ name, code, signal, shuttingDown }) {
  if (shuttingDown) {
    return { action: "ignore", reason: `${name} exited during shutdown` };
  }
  // Normalise to a non-zero code: 0 would signal success to the platform.
  const exitCode = typeof code === "number" && code !== 0 ? code : 1;
  const how = signal ? `signal ${signal}` : `code ${code}`;
  return {
    action: "exit",
    code: exitCode,
    reason: `${name} exited unexpectedly (${how})`,
  };
}

/** A spawn error (binary missing, EACCES…) is always fatal for the parent. */
export function decideOnChildError({ name, message, shuttingDown }) {
  if (shuttingDown) return { action: "ignore", reason: `${name} errored during shutdown` };
  return { action: "exit", code: 1, reason: `${name} failed to start: ${message}` };
}
