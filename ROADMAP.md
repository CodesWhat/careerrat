# CareerRat roadmap

The short version. The working plan, with each item's acceptance line and the
record of what shipped when, is a local file that isn't published.

## Where things stand

v0.21.0 is the current release, installed from npm and used in the browser.
v0.19.2 was the last Mac app release. CareerRat is the tool its author runs
for the people he is helping with a job search. The source stays public so
you can read how it works, and `npm install -g careerrat` works if you want
to run it yourself.

The theme: agnostic to the job. It should work for anyone.

## Next

- **Operator mode, the rest of it.** Capabilities are on by default.
  Knowledge writes apply directly, each with an Undo on the job's thread:
  evidence, onboarding answers, gap coaching drafts, strategy changes and
  LinkedIn suggestions. Company health and gap coaching run on their own when
  their trigger is met. A question CareerRat can't answer honestly flags that
  one job instead of stopping the run. Strategy changes backed by fewer than
  three data points still ask first, as does lowering a comp floor. Nothing is
  claimed that doesn't trace to a source. Built, ships in the next release.
- **One workspace per person.** `--for <name>` runs any command in that
  person's workspace, with their own documents folder, so nothing from one
  search reaches another. Built, ships in the next release.
- **Older workspaces migrate retired settings.** Known retired settings migrate
  on import; invalid settings still need repair. Built, ships in the next release.
- **The terminal does the work, the browser shows it.** The AI CLI with
  CareerRat's skills does the work, and the browser app becomes the place to
  review it: today's list, the pipeline, each job's thread and the Undo log.

## How to read this

Items show up here once they're decided and leave when they ship. The
CHANGELOG has the dates and the details.
