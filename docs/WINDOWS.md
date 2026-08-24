# Windows installation and release status

## Current status

CareerRat has a Windows x64 NSIS build and packaged smoke lane for pull
requests, pushes, and release tags. The pull request lane provides the first
real `windows-latest` proof: it installs the generated package, mounts the app,
exports a PDF, launches the bundled Playwright Chromium, and uninstalls it.

Windows code signing is planned and pending SignPath Foundation approval and
repository configuration. Until a Windows runner passes and Authenticode is
valid, this repository does not claim a release-ready Windows executable.
Unsigned Windows packages may be downloaded from a GitHub Actions run for QA,
but the release workflow cannot attach one to a public release. See the
[Code signing policy](CODE_SIGNING_POLICY.md).

## Installation and first run

Once a signed Windows asset is published, download
`CareerRat-<version>-win-x64-Setup.exe` and its SHA-256 file from the matching
[GitHub release](https://github.com/CodesWhat/careerrat/releases). Check the hash,
run the installer as the current user, and choose an install directory. The
installer creates Start menu and desktop shortcuts and does not need an
administrator account.

CareerRat's in-app agent work currently requires Claude Code 2.1.241 or newer,
installed and authenticated by the user. The app also detects Codex and the
expanded CLI registry, but shows those engines as unsupported and disables
selection because they do not yet provide an equivalent enforceable per-call
tool, path, and network boundary. They remain usable as outer workspace agents
through CareerRat's terminal flow. The packaged runtime does not ship the
proprietary Claude Agent SDK and does not copy the selected CLI's credentials.
If Claude Code is not installed and ready, chat and skills show a clear setup
error instead of silently switching to an embedded provider.

Candidate data, documents, and settings are stored below
`%APPDATA%\CareerRat`. Relevant context leaves the machine only when the
selected AI CLI sends it to its own provider or a user-requested feature
fetches a public resource. The optional unauthenticated GitHub release check can
be disabled in Settings. Read
[Privacy & Data Boundaries](https://careerrat.com/docs/advanced/privacy) before
using a provider or browser automation.

## Uninstall

Open **Settings > Apps > Installed apps**, choose **CareerRat**, and select
**Uninstall**. This removes the app and its shortcuts. User data is retained by
default so an uninstall or upgrade cannot destroy a job search. To remove it
permanently, close the app and delete `%APPDATA%\CareerRat` after uninstalling.

## Maintainer verification

Both pull request CI and the tag release call the same two package commands:

- `npm run dist:windows --workspace apps/desktop` builds the Windows x64 NSIS
  installer with electron-builder publication disabled.
- `npm run verify:windows --workspace apps/desktop` silently installs the exact
  installer, exercises app mount, PDF export, bundled Chromium, and uninstall,
  then exits nonzero on any failure.

Release CI additionally requires PowerShell `Get-AuthenticodeSignature` to
report `Valid` with a SignPath Foundation signer, runs the smoke again against
the signed result, generates a SHA-256 file, and only then uploads it to the
draft release. Signing requires external SignPath Foundation approval plus the
repository variables and secret described in [Release & Versioning
Policy](RELEASE.md).

## Microsoft Store readiness

Microsoft's current new-account flow at
[`storedeveloper.microsoft.com`](https://storedeveloper.microsoft.com/) has no
registration fee for Individual or Company accounts. A maintainer still has to
complete the external Microsoft identity or business-verification process and
accept the applicable agreements in Partner Center. No repository change can
perform that step.

An MSIX target is intentionally not enabled yet. Before it can be generated:

1. An approved Partner Center developer account must reserve CareerRat's exact
   product name.
2. Partner Center must issue that product's **Package/Identity/Name**,
   **Publisher**, and **PublisherDisplayName** values.
3. Those exact Publisher Identity values must be added to the MSIX builder
   configuration. They are not generated, guessed, or copied from the NSIS app
   id.
4. A Windows runner must build and validate the MSIX before Store submission.

Microsoft signs an accepted Store-delivered MSIX package as part of Store
ingestion. That free Store signing path does not make a direct-download NSIS
installer signed, and an MSIX distributed outside the Store still needs a
certificate trusted on the target machine. Official prerequisites are in
[Open a developer account](https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account),
[Create your app by reserving a name](https://learn.microsoft.com/windows/apps/publish/publish-your-app/create-your-app-by-reserving-a-name),
and [Prepare your app package](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/prepare-package-upload).
