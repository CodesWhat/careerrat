// Route handlers are plain functions (sync or async) registered via
// addRoute — nothing upstream of this dispatcher awaits or catches them. A
// synchronous throw, or a rejected promise from an async handler, would
// otherwise escape as an uncaught exception / unhandled rejection and take
// the whole dev server down for every in-flight request, not just this one
// (see CRASH-evidence-constructor-logo*.log: demo-logos.mjs threw inside an
// async handler with no await before the throw, so the rejection was never
// observed). This boundary converts either failure mode into a 500 instead.
export function dispatchHttpRoute(handler, req, res) {
  if (typeof handler !== "function") return false;
  const route = { handle: handler };
  try {
    const result = route.handle(req, res);
    if (result && typeof result.then === "function") {
      result.catch((err) => handleRouteError(err, res));
    }
  } catch (err) {
    handleRouteError(err, res);
  }
  return true;
}

function handleRouteError(err, res) {
  console.error("[tracker:dev] route handler error:", err);
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  res.writeHead(500, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: "internal_error" }));
}
