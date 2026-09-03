// example-echo — a bundled plugin used only by tests and as the template for
// a new plugin (see plugins/h1b-sponsor once it lands). Its run() just hands
// back whichever reads its manifest declared, so the runner/context contract
// can be exercised without any real plugin logic in the way.
export default function run(ctx) {
  const { fetch: _fetch, ...reads } = ctx;
  return { reads };
}
