# Workspace editing goals for the Docker provider

Pi fixes a failing test. The developer sees the change in their editor and saves
a correction. Pi's next read sees the correction, and its next test run uses it.
This is the intended default for trusted development with the Docker provider.
Today Docker edits a private copy. The [provider guide][docker] describes the
current implementation. The SDK lets callers require a workspace relationship
and isolation guarantees. The defaults below apply to this Docker example.

[docker]: README.md

## Shared checkout

Shared editing is proposed. Docker would select it automatically in eligible
trusted sessions. A caller that requires live editing can set
`workspaceRelationship: 'shared'` in its acquisition policy. The current Docker
provider rejects that request.

Use this when all three conditions apply.

- Pi and the developer are working in a trusted project and need to see each
  other's changes as they edit, build or run tests.
- The session delegates both `filesystemScope` and `networkAccess` to the
  provider (`provider-default`).
- Docker can meet the caller's requirements and keep host extension installation
  within the authority granted to the workload.

Shell commands, SDK file operations and searches should see the same checkout.
Once the sandbox authorises an edit, the change should be visible on the host
without an export command or a second prompt. The last successful save wins. The
developer should own files that Pi creates and be able to edit or delete them
with ordinary permissions. Opening a session should leave absent project files
and directories absent.

Use the [`HOST_CONFIGURATION_PROTECTION` preset][protection] to identify
existing host configuration paths to expose read-only. A hard link elsewhere may
still allow writes to the same file. Callers can require immutability through
aliases by requesting workspace protection. Docker should reject any guarantee
it cannot enforce.

Project trust alone does not authorise Pi to install host extensions. For
example, if `.pi` is absent, a workload could create an extension there that a
later trusted Pi session loads on the host. If the proposed design permits that,
use the private-copy fallback until the maintainer explicitly accepts that
authority or the provider can prevent it.

Docker should disable container networking during live editing. Checkout entries
can still refer to files or services on the host, so the live backend should
report `provider-default` for both filesystem scope and network access.

[protection]: ../../docs/workspace-protection.md

## Private workspace copy

Docker uses a copy by default today. A caller can also require one by setting
`workspaceRelationship: 'copied'` in its acquisition policy.

Use this when any of the following applies.

- Pi reports that the project is untrusted or cannot report project trust.
- A build or test needs to write files, and the caller wants those changes to
  stay out of the developer's checkout.
- The caller permits a copy and requires isolation that Docker can enforce only
  in a copy.

Edits stay in the copy until disposal. If Docker falls back to a copy in a
trusted development session, it should tell the developer before they start
editing that changes will stay in the copy. If the caller explicitly requires
sharing, return an error when sharing is unavailable.

## Read-only review snapshot

Use this when a reviewer needs a stable view of the inputs to a proposed
command. Call `openReviewSnapshot` once at the start of the review. Docker
supports both sources today.

- For a command that would run on the host, take a fresh snapshot of the host
  checkout.
- For a command that would run in an agent's sandbox, take a fresh snapshot of
  that sandbox's workspace so the reviewer sees any edits made there.

Use the same snapshot for all reads and commands in that review. A later review
gets its own snapshot. Requests to run outside the sandbox follow the [approval
policy][approval].

[approval]: ../../docs/approval-execution.md

## Keeping the work in scope

The editing workflow should work on a supported Docker installation without an
additional host service or privileged host setup. Choose the workspace from the
session policy. Add a setting only when users have a reason to choose between
the outcomes.

Keep the Docker example small enough for another provider author to follow.
Judge changes against the editing workflow and the requested SDK guarantees. Fix
review findings that show a regression or a broken guarantee. If a finding calls
for a new guarantee or gives the workload new authority, describe the
consequence for the developer and bring that decision to the maintainer. For
example, whether Pi may install an extension that runs on the host is a product
decision. Choosing how long to reuse a file worker belongs in code review.
