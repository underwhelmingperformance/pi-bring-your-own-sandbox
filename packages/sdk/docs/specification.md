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
requirement or failed backend produces an error. The broker reports failures at
the chosen destination and never retries a possibly completed operation.

[outer]: outer-runtime.md

## Configuration and negotiation

The user installs the provider in Pi and configures it in the provider's
settings file. The provider loads the Pi tool integration in its extension
factory and validates its own settings and the SDK's [shared settings
keys][settings] before allocation. The SDK reads no configuration files. Project
trust controls whether Pi loads project extensions. It selects neither the
workspace nor the policy. Settings take effect on reload.

[settings]: api-protocol.md#provider-settings

### Default configured policy

<!-- `allowEscalation` is provisional. -->

When the user supplies no policy, the SDK permits live checkout writes and reads
of host system files. It permits reads of host user data except [credential
locations][credentials]. This allows tools installed in the user's home
directory to run. The default denies network access and writes to host user
data. It enables `allowEscalation`. A session with no selected provider uses
unrestricted passthrough.

[credentials]: #credential-locations

A provider can narrow a default access setting only when it has no eligible
ordinary profile that can supply the default settings together. The broker ranks
the provider's ordinary profiles within the SDK default and uses the
highest-ranked policy. If no profile fits, configuration fails before
allocation. An explicit user policy supplies the limit directly. Pi's tools and
SDK consumers rely on the same default, and users can choose a stricter policy
without changing tool requests.

### Ordinary negotiation

Each provider lists separate profiles for `open` and `copy`. A profile combines
policy settings, capabilities, process kinds, shell dialects, exit status and
termination scope. The workspace descriptor records the relationship to the live
checkout. The only relationships at feature level 0 are `shared` for the live
checkout and `copied` for a private copy. A remote relationship can be added at
a later feature level.

In a shared workspace, the host sees sandbox writes when the operation
completes. Host writes become visible to the sandbox. File sharing can expose
stale or partial content for up to one second after a host-side replacement
completes. A read that starts after that window must see the complete
replacement. The [conformance check][workspace-visibility] exercises this with a
fresh target process.

[workspace-visibility]: provider-testing.md#workspace-visibility

Ordinary acquisitions and copies use the configured policy as both the limit and
the default. Pi's shell, file and search tools omit the access record. They can
use a read-only checkout without needing write access for acquisition.

1. Keep profiles within the configured policy that satisfy every need,
   restriction, path grant and operation requirement. Fail before allocation if
   none remain.
2. Compare the remaining profiles in the fixed property order. At the first
   difference, the least restrictive setting wins for an omitted or needed
   property. A restriction already requires the denied setting.

<!-- The fixed property order is provisional. -->

The property order is `hostWorkspaceWrites`, `network`, `hostUserData`,
`hostSystemFiles`. The [API appendix][mapping] orders the values for each
property.

[mapping]: api-protocol.md#requirements-and-profiles

Negotiation selects a profile before allocation. The permission reviewer uses
this result to check whether a copy is available. After startup, the broker
checks the backend's workspace, policy, operations and execution metadata
against the chosen profile. A mismatch rejects the backend and starts disposal
before the broker returns a facade.

### Provider presets

A provider can ship a separate extension entry point with its own default
configured policy. The entry point registers the provider and supplies the
default through the ordinary shared settings. The Docker offline shell entry
point prevents access to the network and to host files outside the checkout. It
also registers only the shell tools.

### Access requirements

Each property of the `access` record maps to one policy setting. The `needed`
state requires access and the `prevented` state requires denial. Adding a
property must fail compilation until negotiation, the policy mapping and the
conformance cases handle it.

| Property              | Restriction and consumer                                                                                                                                  | Need and consumer                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostWorkspaceWrites` | Prevents all changes to the host checkout, including changes through aliases. The permission reviewer relies on this during investigations.               | Requires write access to the live checkout. Escalated `bash` uses it for commands that must edit the live checkout when the configured policy keeps it read-only. |
| `network`             | Prevents workload network access. The permission reviewer and Docker shell profile rely on it for offline commands.                                       | Requires network access. Escalated `bash` uses it for operations such as fetching a dependency.                                                                   |
| `hostUserData`        | Prevents reads and writes to host user data. The permission reviewer and Docker shell profile rely on it to exclude host credentials and unrelated files. | Requires read access to host user data. Escalated `bash` uses it for commands that must read user configuration outside the checkout.                             |
| `hostSystemFiles`     | Prevents reads and writes to host system files. The Docker shell profile relies on it to run against the container image's system files.                  | Requires read access to host system files. Escalated `bash` uses it for commands that require a toolchain or configuration installed on the host.                 |

Host system files are files installed and maintained for the host operating
system or its system-wide runtimes. Examples are OS binaries in `/bin` or
`/usr/bin`, machine configuration in `/etc` and macOS system files in `/System`.
Host user data includes user files outside the checkout, such as credentials,
other projects and user-installed tools. User data under a system-managed
directory stays user data. Classify mixed content as user data if the provider
cannot enforce distinct policies within it. The user gives the agent the entire
workspace tree. Every entry in that tree is workspace content, including a hard
link with another link outside the tree. Host file restrictions govern access to
host paths outside the workspace. A provider that exposes the live checkout
refuses sockets, FIFOs and device files in the checkout when it opens. A host
process can add entries after open, which falls outside this contract. Target
files, including a container image's operating system and dependencies, fall
outside both host classes.

The pi-permission-auto-review extension sets `hostWorkspaceWrites`, `network`
and `hostUserData` to `prevented` for investigation. It leaves `hostSystemFiles`
unspecified so native providers can read host OS and runtime files to start a
shell. The backend still must prevent reads and writes to host user data. The
copy can expose files from the source workspace. The provider decides whether
the copy accepts writes. Any changes stay in the copy.

### Protected workspace paths

The provider kit exports `defaultProtectedWorkspacePaths` for providers that
protect host configuration inside a live checkout. The list includes Git hooks
and configuration, shell startup files, and configuration for editors, Pi and
other host tools. Providers choose how to enforce the list and may add paths
that host tools discover at runtime.

Use `isProtectedWorkspacePath` to check workspace-relative paths. For a rename,
check both endpoints with parent matching enabled. A rename of a parent
directory can replace a protected path even if the parent itself has no entry in
the list. Use the same parent check for recursive removal. Providers must
account for filesystem aliases to protected paths.

On systems that block renaming mount points, providers can mount each ancestor
below the checkout root onto itself. An ancestor mount uses the checkout's
access mode, and the protected path stays read-only.

### Credential locations

For host user data outside the checkout, `read-only` permits reads except at
credential locations. `read-write` permits reads and writes with the same
exclusion. `denied` prevents access to all host user data. A profile that
permits reads or writes must enforce every applicable exclusion. Docker provides
`denied` because its backend does not mount the home directory.

Providers can import the list from `/provider`. Each exclusion applies to the
listed path and its descendants. The broker evaluates each resolved grant path.
The workspace contract still applies inside the checkout.

| Location                                      | Reason                                                               |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `~/.ssh`                                      | SSH private keys and connection configuration.                       |
| `~/.aws`                                      | AWS credential files and cached sessions.                            |
| `~/.gnupg`                                    | GnuPG private keys and trust data.                                   |
| `~/.netrc`                                    | Credentials for network services.                                    |
| `~/.git-credentials`                          | Credentials saved by Git.                                            |
| `~/.config/gh`                                | GitHub CLI authentication.                                           |
| `~/.docker/config.json`                       | Docker registry authentication settings.                             |
| `~/.kube`                                     | Kubernetes client credentials and contexts.                          |
| `~/.config/gcloud`                            | Google Cloud credentials and cached sessions.                        |
| `~/.azure`                                    | Azure CLI credentials and cached sessions.                           |
| `~/.pypirc`                                   | Authentication for Python package indexes.                           |
| `~/.password-store`                           | Password store entries.                                              |
| `~/Library/Keychains`                         | User keychains on macOS.                                             |
| `~/.local/share/keyrings`                     | Desktop keyring files on Linux.                                      |
| `~/Library/Application Support/Google/Chrome` | Chrome logins, cookies and sessions on macOS.                        |
| `~/Library/Application Support/Firefox`       | Firefox logins, cookies and sessions on macOS.                       |
| `~/Library/Safari`                            | Safari profile data on macOS.                                        |
| `~/Library/Cookies`                           | Browser cookies on macOS.                                            |
| `~/.mozilla`                                  | Mozilla profile data, including Firefox logins and cookies on Linux. |
| `~/.config/google-chrome`                     | Chrome logins, cookies and sessions on Linux.                        |
| `~/.config/chromium`                          | Chromium logins, cookies and sessions on Linux.                      |

The [Chromium profile guide][chromium-profiles] and [Firefox profile
guide][firefox-profiles] describe the standard locations on Linux and macOS.

[chromium-profiles]:
  https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
[firefox-profiles]:
  https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data

### Path grants

The `paths` part of the access record lists paths that the consumer needs to
read or write. For host paths, resolve `~` against the host user's home and
relative paths against Pi's workspace before evaluating policy. Read and write
requirements are separate. Before allocation, the broker classifies each
resolved host path and checks it against the configured policy and eligible
profiles. After opening, the backend reports the target location of each path.
The broker returns a typed error for a missing or unreachable grant and disposes
of the backend. An ordinary grant confirms existing access. It leaves the policy
unchanged. A copy may require paths reachable in the copy. Copy writes stay in
the copy.

Escalation can add access to requested paths beyond the configured policy. A
profile declares whether the provider can grant extra read paths or extra write
paths. The provider enforces the grant and reports where the path appears in the
target. The caller uses that location to reach the granted file. For example, a
command can read one host configuration file without access to the rest of the
user's home directory.

A grant to a credential location outside the checkout requires an escalation
that lists the path, and a decision for that call. An escalation of the
`hostUserData` property alone keeps the provider's credential exclusion. If no
provider profile can satisfy the request, the confirmation describes the
unrestricted host destination. An approval for that destination permits
execution with no effective restrictions.

## Execution and capabilities

<!-- `violations` is provisional in milestone 1. -->

| Capability    | Consumer and purpose                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `exec`        | Pi's `bash` and `user_bash` run shell commands. The example consumer runs argv commands. The permission reviewer runs `sh` for inspection. |
| `files.read`  | Pi's `read` and `edit` read target bytes. The permission reviewer reads evidence from its copy.                                            |
| `files.write` | Pi's `write` and `edit` change target files.                                                                                               |
| `files.list`  | Pi's `ls` inspects target entries.                                                                                                         |
| `search.find` | Pi's `find` locates files under a target root.                                                                                             |
| `search.grep` | Pi's `grep` gets matches and context in the target.                                                                                        |
| `copy`        | The permission reviewer gets an independent workspace for inspection.                                                                      |
| `violations`  | The Pi integration appends structured restriction violations to a tool result so the model can decide how to proceed.                      |

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

## Escalation

<!-- `escalate` is provisional. -->

A Bash or PowerShell call can request extra access through `escalate` and must
give a justification. The tool translates listed property names into needs and
puts the requested paths in the same access record. Calls that omit `escalate`
use ordinary negotiation. When `allowEscalation` is false, the request fails
with a typed reason before prompting or allocating.

The broker first seeks a provider profile that supplies the requested access
within the full-access limit. The profile must keep unlisted properties at the
ordinary configured policy and expose only the requested extra paths. Among
eligible profiles, the broker chooses the least extra access that satisfies the
request. If none can supply it, the broker selects the host before asking for a
decision. The host enforces no restrictions. This destination is an explicit
exception to preserving unlisted properties. A failure at a selected destination
does not trigger another attempt.

Paths inside the checkout keep the provider's workspace mapping. For an extra
path under the host home directory, the provider uses the same relative path
under the target home directory. An extra path outside both directories uses the
same absolute path in the target. Profiles declare supported extra grant kinds
in `pathGrantKinds`. The backend reports the actual mappings in `grantedPaths`.
If the provider reports an unreachable path or a different target path, the
broker returns a typed path error and disposes the backend.

The broker presents the command, justification, requested properties and paths,
chosen destination and effective restrictions before a decision. For the host,
the effective restrictions are `none`. A permission extension receives the same
broker-resolved request that the confirmation would show. The decision function
can allow or deny only this pending tool call. The broker checks the request
against the pending call in the live session. The integration asks the user only
if there is no recorded permission extension decision. The prompt identifies the
provider by its label. The call runs only after an allow decision. Denial,
dismissal, cancellation and expiry prevent dispatch. The user and permission
extension can rely on the reviewed command and destination remaining fixed
through execution. The added access applies only to that command.

Before a run with a BYOS shell, the system prompt describes the negotiated
policy for ordinary shell commands and explains whether escalation is available.
The shell result describes the effective policy and path grants for that call.
Providers can report structured violations for the tool result. The cleaning
function returns the display text type for model, provider and extension text.
User interfaces require that type and diagnostics omit raw settings.

The [API appendix][escalation-api] defines the tool arguments, pending request
and decision function.

[escalation-api]: api-protocol.md#escalation-and-review

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

The broker reports the target workspace after it verifies an open backend. For a
host destination, the broker already knows the workspace. Lookup and copy
negotiation leave the destination unopened.

## Broker discovery

SDK copies with different protocol majors fail discovery. The error identifies
both builds and their extensions. Copies with the same major use the lower
feature level. Senders reduce offers to that level. A demand that requires a
higher level fails with an error that identifies the extension to update.
Providers can therefore offer fewer operations to older peers, and consumers
never lose a requirement silently. The [wire format][wire] specifies the version
fields and identity envelopes.

[wire]: api-protocol.md#internal-protocol

<!-- Factory entry points and the build election are provisional. -->

During the Pi extension factory, consumers create a client with
`createSandboxClient(pi, import.meta.filename)`. Provider registration and the
Pi tool integration register their own builds. Embedding hosts can supply
defaults outside an extension factory and do not enter the election.

The broker starts after Pi binds actions for the loaded extensions. The build
with the highest feature level supplies the broker. Ties use the SDK package
version in SemVer order, then the build ID and extension source path in code
unit order. Creating a client after Pi binds actions fails with
`SandboxInitialisationError`. Calling `get` before Pi binds actions raises the
same error.

## Lifetime and recovery

Registration, diagnostics and negotiation perform no backend allocation. The
broker can share an ordinary backend within a generation for identical profiles
and workspace. Separate sessions and reloads get fresh generations. A resumed
transcript does not restore old resources. Consumers with cached facades receive
an error after the generation closes.

The generation stops accepting work when the broker observes shutdown. The
embedding host closes the session before disposing of the Pi runtime. The broker
rejects new work, cancels pending and active operations and disposes of
ordinary, copy and escalated backends within bounded cleanup budgets. The
embedding host relies on those budgets to finish shutdown when a transport
stalls. Each allocation has one owner and each close is idempotent. Providers
clean up partial allocations on failed startup and dispose of any allocation
that finishes after the request has expired. Cleanup timeouts mean cleanup is
unconfirmed. Providers record recovery instructions for resources that require
intervention. The host and reviewer rely on the close report to distinguish
confirmed disposal from outstanding work. The user relies on status to find the
affected allocation without revealing secrets. Provider leases or documented
recovery cover crashes that prevent orderly shutdown.

## Ledger

<!-- `/byos log` is provisional. -->

The broker records each escalation in a typed Pi session entry. The entry
includes the command, justification, requested properties and paths, outcome,
and the chosen destination and negotiated policy when available. It records who
decided the call. Attribute a refusal under `allowEscalation: false` to the
configuration. If a call is cancelled or expires before anyone decides, record
the outcome without a decider. When an escalation is allowed, the ledger entry
precedes execution. The confirmation, decision function input and ledger
describe the same destination and effective restrictions, including `none` on
the host.

For each review copy, the broker records the requesting extension and the
negotiated policy. A violation entry identifies the provider that reported it.
Users can inspect the current session with `/byos log` and filter by tool call
ID. Users rely on the ledger to see who approved added access. Permission
extensions can correlate the executed destination, review copy and violations
with the pending call that they reviewed.

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
matcher can check renames of parent directories. Providers resolve aliases
before applying the matcher.

Providers run the [conformance suite][testing] in CI. The suite generates cases
from both profile lists, checks actual workload effects and uses the same broker
as Pi consumers.

### Grep

The facade and Pi's grep use [ripgrep's search rules][ripgrep]. Search includes
hidden files and does not treat `node_modules` differently from other
directories. Directory searches honour ignore files. A command-line glob can
override an ignore rule. An explicit file path bypasses ignore rules and globs.
Search skips binary files and does not follow symlinks discovered during
traversal.

Providers should supply `rg` inside the target. The portable helper uses
descriptor-relative traversal on Linux. A target without `rg` or the
descriptor-relative helper reports `UnsupportedSandboxCapabilityError` before
searching.

[ripgrep]:
  https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering
