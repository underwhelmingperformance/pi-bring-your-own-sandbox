# Workspace editing with Docker

Pi's shell, file and search tools use the ordinary sandbox on the live checkout.
The configured policy can make that checkout read-only. The project's trust
setting selects neither the workspace nor the policy. Consumers such as
permission reviewers can explicitly request a separate copy.

## Edit the live checkout

Pi's tools set `hostWorkspaceWrites` to `preferred`. If live writes are allowed
by the configured policy and available in the selected profile, Pi can edit the
checkout. Otherwise the tools use a read-only checkout and acquisition succeeds.

The provider's protected-path settings cover files that host tools may later
interpret as configuration. The provider kit supplies defaults and a matcher.
Keep the provider and SDK installed outside the checkout so workload changes
cannot replace the running integration.

## Use a private copy

Request a copy explicitly. The broker resolves the source and the provider
imports its files into a separate volume. The source can be the host checkout or
a sandbox workspace. The provider decides whether the copy accepts local writes.
Changes to the copy stay in its volume.

## Investigate a pending call

A permission reviewer uses the [review route][review] to identify the
destination and negotiate a copy before allocating it. For example,
pi-permission-auto-review sets `hostWorkspaceWrites`, `network` and
`hostUserData` to `prevented`. The execution and read capabilities let the
reviewer collect evidence while the original workload remains pending. The
reviewer closes the copy and reports unconfirmed cleanup.

[review]: ../../docs/specification.md#copies-and-review
