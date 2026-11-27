# Upgrade BYOS to 1.0

Replace the SDK in every extension in the Pi installation as one update. Install
matching builds of the Docker provider, MXC and the permission reviewer if you
use them. Restart Pi after the update so extensions load the same release in a
fresh process. Development builds also advertised protocol 1.0 and used
incompatible schemas. Protocol 1.0 identifies the frozen contract from this
release onwards.

Use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` at exactly
`1.5.0`. The SDK uses Pi's argument parser and validator to compare the reviewed
file operation with the operation Pi dispatches.

## Providers

- Register through `/provider` with `registerSandboxProvider`. Supply an
  available declaration with a `create()` factory and `Profile` arrays for open
  and copy, or an unavailable declaration with the platform reason. Each
  `Profile` contains its policy, capabilities, process kinds, shell dialects,
  exit status and termination scope.
- Import provider implementation helpers from `/provider-kit`. The kit includes
  `canonicalHostPath`, `isWithinHostRoots`, the shell carrier and the target
  file and search helpers. Supply an explicit carrier to `ShellTransportRunner`.
- Call `context.reportWarning(message)` to report provider warnings. The broker
  retains display-safe warnings in its status diagnostics.
- Use the `credentialExclusions` and `hostUserDataRoots` from the open or copy
  request. The broker resolves these paths for the current generation. Apply
  each exclusion to its descendants and aliases. For a profile that permits host
  user data reads, report the enforced `hostUserDataRoots` and the target
  location of the host home in `workspace.hostUserDataRoot`.
- Add `armOpenFailure(mode)` to a `/testing` fixture when the provider can
  inject a fault after allocation and before publication. Check independent
  inventory in `verifyDisposed` even if the suite passes neither a backend nor a
  recovery descriptor. The test runner reports partial coverage when the hook is
  absent.

## Permission reviewers

Call `createShellReviewClient` from `/review` in the Pi extension factory.
Resolve `ShellReviewSource` for the pending call and display `source.command`,
which includes Pi's effective prefix. `source.signal` is present during a
pending escalation. Pass that signal to the review model and permission prompt.
It aborts when the decision expires, the tool call ends or the broker revokes
the route. Submit escalation decisions through `source.recordDecision` while the
source is valid.
