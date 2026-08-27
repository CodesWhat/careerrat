export async function shutdownDesktopRuntime(active) {
  active.stopWatching();
  active.closeClients();
  await active.shutdownSourcingWorkers();
  await active.shutdownIntake();
  await active.chatRuntime.shutdown();
  active.stopRuntimeSignIns();
  await active.browserSessionManager.shutdown();
  await new Promise((resolve) => active.server.close(resolve));
}
