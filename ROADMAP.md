# CareerRat roadmap

The short version. The working plan, with each item's acceptance line and the
record of what shipped when, is a local file that isn't published.

## Where things stand

v0.19.2 is the current release. It is the last Mac app release. From here
CareerRat is the tool its author runs for people he is helping with a job
search, installed from npm and used in the browser. The source stays public
so you can read how it works, and `npm install -g careerrat` still works if
you want to run it yourself.

The theme: agnostic to the job. It should work for anyone.

## Next

- **Browser-first workspace.** `careerrat start` opens the local browser
  workspace by default; Claude Code and Codex terminal sessions stay optional.
  Job conversations, recruiter messages and per-job history stay in the
  product. The Mac app stays supported until clean browser setup, existing-data
  compatibility and PDF parity are verified, then it is removed. Built, not
  yet released.
- **Operator mode.** The confirmation prompts built for an anonymous user
  come out: applications submit, knowledge writes apply, and checks run
  without asking, with every action recorded on the job's thread. The
  honesty rule stays: nothing is claimed that doesn't trace to a source.
- **One workspace per person.** Switch between the people being helped by
  name; nothing from one person's search can reach another's documents.
- **Per-job document folders.** Exports land in `Documents/careerrat` with one
  folder per application. Closed jobs archive their folder; reopening restores
  it. Earlier versions are kept. Built, not yet released.
- **Dependency security refresh.** Runtime dependency updates have landed on
  the development branch and ship with the next release.

## How to read this

Items show up here once they're decided and leave when they ship. The
CHANGELOG has the dates and the details.
