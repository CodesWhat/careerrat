# Security policy

## Supported versions

CareerRat ships security fixes for the latest release line only (the version
currently published to npm as `latest`). Older releases and prerelease
`rc` builds do not receive backported fixes; upgrade to the latest release to
get one.

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected security vulnerability.

Report it privately through GitHub Security Advisories:
<https://github.com/CodesWhat/careerrat/security/advisories/new>.

Include the affected version or commit, minimal reproduction steps, observed
and expected behavior, and your assessment of the impact. Redact credentials,
private data, and identifying environment details, including anything from a
candidate workspace.

You can expect:

- acknowledgement within 48 hours;
- a status update within 7 days; and
- a fix or mitigation as soon as feasible, depending on severity and release
  safety.

CareerRat coordinates disclosure with the reporter and credits reporters in
release notes unless they prefer to remain anonymous.

There is no bug bounty program.

## Security scope

The following are in scope:

- source code and configuration maintained in this repository; and
- the `careerrat` package as published to npm from this repository.

Out of scope unless this repository introduces or amplifies the reported
impact:

- data or files inside a user's local candidate workspace, since CareerRat is
  a local-first tool and that data never leaves the user's machine unless the
  user explicitly enables a browser or network capability; and
- third-party services, ATS platforms, and job boards CareerRat integrates
  with.

If the boundary is unclear, report the issue privately and let the
maintainers triage it.
