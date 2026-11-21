# Workspace editing goals for the Docker provider

Pi fixes a failing test. The developer sees the change in their editor and saves
a correction. Pi's next read sees the correction, and its next test run uses it.
Docker selects this workflow for eligible trusted development sessions. The
[provider guide][docker] describes the runtime requirements. The SDK lets
callers require a workspace relationship and isolation guarantees. The defaults
below apply to this Docker example.

[docker]: README.md

## Shared checkout

A caller can require live editing by setting `workspaceRelationship: 'shared'`
in its acquisition policy. Docker checks the checkout and mounts before it
returns a shared backend.

Use this when all three conditions apply.

- Pi and the developer are working in a trusted project and need to see each
  other's changes as they edit, build or run tests.
- The session delegates both `filesystemScope` and `networkAccess` to the
  provider (`provider-default`).
- Docker can meet the caller's requirements and keep host extension installation
  within the authority granted to the workload.

Shell commands, file operations and searches use the same checkout. The sandbox
applies authorised edits directly, and the last successful save wins. Jobs run
with the developer's user and group IDs. Opening a session leaves absent project
files and directories absent.

Docker mounts existing paths from the [host configuration preset][protection]
read-only. Docker also checks the Git directory, common directory and hooks
directory inside the checkout. Git metadata outside the checkout remains on the
host. For example, Git commands in a linked worktree can fail if the gitdir is
outside the mount.

Pi extensions cooperate with the host. Docker guards direct project extension
registration under `.pi`. Ordinary source that a trusted extension imports
remains editable. An absent `.pi` directory cannot be mounted read-only without
creating a directory in the checkout, so Docker selects a private copy.

Container networking is disabled. Checkout entries can refer to files or
services on the host. For example, a hard link can refer to the same contents as
a file outside the checkout. The live backend reports `provider-default` for
filesystem scope and network access. It rejects requests for strict workspace
protection.

[protection]: ../../docs/workspace-protection.md

## Private workspace copy

A caller can require a copy by setting `workspaceRelationship: 'copied'` in its
acquisition policy.

Use this when any of the following applies.

- Pi reports that the project is untrusted or cannot report project trust.
- A build or test needs to write files, and the caller wants those changes to
  stay out of the developer's checkout.
- The caller permits a copy and requires isolation that Docker can enforce only
  in a copy.

Edits stay in the copy until disposal. If Docker falls back to a copy in a
trusted development session, the example tells the developer before they start
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
