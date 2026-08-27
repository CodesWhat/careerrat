export async function shutdownDesktopRuntime(active) {
  active.stopWatching();
  active.closeClients();
  await active.shutdownSourcingWorkers();
  await active.shutdownIntake();
  await active.shutdownAiWebSearch();
  await active.shutdownResumeExtractions();
  await active.shutdownAppOperations();
  await active.chatRuntime.shutdown();
  active.stopRuntimeSignIns();
  await active.browserSessionManager.shutdown();
  await new Promise((resolve) => active.server.close(resolve));
}
