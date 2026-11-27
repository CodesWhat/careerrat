# Windows: install from npm

CareerRat on Windows is the same npm package and terminal workspace as on every
other platform. There is no Windows installer. The desktop app ended at v0.19.2.

```sh
npm i -g careerrat
careerrat start
```

CareerRat owns its workflows and threads, so their state remains
provider-neutral on Windows. Claude Code 2.1.241 or newer and OpenAI Codex are
the supported engines for the complete CareerRat product. An engine becomes `Ready` only after local availability,
authentication, and the complete readiness check pass. A failed check produces a
clear error instead of a silent provider switch.

CareerRat looks for the `py -3` launcher, then `python`. The terminal workspace
has not been tested end to end on Windows yet, so tell us if it fails on your
machine.

Relevant context leaves the machine only when the selected AI CLI sends it to
its own provider or a user-requested feature fetches a public resource. Read
[Privacy & Data Boundaries](https://careerrat.com/docs/advanced/privacy) before
using a provider or browser automation.

CI runs the packed npm install and the Windows-only tests on `windows-latest`.
See [Release & Versioning Policy](RELEASE.md).
