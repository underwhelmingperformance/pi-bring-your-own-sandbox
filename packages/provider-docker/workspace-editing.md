# Workspace editing with Docker

Pi's shell, file and search tools use the ordinary sandbox on the live checkout.
Set the configured policy in the provider's settings file. The project's trust
setting selects neither the workspace nor the policy. Consumers such as
permission reviewers can explicitly request a separate copy.

## Edit the live checkout

Pi's ordinary tools omit the access record. They can edit the checkout when the
configured policy permits live writes and Docker supports them. With a read-only
policy, Pi can still acquire the sandbox and read the checkout.

Docker mounts Git metadata and host configuration paths such as `.pi` read-only.
Install the provider and its dependencies outside the checkout so workload
changes cannot replace the running integration.

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

[review]: ../sdk/docs/specification.md#copies-and-review
