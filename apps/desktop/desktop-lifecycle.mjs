// Keyed per `active` runtime rather than module-level: repeated quit events
// (Cmd+Q held down, a second before-quit firing while the first is still
// awaiting teardown) must not re-enter and run this twice concurrently
// against the same runtime, but a WeakMap keyed on `active` still lets an
// unrelated runtime instance (a fresh one in a later test, or a genuine
// future relaunch) shut down independently rather than sharing one
// permanent, unresettable guard.
const shutdowns = new WeakMap();

export function shutdownDesktopRuntime(active) {
  const inFlight = shutdowns.get(active);
  if (inFlight) return inFlight;
  const promise = (async () => {
    active.stopWatching();
    active.closeClients();
    await active.shutdownSourcingWorkers();
    await active.shutdownIntake();
    await active.shutdownAiWebSearch();
    await active.shutdownResumeExtractions();
    await active.shutdownAppOperations();
    await active.chatRuntime.shutdown();
    active.stopRuntimeSignIns();
    // Quitting the app must not leave a detached in-app Claude installer
    // running underneath it: abort any active guided setup and wait
    // (bounded) for its process group to actually die before the server
    // closes.
    await active.shutdownGuidedSetups();
    await active.browserSessionManager.shutdown();
    // server.close waits for in-flight responses, and a renderer that
    // reconnected its event stream mid-teardown holds one open forever. Drop
    // the sockets so the close can settle.
    await new Promise((resolve) => {
      active.server.close(resolve);
      active.server.closeIdleConnections?.();
      active.server.closeAllConnections?.();
    });
  })();
  shutdowns.set(active, promise);
  return promise;
}
