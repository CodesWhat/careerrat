# CareerRat roadmap

The short version. The working plan, with each item's acceptance line and the
record of what shipped when, is a local file that isn't published.

## Where things stand

v0.18.2 is the current release (2026-09-05). The desktop app is the product;
the CLI underneath it is an implementation detail and isn't promoted.

The theme: agnostic to the job. It should work for anyone.

## Next

- Windows: run the Doctor check through the packaged CareerRat.exe in CI, not
  only under node on the runner.
- Pick up the upstream iCIMS location fix on the next career-ops pin roll and
  drop the local patch.

## How to read this

Items show up here once they're decided and leave when they ship. The
CHANGELOG has the dates and the details.
