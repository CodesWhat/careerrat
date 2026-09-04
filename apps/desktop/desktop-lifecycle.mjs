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
  // Quitting the app must not leave a detached in-app Claude installer
  // running underneath it: abort any active guided setup and wait (bounded)
  // for its process group to actually die before the server closes.
  await active.shutdownGuidedSetups();
  await active.browserSessionManager.shutdown();
  await new Promise((resolve) => active.server.close(resolve));
}
