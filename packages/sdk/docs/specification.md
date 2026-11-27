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
of host system files. It permits host user data reads under the [default
toolchain roots][toolchain-roots] and any read roots in the provider's settings.
[Credential exclusions][credentials] take precedence. The default denies network
access and host user data writes. It enables `allowEscalation`. A session with
no selected provider uses unrestricted passthrough.

[credentials]: #credential-locations
[toolchain-roots]: #default-toolchain-roots

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

An extension can declare its provider unavailable on an unsupported platform.
Discovery reports the identity and reason with empty profile lists.
Configuration fails for that provider before allocation. The status command
reports the reason.

### Access requirements

Each property of the `access` record maps to one policy setting. The `needed`
state requires access and the `prevented` state requires denial. Adding a
property must fail compilation until negotiation, the policy mapping and the
conformance cases handle it.

| Property              | Restriction and consumer                                                                                                                                  | Need and consumer                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostWorkspaceWrites` | Prevents all changes to the host checkout, including changes through aliases. The permission reviewer relies on this during investigations.               | Requires write access to the live checkout. Escalated `bash` uses it for commands that must edit the live checkout when the configured policy keeps it read-only. |
| `network`             | Prevents workload network access. The permission reviewer and Docker shell profile rely on it for offline commands.                                       | Requires network access. Escalated `bash` uses it for operations such as fetching a dependency.                                                                   |
| `hostUserData`        | Prevents reads and writes to host user data. The permission reviewer and Docker shell profile rely on it to exclude host credentials and unrelated files. | Requires read access under the host user data roots. A command can request a specific path outside those roots through escalation.                                |
| `hostSystemFiles`     | Prevents reads and writes to host system files. The Docker shell profile relies on it to run against the container image's system files.                  | Requires read access to host system files. Escalated `bash` uses it for commands that need files under a system root.                                             |

The broker classifies host files by canonical path in this order.

1. A path within the checkout is workspace content. This includes a hard link in
   the checkout with another link outside it.
2. A path at or below one of the platform's system roots is a host system file.
   The file's owner and author do not affect its class.
3. Every other host path is host user data. Canonical paths under `/usr/local`
   and `/var` are examples.

The SDK exports the fixed `hostSystemRoots` map from `/provider`. The macOS list
includes `/private/etc`, the canonical path of `/etc`. Providers document any
extra runtime resources that their launchers need.

The macOS system roots under `/System` are `Applications`, `Cryptexes`,
`Developer`, `DriverKit`, `KernelKit`, `Library`, `iOSSupport` and `x86Support`.
These are OS-managed directories. The wider tree includes the writable Data
volume. [APFS firmlinks][apfs-firmlinks] can expose the same file through an
ordinary path and a path under `/System/Volumes/Data`. The broker removes that
prefix when it compares paths for workspace, system and credential checks. The
provider receives the path that the filesystem resolved.

The macOS list also includes `/System/Volumes/Preboot/Cryptexes`. macOS manages
this directory and uses it for runtime files such as the dyld shared cache.
Other paths under `/System/Volumes` outside the checkout are host user data.

[apfs-firmlinks]:
  https://developer.apple.com/documentation/system/fileflags/firmlink

Both lists include `/nix/store` and `/nix/var/nix/profiles`. The Nix store is
world-readable and uses [hash-based path names][nix-store-paths]. In a
[multi-user installation][nix-daemon], a privileged daemon manages store writes.
In a single-user Nix installation, the user owns the store. The canonical-path
rule still classifies the store as system files.

On NixOS, shells and system commands resolve into the store, often through
`/run/current-system`. A profile that permits system reads can therefore run
these commands while denying host user data. The same rule applies to
Nix-installed tools on macOS. The Linux list includes the `/run/current-system`
symlink for providers that bind that path directly.

[nix-store-paths]:
  https://nix.dev/manual/nix/2.25/command-ref/new-cli/nix3-store-make-content-addressed
[nix-daemon]: https://nix.dev/manual/nix/2.34/installation/multi-user

A provider that exposes the live checkout refuses sockets, FIFOs and device
files in the checkout when it opens. A host process can add entries after open,
which falls outside this contract. The host classes apply only to host files. A
target can have its own operating system and dependencies.

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

### Default toolchain roots

The SDK exports `hostToolchainRoots` from `/provider`. Both `read-only` and
`read-write` host user data policies apply within these roots and the additional
roots in the provider's `readRoots` setting. The broker checks ordinary path
requests against the roots before allocation.

| Platform        | Default toolchain roots                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux and macOS | `~/.cargo`, `~/.rustup`, `~/.local/share/mise`, `~/.nvm`, `~/.local/bin`, `~/.bun`, `~/.deno`, `~/.pyenv`, `~/.volta`, `/opt/homebrew`, `/usr/local`, `/opt/local` |
| Linux           | `~/.local/share/pnpm`                                                                                                                                              |
| macOS           | `~/Library/pnpm`                                                                                                                                                   |

The list uses fixed paths. The broker expands `~` against the host user's home
and resolves all roots to canonical host paths. Add `~` to `readRoots` to allow
access across the home directory. A relocated toolchain, a cache or a Go
workspace outside the roots needs a configured root or an explicit grant. A
`hostUserData: prevented` requirement denies access to host user data even under
these roots. Workspace content and host system files use their own policy
settings.

### Credential locations

Both policies that permit host user data access exclude credential locations. An
exclusion takes precedence over a built-in or configured read root. A `denied`
policy prevents access to all host user data. Docker provides `denied` because
its backend does not mount the home directory.

Providers call `resolveCredentialLocations()` from `/provider` for the absolute
exclusion paths. The function expands the home-relative entries from
`credentialLocations` and locates both Pi credential files through Pi's own
agent-directory lookup. Each exclusion applies to the listed path and its
descendants. The broker evaluates each resolved grant path. The workspace
contract still applies inside the checkout.

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
| `~/.cargo/credentials.toml`                   | [Cargo registry authentication tokens][cargo-login].                 |
| `~/.cargo/credentials`                        | [Legacy Cargo registry credentials][cargo-config].                   |
| `~/.npmrc`                                    | [npm registry authentication settings][npmrc].                       |
| `~/.gem/credentials`                          | [RubyGems API keys][gem-config].                                     |
| `~/.yarnrc.yml`                               | [Yarn registry authentication settings][yarn-config].                |
| `~/.terraform.d/credentials.tfrc.json`        | [Terraform CLI tokens for remote services][terraform-login].         |
| `auth.json` in Pi's agent directory           | API keys and OAuth credentials for Pi's model providers.             |
| `mcp-auth.json` in Pi's agent directory       | OAuth state and tokens for Pi's MCP servers.                         |
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

[cargo-login]: https://doc.rust-lang.org/cargo/commands/cargo-login.html
[cargo-config]: https://doc.rust-lang.org/cargo/reference/config.html
[npmrc]: https://docs.npmjs.com/files/npmrc/
[gem-config]: https://guides.rubygems.org/configuration/
[yarn-config]: https://yarnpkg.com/configuration/yarnrc/
[terraform-login]: https://developer.hashicorp.com/terraform/cli/commands/login
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
profiles. A profile must offer file access of the requested kind. After opening,
the backend reports the target location of each path. A workspace grant keeps
the same relative path under the target workspace root. The broker checks the
placement and probes the requested access. It returns a typed error for a
missing or unreachable grant and disposes of the backend. An ordinary grant
confirms existing access. It leaves the policy unchanged. A copy may require
paths reachable in the copy. Copy writes stay in the copy.

Escalation can add access to requested paths beyond the configured policy. A
profile declares whether the provider can grant extra read paths or extra write
paths. The provider enforces the grant and reports where the path appears in the
target. The caller uses that location to reach the granted file. For example, a
command can read one host configuration file without access to the rest of the
user's home directory.

A grant to a credential location outside the checkout requires an escalation
that lists the path, and a decision for that call. The broker checks credential
locations and their aliases independently of the file class. An escalation of
the `hostUserData` property alone keeps the provider's credential exclusion. If
no provider profile can satisfy the request, the confirmation describes the
unrestricted host destination. An approval for that destination permits
execution with no effective restrictions.

## Execution and capabilities

| Capability    | Consumer and purpose                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `files.read`  | Pi's `read` and `edit` read target bytes. The permission reviewer reads evidence from its copy. |
| `files.write` | Pi's `write` and `edit` change target files.                                                    |
| `files.list`  | Pi's `ls` inspects target entries.                                                              |
| `search.find` | Pi's `find` locates files under a target root.                                                  |
| `search.grep` | Pi's `grep` gets matches and context in the target.                                             |

Every backend supports execution. The facade checks file and search capabilities
before dispatch. A provider's copy profiles determine whether an independent
workspace is available for review. Pi uses the same workspace for shell, file
and search operations. Paths, executable lookup and environment overrides refer
to the destination. Providers enforce access inside the backend, including
through symlinks.

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
groups or sessions. Cancellation waits within the cleanup allowance for
confirmation under the declared scope. Unconfirmed termination or an unknown
mutation outcome makes the backend unusable. The broker cancels before dispatch
when possible and never replays work. The example consumer can continue using
the backend after an ordinary non-zero exit.

[process]: api-protocol.md#process-files-and-search

The broker serialises SDK writes and directory creation. Each read is a separate
operation, so another mutation can run between a read and a write. Shell
commands and independent processes can change files outside the queue.

Pi's file tools use its built-in definitions with SDK operations. Pi runs its
edit algorithm in its own in-process queue, keyed by host path. Pi's grep uses
the target's `rg` when available and formats the results with Pi's truncation
helpers. The [adapter guide][file-adapters] describes the host-side steps and
the limits of this integration.

[file-adapters]: pi-file-adapters.md

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

A `hostUserData: needed` escalation selects only read-only provider profiles.
The property grants reads within the host user data roots. Request an explicit
path grant for a read or write outside the roots. If no eligible provider
profile exists, the confirmation identifies the unrestricted host destination.

Paths inside the checkout keep the provider's workspace mapping. For an extra
path under the host home directory, the provider uses the same relative path
under the target home directory. An extra path outside both directories uses the
same absolute path in the target. Profiles declare supported extra grant kinds
in `pathGrantKinds`. The backend reports the actual mappings in `grantedPaths`.
If the provider reports an unreachable path or a different target path, the
broker returns a typed path error and disposes the backend.

An explicit credential path grant requires its kind in
`credentialPathGrantKinds`. The list is a subset of `pathGrantKinds`. A profile
without a matching kind cannot supply the grant. If no provider profile
qualifies, the broker presents the unrestricted host destination for approval.

When a profile permits host user data reads, the backend reports an absolute
target path in `workspace.hostUserDataRoot`. Ordinary files from the host home
directory keep their home-relative paths under this root. Credential exclusions
still apply. A native provider can report the original host home path while
using scratch space for the target home. A provider that denies host user data
omits the field. Docker omits it because its profiles deny host user data.

For both permitted host user data modes, the broker sends `hostUserDataRoots` to
provider `open` and `copy`. The backend reports the same set of canonical host
roots in `hostUserDataRoots`. The broker rejects and disposes a backend if the
set is absent or different. The provider also receives `credentialExclusions`
for either permitted mode and for grants that reach host user data outside the
checkout. The broker includes the original paths and their resolved aliases.
Both Pi credential paths come from the effective agent directory. The
unrestricted host destination uses no root list.

The elected broker prepares each shell call from Pi's `tool_execution_start`
event. It checks the active tool's source path and the identity of its parameter
schema. The broker keeps the command, arguments and plan in a pending record for
that call. Review and confirmation use that record.

The broker presents the effective command, justification, requested access,
chosen destination and effective restrictions before a decision. For the host,
the effective restrictions are `none`. Any installed extension can allow or deny
a pending escalation through a review source and its consumer client. Installing
a permission extension delegates that choice to it. Conflicting decisions fail
closed. If extra access still requires approval, BYOS asks the user for
confirmation and shows the provider label. A matching remembered read grant or a
decision from a permission extension removes the need for a second prompt.

Before dispatch, the broker checks the selected tool and arguments against the
pending record, consumes the decision once and records the outcome. An allow
decision permits the broker to open the planned destination. A denial,
dismissal, cancellation or expiry prevents dispatch.

### Read grant duration

Approval defaults to the current call. The user can remember eligible reads for
the Pi session. **Always** is available for host user data reads when the
configured policy is read-only and the provider supplies a settings writer.
Under a read-write policy, saving the root would also allow writes. Under a
denied policy, the saved root would grant no access.

**Always** saves the approved paths to the provider's global `readRoots` setting
so later sessions can read them under the ordinary policy. BYOS reports the
paths and settings file after saving. The current call can run after the write
succeeds.

Access to a specific credential path requires approval for that call. Directory
grants keep credential exclusions at every duration. Write and network grants
apply only to the current call.

Before a run with a BYOS shell, the system prompt describes the negotiated
policy and roots for ordinary shell commands and explains whether escalation is
available. An escalation prompt and a shell result describe the effective
policy, roots and path grants for that call. The cleaning function returns the
display text type for model, provider and extension text. User interfaces
require that type and diagnostics omit raw settings.

The [API appendix][escalation-api] defines the tool arguments, pending request
and decision function.

[escalation-api]: api-protocol.md#escalation-and-review

## Copies and review

A copy starts from the source destination's files and has its own workspace and
lifetime. Changes to it do not propagate back. The permission reviewer uses this
independence to inspect the pending call's environment. A copy need not reflect
one atomic instant of the source. If its profile cannot satisfy the request, the
broker reports why before allocating it.

The elected broker derives review from the pending call. For an ordinary call,
the broker negotiates the destination under the configured policy. For an
escalation, it uses its escalation plan. The review route replies with an
identity for that source or a typed reason for unavailability. The reviewer
resolves the identity through the elected broker. The review source can
negotiate and request a private copy of its destination. The broker rejects
unsolicited or mismatched identities.

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

The first release uses protocol 1.0. Earlier drafts can advertise the same
version with incompatible contracts. Upgrade all BYOS extensions together and
restart Pi before using the release.

During the Pi extension factory, consumers create a client with
`createSandboxClient(pi, import.meta.filename)`. Provider registration, the Pi
tool integration and `initialiseSandboxHost` join the build census from their
respective factories. Calling `createSandboxClient` or `initialiseSandboxHost`
after the factories have run raises `SandboxInitialisationError`.

The first BYOS `session_start` handler elects the build with the highest feature
level. Ties use the SDK package version in SemVer order, then the build ID and
extension source path in code unit order. The broker captures the session ID and
canonical absolute checkout from Pi's event before it publishes a service. It
uses that checkout for settings, grants and allocation. A caller must supply the
captured session ID and either the original Pi working directory or its
canonical spelling. Requests before startup fail with
`SandboxInitialisationError`. A mismatched context fails with
`StaleSandboxHandleError`.

Consumer clients pin the elected build, candidate and broker instance. Broker
discovery offers acquisition, negotiation, status, provider metadata and review
source resolution. Provider advertisements contain only descriptive data. During
startup, providers transfer their resolver and backend operations directly to
the elected owner. The owner keeps settings private and passes the tool
integration callbacks for its registered tools.

The private startup exchange keeps owner operations out of ordinary discovery.
Pi's event bus forwards messages without authenticating the sender. An installed
extension can therefore impersonate a startup participant by answering the build
census or offering a provider or host receiver. Installing an extension means
trusting that extension to participate in startup and review.

## Lifetime and recovery

Registration, diagnostics and negotiation perform no backend allocation. The
broker can share an ordinary backend within a generation for identical profiles
and workspace. Separate sessions and reloads get fresh generations. A resumed
transcript does not restore old resources. Consumers with cached facades receive
an error after the generation closes.

The generation stops accepting work when the broker observes shutdown. An
embedding host calls `close()` on the handle from `initialiseSandboxHost` before
disposing of the Pi runtime. Pi's `session_shutdown` handler shares the same
cleanup operation and report. The broker rejects new work, cancels pending and
active operations and disposes of ordinary, copy and escalated backends within
bounded cleanup budgets. The embedding host relies on those budgets to finish
shutdown when a transport stalls. Each allocation has one owner and each close
is idempotent. Providers clean up partial allocations on failed startup and
dispose of any allocation that finishes after the request has expired. Cleanup
timeouts mean cleanup is unconfirmed. Providers record recovery instructions for
resources that require intervention. The host and reviewer rely on the close
report to distinguish confirmed disposal from outstanding work. The user relies
on status to find the affected allocation without revealing secrets. Provider
leases or documented recovery cover crashes that prevent orderly shutdown.

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
negotiated policy. Users can inspect the current session with `/byos log` and
filter by tool call ID. Users rely on the ledger to see who approved added
access. Permission extensions can correlate the executed destination and review
copy with the pending call.

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

Providers supply `rg` inside the target for full ripgrep semantics. The portable
helper uses descriptor-relative traversal on Linux. On Darwin it opens paths
with `O_NOFOLLOW_ANY`, which rejects symlinks in every path component. The
provider must declare that the helper runs inline with the same confinement as
ordinary target commands. The target's confinement defines which files are
readable. The search root only selects where traversal starts.

The portable helper reads Git metadata only inside the target workspace and
skips ambient Git excludes and linked-worktree Git directories outside that
workspace. It uses the RE2 regex dialect and skips input files larger than 16
MiB. A target without `rg` or a supported portable helper reports
`UnsupportedSandboxCapabilityError` before searching.

[ripgrep]:
  https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering
