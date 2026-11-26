# Bring-your-own-sandbox specification

This specification describes the target SDK design. The [design
principles][principles] define the rules and terminology. The [API and protocol
appendix][api] defines the public types and the internal wire format. The
[conformance suite][testing] checks provider behaviour through the broker.

[principles]: principles.md
[api]: api-protocol.md
[testing]: provider-testing.md

## Execution boundary

BYOS routes cooperating Pi extensions through a shared broker. A provider
enforces isolation for workloads that it starts. Pi and its extensions still
share the permissions of the Pi process. Direct Node I/O, `pi.exec()` and
independent MCP servers are outside the broker's boundary. Use an [outer
sandbox][outer] to constrain Pi itself.

The embedding host supplies a live Pi context. Consumers get a facade tied to
their sandbox. It exposes the negotiated workspace and operations. Only the
embedding host can close the session. Providers and consumers can use
independent SDK installations.

The broker uses passthrough when the user selects no provider. A missing
selected provider, failed factory, invalid configuration, unsupported
requirement or failed backend produces an error. BYOS never switches
destinations after failure or retries a possibly completed operation.

[outer]: outer-runtime.md

## Configuration and negotiation

The user installs the provider in Pi and configures it in the provider's
settings file. The provider loads the Pi tool integration as part of its
extension factory. It composes the SDK's [shared settings keys][settings] with
its own keys and validates the file before allocation. The shared keys include
the configured policy, user shell, cleanup budgets and outside settings. The SDK
reads no configuration files. A provider may supply a default configured policy.
Project trust controls whether Pi loads project extensions. The trust setting
selects neither the workspace nor the policy. Settings take effect on reload.

[settings]: api-protocol.md#provider-settings

Each provider lists separate profiles for `open` and `copy`. A profile combines
policy settings, capabilities, process kinds, shell dialects, exit status and
termination scope. The workspace descriptor records the relationship to the live
checkout. The only relationships at feature level 0 are `shared` for the live
checkout and `copied` for a private copy. A remote relationship can be added at
a later feature level.

Acquisitions, copies, guard checks and outside destinations use the same
ranking. The ordinary sandbox and its copies use the ordinary configured policy.
Each allowed outside destination has its own configured policy.

1. Keep profiles within the destination's configured policy that satisfy every
   need, restriction and operation requirement. Fail before allocation if no
   profile remains.
2. Keep the profiles that grant as many preferences as possible. Count a
   preferred property once if the profile grants the access. Read-only and
   read-write each count once for a file access preference.
3. Compare the remaining profiles by the fixed property order. At the first
   property with different settings, the more restrictive setting wins for an
   omitted or needed property. The less restrictive setting wins for a preferred
   property. A restriction already requires the denied setting.

<!-- The fixed property order is provisional. -->

The property order is `hostWorkspaceWrites`, `network`, `hostUserData`,
`hostSystemFiles`. The [API appendix][mapping] orders the values for each
property.

[mapping]: api-protocol.md#requirements-and-profiles

Negotiation selects a profile before allocation. The guard and the reviewer use
the result to decide whether a route is available. After startup, the broker
checks the backend's workspace, policy, operations and execution metadata
against the chosen profile. A mismatch rejects the backend and starts disposal
before the broker returns a facade.

### Pi's tools and guard requirements

Pi's `bash`, `user_bash`, file and search tools use ordinary acquisition and
mark every access property `preferred`. The user can grant access through the
configured policy. A read-only policy gives Pi read-only tools without making
acquisition fail.

<!-- The guard's place under principle 16 is provisional and undecided. -->

The user installs the guard to require an explicitly activated provider. The
user can also require a provider ID, access or operation capabilities. The
broker applies the guard to each acquisition and copy request. Identical states
combine, and an omitted property takes the other request's state. A need or
restriction takes precedence over a preference. A guard restriction caps access
for all ordinary acquisitions and copies, including for Pi's tools. A guard need
requires the corresponding access within the configured policy. Opposite hard
states fail before allocation with an unsupported policy error that identifies
the property and both states. Outside calls use their own allowed destinations
and approval.

### Access requirements

A consumer specifies an `access` record. Each property maps to exactly one
policy setting. Use `needed` for access that the consumer requires and
`prevented` for access that the sandbox must deny. Use `preferred` for access
that helps the consumer when available. An omitted property gets the most
restrictive setting that the provider supports. Passthrough supports only full
access. An omitted property prevents nothing there, and a restriction fails
before allocation. One property cannot be both needed and prevented. Adding a
property must fail compilation until negotiation, the policy mapping and the
conformance cases handle that property. The [API appendix][mapping] defines the
mapping.

| Property              | Restriction and consumer                                                                                                                                  | Need and consumer                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hostWorkspaceWrites` | Prevents all changes to the host checkout, including changes through aliases. The permission reviewer relies on this during investigations.               | Requires write access to the live checkout. The outside tool uses it for commands that must edit the live checkout through an allowed destination when the configured policy keeps it read-only. |
| `network`             | Prevents workload network access. The permission reviewer and Docker shell profile rely on it for offline commands.                                       | Requires network access. The outside tool uses it for operations such as fetching a dependency.                                                                                                  |
| `hostUserData`        | Prevents reads and writes to host user data. The permission reviewer and Docker shell profile rely on it to exclude host credentials and unrelated files. | Requires read access to host user data. The outside tool uses it for commands that must read user configuration outside the checkout.                                                            |
| `hostSystemFiles`     | Prevents reads and writes to host system files. The Docker shell profile relies on it to run against the container image's system files.                  | Requires read access to host system files. The outside tool uses it for commands that require a toolchain or configuration installed on the host.                                                |

Host system files are files installed and maintained for the host operating
system or its system-wide runtimes. Examples are OS binaries in `/bin` or
`/usr/bin`, machine configuration in `/etc` and macOS system files in `/System`.
Host user data includes user files outside the checkout, such as credentials,
other projects and user-installed tools. User data under a system-managed
directory stays user data. Classify mixed content as user data if the provider
cannot enforce distinct policies within it. A path alias or mount does not
change the classification of the underlying files. The provider's own files,
including a container image's operating system and dependencies, are outside
both host classes. Exposed host files still belong to their original classes.

The pi-permission-auto-review extension sets `hostWorkspaceWrites`, `network`
and `hostUserData` to `prevented` for investigation. It leaves `hostSystemFiles`
unspecified so native providers can read host OS and runtime files to start a
shell. The backend still must prevent reads and writes to host user data. The
copy can expose files from the source workspace. The provider decides whether
the copy accepts writes. Any changes stay in the copy.

## Execution and capabilities

<!-- `violations` is provisional in milestone 1. -->

| Capability    | Consumer and purpose                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exec`        | Pi's `bash`, `user_bash` and the outside tool run shell commands. The example consumer runs argv commands. The permission reviewer runs `sh` for inspection. |
| `files.read`  | Pi's `read` and `edit` read target bytes. The permission reviewer reads evidence from its copy.                                                              |
| `files.write` | Pi's `write` and `edit` change target files.                                                                                                                 |
| `files.list`  | Pi's `ls` inspects target entries.                                                                                                                           |
| `search.find` | Pi's `find` locates files under a target root.                                                                                                               |
| `search.grep` | Pi's `grep` gets matches and context in the target.                                                                                                          |
| `copy`        | The permission reviewer gets an independent workspace for inspection.                                                                                        |
| `violations`  | The Pi integration appends structured restriction violations to a tool result so the model can decide how to proceed.                                        |

The facade checks capabilities before dispatch. Pi uses the same workspace for
shell, file and search operations. Paths, executable lookup and environment
overrides refer to the destination. Providers enforce access inside the backend,
including through symlinks.

The example consumer relies on literal argv boundaries. A transport shell must
use lossless encoding and never expand or interpret caller data. Bootstrap tools
and shell lookup must remain separate from caller environment overrides. For
example, a target `BASH_ENV` value or a substitute shell on the target `PATH`
must not affect bootstrap execution. The example consumer distinguishes a failed
launch from a command's exit status. Pi and the consumer rely on transport
diagnostics staying out of workload stdout and stderr. Passthrough inherits the
host environment. External providers receive neither the host's environment nor
Pi credentials implicitly. They use their own defaults for the target
environment.

Pi displays streamed output, including output before failure. Consumers receive
ordered chunks, with no chunks after completion. The broker drains output after
the capture limit and records omitted byte counts so consumers can tell when
captured output is incomplete. A throwing callback cancels the operation and
produces a typed output error.

Acquisition waiting, opening, execution and file or search operations have
separate default deadlines, listed in the [API appendix][process]. A cancelled
acquisition waiter stops waiting while shared provisioning continues under the
broker's opening deadline. Pi relies on the broker never starting the command
for a cancelled cold-start `user_bash` waiter. The bridge returns operations or
throws. Returning `undefined` on failure would let Pi run the command through
its own shell operations.

The permission reviewer requires a reported exit status to distinguish
successful probes from failed probes. Pi reports unavailable optional status
with the collected output as a failure. The reviewer also requires at least
process-group termination. That scope includes the direct process and its
supervised group. Workload termination also covers descendants that create new
groups or sessions. Pi uses the scope when reporting cancellation. With scope
`none`, cancellation returns `not-guaranteed` without waiting for confirmation
and leaves the backend usable. With a promised scope, cancellation waits within
the cleanup allowance for confirmation. Unconfirmed termination or an unknown
mutation outcome makes the backend unusable. The broker cancels before dispatch
when possible and never replays work. The example consumer can continue using
the backend after an ordinary non-zero exit.

[process]: api-protocol.md#process-files-and-search

The broker serialises file mutations on each sandbox. Pi's `edit` relies on a
single queued read, transform and write. A later queued edit sees the previous
write. A failed transform produces no write. This queue covers SDK file
mutations. Shell commands and independent processes can change files outside it.
Pi uses the SDK's file and search results, including truncation, to format tool
output consistently across providers.

## Destinations and permission

<!--
`bash_outside`, `outsideDestinations` and `outsideApproval` are provisional.
-->

`bash_outside` is a separate Pi tool with its own rule in permission extensions.
The model supplies an `access` record and a justification. The selected provider
may declare profiles for an outside destination.

The user's provider settings control whether outside execution is available and
who decides each call.

`outsideDestinations` sets the configured policy for the provider's outside
destination and can explicitly enable passthrough. The passthrough destination
has a full-access configured policy. It allows workspace writes and network
access, as well as reads and writes to host user data and host system files. The
broker applies the shared ranking to profiles within their destination's
configured policy. An outside command can exceed the ordinary configured policy
only at a destination that the user explicitly allows. An ordinary failure never
triggers an outside call.

The `outsideApproval` setting decides who approves the call. By default the
integration asks the user through Pi and identifies the provider by its label.
The confirmation shows the command, justification, destination and effective
restrictions. When a permission extension decides, the integration runs the call
once Pi dispatches it. Denial, dismissal, unavailable confirmation, cancellation
and expiry prevent dispatch. The user and permission extension can rely on the
same command and destination being reviewed and executed. Changing either
requires a new decision.

The Pi integration generates model-facing descriptions of the effective
restrictions from the negotiated policy for each destination. This applies to
the selected sandbox and any eligible outside destination. The cleaning function
returns the display text type. User interfaces accept that type for text from
the model, providers or other extensions. Errors identify the failed
requirement, its value and the relevant extension or provider, without exposing
configuration values.

## Copies and review

A copy starts from the source destination's files and has its own workspace and
lifetime. Changes to it do not propagate back. The permission reviewer uses this
independence to inspect the pending call's environment. A copy need not reflect
one atomic instant of the source. If its profile cannot satisfy the request, the
broker reports why before allocating it.

The review route records pending calls on `tool_execution_start` so a permission
gate can find the relevant call regardless of extension load order. It replies
with the identity of a review source tied to the pending call and destination,
or a typed reason for unavailability. The reviewer resolves the identity through
its own broker. The review source lets the reviewer check whether a suitable
copy is available without allocating one, and then request that copy. The
reviewer gets no access to the live sandbox. The broker rejects unsolicited or
mismatched identities. A reply's shape alone does not establish isolation.

## Broker discovery

SDK copies with different protocol majors fail discovery. The error identifies
both builds and their extensions. Copies with the same major use the lower
feature level. The broker reduces offers to that level and rejects demands that
require a higher level. Providers can therefore offer fewer operations to older
peers, and consumers never lose a requirement silently. The [wire format][wire]
specifies the version fields and identity envelopes.

[wire]: api-protocol.md#internal-protocol

<!-- The total order for tied builds is provisional in milestone 1. -->

The broker starts after all extensions load. For the shared protocol major, the
build with the highest feature level supplies the broker. If different builds
tie, a total order on build identity decides. Selection is independent of
extension load order.

## Lifetime and recovery

Registration, diagnostics and negotiation perform no backend allocation. The
broker can share an ordinary backend within a generation for identical profiles
and workspace. Separate sessions and reloads get fresh generations. A resumed
transcript does not restore old resources. Consumers with cached facades receive
an error after the generation closes.

The generation stops accepting work when the broker observes shutdown. The
embedding host closes the session before disposing of the Pi runtime. The broker
rejects new work, cancels pending and active operations and disposes of
ordinary, copy and outside backends within bounded cleanup budgets. The
embedding host relies on those budgets to finish shutdown when a transport
stalls. Each allocation has one owner and each close is idempotent. Providers
clean up partial allocations on failed startup and dispose of any allocation
that finishes after the request has expired. Cleanup timeouts mean cleanup is
unconfirmed. Providers record recovery instructions for resources that require
intervention. The host and reviewer rely on the close report to distinguish
confirmed disposal from outstanding work. The user relies on status to find the
affected allocation without revealing secrets. Provider leases or documented
recovery cover crashes that prevent orderly shutdown.

## Diagnostics

The user relies on `/byos status` to see the selected provider and selection
source, the broker build identity, the effective policy and outstanding
recovery. Status identifies passthrough as host execution without isolation and
allocates no backend. Provider warnings stay separate from workload output. The
broker bounds the retained warnings and counts discarded warnings so the user
can see when the diagnostic record is incomplete. The [API appendix][warnings]
specifies the bounds and record shape.

[warnings]: api-protocol.md#provider-contract

## Provider kit and conformance

Providers implement the isolation-specific start, stop, workspace and process
operations. The provider kit supplies shared argv encoding, process supervision
with a wrapper hook, in-sandbox file and search helpers, OS error mapping,
cleanup budgets, an extension wrapper that reports factory failures as
configuration errors, and copy-source resolution. Consumers depend on the same
operation semantics across providers.

Protection of particular paths belongs to provider configuration. The provider
kit supplies a default list and matcher for Git hooks and configuration, shell
startup files, `.envrc`, `.direnv`, `.vscode`, `.idea`, `.devcontainer`, `.aws`,
`.mcp.json` and `.pi`. Providers expose protection in their own settings. The
provider kit matcher covers aliases and renames of parent directories.

Providers run the [conformance suite][testing] in CI. The suite generates cases
from both profile lists, checks actual workload effects and uses the same broker
as Pi consumers.
