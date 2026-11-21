# Product intent for workspace editing

Pi fixes a failing test. The developer sees the change in their editor and saves
a correction. Pi's next read sees the correction, and its next test run uses it.
This is the intended default when the Docker provider is active in a trusted Pi
development session. The [Docker provider guide][docker] describes the behaviour
available today.

[docker]: ../examples/docker/README.md

## Editing a checkout

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

[protection]: workspace-protection.md

## When to use a copy

Use a private copy when Pi reports an untrusted project or cannot report trust.
Explicit isolation requirements apply even in a trusted session. If Docker must
use a copy when live editing was the default, tell the developer before they
start editing that changes will stay in the copy. If the caller explicitly
requires live editing, return an error when sharing is unavailable.

Give each review a fresh, read-only snapshot of the proposed command's
workspace, including edits visible only in the agent's workspace. A reviewer's
reads and commands should use that same snapshot throughout the review. Requests
to run outside the sandbox follow the [approval policy][approval].

[approval]: approval-execution.md

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
