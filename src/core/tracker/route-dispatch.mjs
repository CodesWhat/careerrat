export function dispatchHttpRoute(handler, req, res) {
  if (typeof handler !== "function") return false;
  const route = { handle: handler };
  route.handle(req, res);
  return true;
}
