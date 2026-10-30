# Adversarial design review

Three independent reviewers read the specification and implementation plan
without the parent conversation. Each reviewer could inspect the pinned Pi
source, but could not edit files or see the other reviews. The reviews examined
contracts, lifecycle and delivery/testing separately. This record covers design
review, not validation of a framework implementation.

The reviews identified the following gaps. The table records their current
disposition in the [specification][spec] and [implementation plan][plan]:

| Finding                                                             | Design resolution and required evidence                                                                                                                                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquisition could not receive an individual tool's abort signal.    | `SandboxAcquireOptions` includes caller cancellation and a waiting deadline independent of shared provisioning. Test distinct concurrent waiters and cancellation of all waiters. |
| Serialised writes did not protect a whole edit.                     | Broker-owned `files.updateText` includes read/transform/write in the same queue as SDK mutations. Test a direct SDK write racing with a consumer transformation.                  |
| Promise rejection did not prove remote termination.                 | Provider outcomes explicitly distinguish confirmed and unconfirmed process termination. All abort causes use bounded confirmation; unknown completion quarantines the backend.    |
| Failed opening could leak a partially created allocation.           | Providers clean partial resources before rejection or report a recovery identifier and lease/expiry mechanism. Test failure and abort after allocation.                           |
| Cold user-shell startup could execute after attempted cancellation. | `user_bash` returns operations immediately; acquisition occurs inside `exec` with Pi's operation signal. Test abort while opening is suspended, then complete opening.            |
| Shutdown promises exceeded Pi's handler ordering.                   | The barrier starts when the broker enters closing. Earlier consumer shutdown handlers remain possible; embedding hosts can explicitly close first. Test consumer-first ordering.  |
| Overlapping host and target roots made absolute paths ambiguous.    | Target path handling belongs at a complete public Pi operation hook. Host path handling outside that hook is upstream Pi work.                                                    |
| Search capabilities did not establish equivalent semantics.         | Providers document their matching rules and result order. Pi tool presentation and any missing search-operation hooks remain Pi responsibilities.                                 |
| Several shell dialects left user input ambiguous.                   | Configuration or a validated backend default selects the user-shell dialect. Display the choice and test missing/invalid defaults.                                                |
| Bounded-memory wording exceeded the complete-file API.              | Limit the guarantee to process-output capture. Document that complete-file reads buffer the file.                                                                                 |

The second review pass also found two gaps:

- A non-responsive provider cannot return recovery metadata after timeout.
  Providers now report it before allocation and include it on the backend, so
  the broker can report recovery steps even when disposal never returns.
- The initial search profile claimed Pi compatibility while changing directory
  exclusions and result selection at the limit. The framework no longer defines
  a Pi-compatibility profile or replacement search tools.

The reviewers rechecked the design at the conclusion of those review rounds. The
later scope decision keeps Pi tool algorithms in Pi; that scope revision was not
part of the independent reviews.

The reviewers found the overall cooperative architecture feasible through Pi's
public APIs. They verified synchronous callback discovery, failed-factory
subscription cleanup, factory-scoped state and stale-context checks against Pi
1.4.0. Those findings do not establish provider isolation or implementation
correctness; the planned integration and real-provider tests remain necessary.

[spec]: specification.md
[plan]: implementation-plan.md

## Subsequent change: default host execution

The user clarified that SDK adoption must not require sandbox setup. The design
now includes built-in `passthrough`, with on-demand shared service creation when
no broker extension is loaded. Provider selection is a separate user choice.
Installing an unselected provider does not change execution, and failures of an
explicitly selected provider never switch to host execution. The spec and plan
include consumer-only and independent-SDK-copy tests for this behaviour.

The earlier review rounds covered the prior explicit-selection default. This
subsequent change was not part of those reviews.

## Structural contract review

The contracts reviewer subsequently examined the structural declarations and
[API/protocol appendix][api]. This review identified and resolved:

- A contradiction in exactly-at-limit truncation. The indicator is false when no
  additional result was omitted.
- A versioning conflict between closed capability literals and optional
  additions. Version 1 permits optional metadata fields; new capability literals
  require a service version change.
- Missing ownership rules for pending process requests. The broker snapshots
  arguments and environment overrides at facade entry, alongside write bytes and
  other request inputs.
- Removal of a closed service's discovery responder. The responder remains
  registered until Pi invalidates the runtime so acquisition cannot create a
  second broker during shutdown.
- Ambiguous symlink handling in `stat`. The operation follows links; directory
  entries describe links without following them. Dangling targets fail with
  `SandboxPathNotFoundError`.

The declarations and compile-time fixtures are available. Runtime validation,
independent-copy discovery and real-Pi service tests remain implementation
requirements.

[api]: api-protocol.md
