# CareerRat roadmap

The short version. The working plan, with each item's acceptance line and the
record of what shipped when, is a local file that isn't published.

## Where things stand

CareerRat ships through npm and runs in the terminal. The
[latest release](https://github.com/CodesWhat/careerrat/releases/latest) has the
version and release notes.
v0.19.2 was the last Mac app release. CareerRat is the tool its author runs
for the people he is helping with a job search. The source stays public so
you can read how it works, and `npm install -g careerrat` works if you want
to run it yourself.

The theme: agnostic to the job. It should work for anyone.

## Next

- **Finish the TUI transition.** Retire the remaining legacy browser app and
  desktop distribution code. Preserve employer-site browser automation and the
  canonical local data, artifacts, job history and Undo.

## How to read this

Items show up here once they're decided and leave when they ship. The
CHANGELOG has the dates and the details.
