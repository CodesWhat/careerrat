# Code signing policy

## Status

Windows code signing is planned and pending approval by SignPath Foundation.
CareerRat does not represent its Windows installer as signed until the release
workflow has received the signed artifact and Windows reports a valid
Authenticode signature from SignPath Foundation. Unsigned Windows builds are
retained only as clearly labeled GitHub Actions QA artifacts and are never
attached to a public GitHub release.

When that approval and configuration are complete, the project will use this
required attribution in release materials: **Free code signing provided by SignPath.io, certificate by SignPath Foundation.**

Code signing establishes the publisher and detects changes after signing. It
does not guarantee that software is safe or suitable for a particular use.

## Software and artifacts covered

This policy covers the open-source CareerRat desktop application in
[`CodesWhat/careerrat`](https://github.com/CodesWhat/careerrat), distributed
under the MIT license. The planned signed artifact is the Windows x64 NSIS
installer produced from an exact `vX.Y.Z` tag by the repository's GitHub-hosted
Windows runner. The artifact configuration may also sign the project-owned
`CareerRat.exe` inside that installer if SignPath requires it.

The desktop artifact includes open-source third-party dependencies under their
respective licenses. It excludes the proprietary Claude Agent SDK. It does not
re-sign the user's installed Claude, Codex, or another supported AI CLI, bundled
Chromium, Electron, or any other upstream binary as CareerRat-owned software.

## Roles and access

- **Authors and committers:** repository collaborators with write access listed
  by [GitHub](https://github.com/CodesWhat/careerrat/graphs/contributors) and the
  [CodesWhat organization](https://github.com/orgs/CodesWhat/people).
- **Reviewers:** protected-branch reviewers and the owners named in
  [`CODEOWNERS`](../.github/CODEOWNERS), when present.
- **Approvers:** CodesWhat organization owners authorized in the SignPath
  organization. An approver reviews each release signing request before it can
  complete.

Every person in these roles must use multi-factor authentication. SignPath
access is limited to the minimum role needed and removed when it is no longer
needed. A person must not approve a request whose source or build provenance
cannot be verified.

## Build and signing procedure

1. A signed `vX.Y.Z` Git tag selects the exact source revision. The desktop and
   root package versions must match the tag.
2. GitHub Actions checks out that tag without persisted Git credentials on a
   GitHub-hosted `windows-latest` runner, installs the reviewed root lock with
   `npm ci`, and builds the unsigned NSIS input with publishing disabled.
3. The same Windows verification command used on pull requests silently
   installs the package, mounts the app, exports a PDF, launches the bundled
   Playwright Chromium, and uninstalls it.
4. GitHub Actions uploads the unsigned input as a private workflow artifact.
   Once Foundation approval and repository configuration exist, the pinned
   SignPath action submits that artifact and waits for the approved result.
5. PowerShell `Get-AuthenticodeSignature` must report `Valid` and a signer whose
   subject contains `SignPath Foundation`. The signed installer is installed
   and smoke-tested again. Before its SHA-256 checksum and installer are each
   attached, the workflow revalidates that the exact prepared release id is
   still the unique draft for the tag. Existing assets are not overwritten.
6. The release workflow refuses to replace assets on an already published
   release. A draft is published only after the signed and notarized macOS DMG
   is present. Windows assets are omitted while Windows signing is pending or
   disabled.

Protected branches, required reviews, pinned actions, GitHub-hosted build
runners, exact lockfiles, artifact checksums, SBOM generation, and manual
approval of signing requests form the trusted build boundary. Signing service
credentials are GitHub Actions secrets and are not available to pull request
builds.

## Privacy

Signing requests contain the public source revision, build provenance, artifact
metadata, and the installer. They contain no candidate profile, job-search
workspace, browser session, AI-provider credential, signing credential, or
other user content. CI builds start from the public repository and synthetic
smoke-test data only.

The installed app keeps candidate data on the user's machine. It sends relevant
context only through the AI CLI the user selected, under that provider's terms;
fetches user-requested public resources such as job postings and logos; and can
make an unauthenticated daily GitHub release check that carries no candidate
data and can be disabled. CareerRat runs no product telemetry or CareerRat
account service. The complete disclosure is in
[Privacy & Data Boundaries](https://careerrat.com/docs/advanced/privacy).

## Installation, system changes, and removal

The NSIS installer runs as the current user (`asInvoker`), lets the user choose
the installation directory, and creates Start menu and desktop shortcuts. It
does not install a Windows service, scheduled task, kernel driver, browser
extension, or machine-wide AI CLI. The app stores its local workspace below
the user's Electron application-data directory.

Uninstall through **Settings > Apps > Installed apps > CareerRat > Uninstall**.
The uninstaller removes the application and shortcuts but retains user data by
default to prevent accidental loss. To erase that data too, close CareerRat and
delete `%APPDATA%\CareerRat` after uninstalling. Detailed Windows instructions
are in [Windows installation and release status](WINDOWS.md).

Security reports and signing concerns follow the repository's
[`SECURITY.md`](../.github/SECURITY.md).
