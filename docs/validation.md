# Validation and supported boundaries

The implementation targets Pi 1.5.0 and Node 24 or later. Development uses the
pinned Node version in `.node-version`. The package remains a private `0.0.0`
development build. The [specification][spec] and [implementation plan][plan]
define the contract and delivery criteria.

Local verification on 31 October 2026 used macOS on Apple Silicon, pnpm 12.15.0,
fd 10.5.0, ripgrep 15.2.0 and Docker 29.8.2 through a local Unix socket. Docker
jobs ran the digest-pinned Linux image specified by the reference provider. The
CI jobs are configured in the [workflow][workflow]. Unit and Pi integration
tests run on Linux and macOS. Linux jobs also run the static checks,
clean-package installation and real Docker provider suite. The required `check`
job succeeds only when every job in that workflow succeeds. Separate workflows
check Actions security, commit messages and CodeQL results for TypeScript and
Actions.

[spec]: specification.md
[plan]: implementation-plan.md
[workflow]: ../.github/workflows/check.yml

## Reproduce the gates

Use the pinned Node and pnpm versions. Commit hooks require pre-commit and Deno.
Native search tests require fd (`fdfind` on Debian) and ripgrep.

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
pnpm test:integration
pnpm test:package
pnpm test:provider
```

The ordinary check builds the SDK before typed linting, then runs formatting,
dependency usage, lint, Markdown, ordinary Vitest cases and type checking. A
clean-output run verifies this order without pre-existing declarations. The
package gate installs the actual archive into separate temporary dependency
roots, with dependency lifecycle scripts disabled. The Docker gate requires a
working local daemon and the pinned image. The [Docker guide][docker] documents
its executable/socket overrides and image preparation.

Use `pnpm fix` to apply ESLint and Prettier fixes.

The ordinary run visibly skips the package case and the daemon-backed cases. The
dedicated commands execute those cases. Model and approval fixtures are local;
the gates need no real model credentials. Commit hooks also check file hygiene,
workflows and commit-message formatting.

[docker]: ../examples/docker/README.md

## Try the development checkout

Load the source diagnostic extension without changing Pi settings:

```sh
pi --no-extensions -e ./src/extension.ts
```

Run `/byos status`, `/byos providers` or `/byos approval-policies`. These
commands produce displayable Pi messages in TUI and headless sessions. The Git
manifest loads the source extension. `pnpm build` produces the compiled SDK
selected by the packed archive's export map. The loader tests exercise both
source and compiled entries without model credentials.

## Specification acceptance evidence

| Criterion                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Independent extensions and SDK copies share one broker, in every factory order. Consumer-only use works without configuration. | The six-order matrix in [broker integration][broker] invokes distinct SDK copies for provider registration and consumer acquisition. It checks one service, one opening and disposal. [Client integration][client] covers consumer-only host execution, concurrent independent SDK copies, unselected providers and separate sessions. [Registration integration][registration] checks failed-factory cleanup and concurrent bootstrap.                                                                             |
| 2. The same consumer works with different providers, including a real isolated backend.                                           | The [consumer example tests][consumer-tests] run the same tool with passthrough, a direct in-memory provider and a MessageChannel provider with remote paths. The [direct provider tests][memory-contract] and [message provider tests][message-contract] register the same [contract cases][contracts]. [Docker session tests][docker-sessions] run the same helper against the isolated reference backend.                                                                                                        |
| 3. Configuration, discovery, policy and backend failures produce typed errors without switching to host execution.                | [Configuration tests][config] cover personal selection, absence, read errors, invalid keys and explicit selection. [Discovery tests][discovery] and [backend validation][backend] cover conflicting declarations, incompatible versions, capabilities and effective policy. [Client integration][client], [Pi shell integration][shell] and [user-shell integration][user-shell] guard selected-provider failure paths. [Error tests][errors] verify concrete classes and structural recognition across SDK copies. |
| 4. Output, exits, cancellation, deadlines, shared startup and shutdown obey the contract.                                         | [Execution tests][execution] cover byte ownership, capture bounds, draining, exit variants, all abort causes and quarantine. [Lifecycle tests][lifecycle] exercise deadlines and confirmation with controlled promises. [Generation tests][generation] cover independent waiters, shared opening, late completion, shutdown and recovery. The [host contract][host-contract] and [Docker contract scenarios][docker-contract] independently check target termination.                                               |
| 5. Runtime replacement and disposal reject stale work and release resources.                                                      | [Broker integration][broker] exercises reload, new sessions and raw disposal. [Client integration][client] checks explicit raw-host shutdown and separate sessions. [Generation tests][generation] cover rejected backends, exactly-once cleanup, timeout recovery and stale facades. The provider suite checks repeated and overlapping disposal; [Docker sessions][docker-sessions] check distinct allocations and cleanup through the daemon.                                                                    |
| 6. Optional integration uses public hooks and preserves Pi's own algorithms and approval. Upstream gaps have reproductions.       | [Pi shell integration][shell] covers direct/nested calls, allow/deny decisions, validation, transforms, active tool selection and native full-output files. [RPC tests][rpc] cover CLI user-shell execution and cold-start cancellation. [Boundary reproductions][boundaries] demonstrate unsupported file/search paths through public factories. The [coverage table][coverage] specifies the required upstream hooks.                                                                                             |
| 7. The packed SDK loads through Pi with usable declarations and without real credentials.                                         | The [package gate][package] checks that a clean build removes obsolete modules, compares the pack preview and archive, checks exports and manifest paths, installs two physical SDK copies, compiles consumers and copied examples, and loads the compiled entries through Pi. Production imports work without Vitest; the provider's own Vitest installation runs the shipped contract suite. [Loader tests][loader] cover source and compiled extension entry points.                                             |

[broker]: ../src/broker-integration.test.ts
[client]: ../src/client-integration.test.ts
[registration]: ../src/registration-integration.test.ts
[consumer-tests]: ../examples/consumer/test/integration.test.ts
[contracts]: ../src/provider-contract-suite.ts
[memory-contract]: ../src/provider-contract.test.ts
[message-contract]: ../src/provider-contract-message.test.ts
[host-contract]: ../src/provider-contract-host.test.ts
[docker-contract]: ../examples/docker/test/provider.test.ts
[docker-sessions]: ../examples/docker/test/session.test.ts
[config]: ../src/config.test.ts
[discovery]: ../src/discovery.test.ts
[backend]: ../src/backend-validation.test.ts
[shell]: ../src/pi-tools-integration.test.ts
[user-shell]: ../src/user-shell-integration.test.ts
[errors]: ../src/errors.test.ts
[execution]: ../src/execution.test.ts
[lifecycle]: ../src/lifecycle.test.ts
[generation]: ../src/generation.test.ts
[rpc]: ../src/user-shell-rpc.test.ts
[boundaries]: ../src/pi-boundaries.test.ts
[coverage]: pi-integration.md
[package]: ../src/package.test.ts
[loader]: ../src/extension.test.ts

## Additional plan requirements

[Facade tests][facade] check remote-only files, buffer ownership, UTF-8,
complete read/transform/write serialisation, parent creation and quarantine
before queued mutations resume. [File-result tests][file-result] and
[search-facade tests][search] validate target-native POSIX/Windows paths,
duplicate identities, limits and context. [Native search tests][native-search]
check fd/ripgrep semantics, ignore rules, binary files, ordering, exact limits
and unavailable tools.

The reusable [provider-suite tests][provider-suite] reject incomplete methods,
incorrect policy, fabricated output, failed independent verification and
non-idempotent disposal. They also exercise bounded stages and preservation of
assertion and teardown failures. The [provider testing guide][provider-guide]
explains the independent target checks required from provider authors.

[Diagnostic tests][diagnostics] check allocation-free status and provider
listing, configuration-source reporting, recovery and omission of diagnostic
causes. Shell integration reports requested or unavailable status and keeps
routing unverified because Pi cannot expose complete handler ownership.

Public contracts, concrete errors and `/testing` fixtures include TSDoc in the
emitted declarations. The [consumer guide][consumer-guide] and Docker guide
cover installation, selection, target paths, unsupported operations, cleanup and
raw-host shutdown. The clean-install gate checks the source examples and public
imports from the installed archive.

[facade]: ../src/facade.test.ts
[file-result]: ../src/file-result.test.ts
[search]: ../src/search-facade.test.ts
[native-search]: ../src/host-search.test.ts
[provider-suite]: ../src/provider-contract.test.ts
[provider-guide]: provider-testing.md
[diagnostics]: ../src/diagnostics-integration.test.ts
[consumer-guide]: ../examples/consumer/README.md

## Independent approvals and outside execution

Local verification on 1 November 2026 used the same Pi, Node and pnpm versions.
`pnpm check` passed 550 ordinary tests and all build, formatting, dependency,
lint, Markdown and type checks. The dedicated integration gate passed 112 tests.
The clean-package gate passed, including two physically separate SDK installs,
provider-defined outside execution, fresh approval for each operation and
structural approval-error recognition. All 22 Docker cases passed with the local
executable and Unix-socket overrides described in the Docker guide.

[Approval integration][outside-tests] covers the built-in policies, independent
provider and policy extensions, queued prompt expiry, cancellation, immutable
acquisition requirements, embedded normal execution and SDK shutdown. Standalone
reviews observe the runtime shutdown signal even if malformed service discovery
prevents direct service closure. Cleanup attempts every service domain and
includes failures in its combined report. [Service bootstrap tests][services]
cover re-entrant creation and retained initialisation failure.

[Outside shell integration][outside-shell] uses separate scripted parent and
approver models through real Pi Bash and PowerShell tools. It checks normal and
provider destinations, allow and deny decisions, timeout output preservation and
configuration loading within the execution deadline. A filesystem marker checks
that expiry prevents native command dispatch. The independent-copy registration
matrix covers all six provider, policy and consumer factory orders.

Context-blind adversarial reviews covered architecture, public contracts,
configuration authority, lifecycle, protocol failures, Pi hooks and packaging.
The resulting shutdown, cancellation, discovery and deadline regressions pass.
The final review reported no remaining implementation defects. Native Pi process
cleanup retains the upstream limitation specified in the [approval
guide][approval].

[outside-tests]: ../src/outside-execution-integration.test.ts
[services]: ../src/extension-services.test.ts
[outside-shell]: ../src/pi-tools-outside-integration.test.ts
[approval]: approval-execution.md

## User-flow integration audit

Local verification on 1 November 2026 passed the strict check with 583 ordinary
tests, the integration gate with 147 cases, all 22 Docker cases and the
clean-package gate. The approval RPC suite contributes 32 cases.

The [user-flow matrix][user-flows] maps supported installation, configuration,
execution, approval, lifecycle and diagnostic flows to integration tests. The
[approval RPC suite][approval-rpc] starts Pi's actual offline CLI process and
exchanges confirmation request/response packets. It does not replace
`context.ui.confirm`. It verifies allow, deny, dismissal, expiry, queueing, late
responses, caller/model cancellation, SDK close, process shutdown and session
replacement. Filesystem effects and backend journals independently check that
rejected requests do not execute.

The RPC suite also covers built-in and missing policies, invalid policy
configuration, failing policies/providers, command prefixes, inconsistent tool
arguments, personal configuration authority and diagnostics without allocation.
A deterministic SDK regression verifies deadline classification while an
approval is pending. The headless approval service tests are included in the
integration gate alongside the other real-Pi suites.

[user-flows]: user-flow-coverage.md
[approval-rpc]: ../src/approval-rpc-integration.test.ts

## Platform and integration limits

Host foreground execution currently supports POSIX process groups. Windows host
process-tree cancellation is unsupported. Passthrough confirms only the original
process group. Detached descendants that create another session or process group
can continue after foreground completion, cancellation and disposal. The public
API excludes those jobs; adversarial host tests record this boundary.
Target-native Windows metadata and search-result validation do not establish
Windows host execution support. Host search requires installed fd and/or ripgrep
and advertises only the available operations.

The Docker reference provider uses a local Unix-socket daemon, copied workspace
volumes, POSIX `sh` and Bash. It supplies execution only, with no SDK
file/search groups or PowerShell. Docker session tests exercise model Bash
dispatch and fake approval against the isolated target. Workspace volumes have
no storage quota, and the initial copy container has no job resource limits.
Large workspaces or writes can exhaust daemon storage. Docker cleanup after a
host crash is manual; the provider reports non-secret resource identities and
recovery instructions before allocation.

The framework does not route Pi's read, write, edit, find, ls or grep tools.
Their incomplete operation boundaries are upstream work. Pi's full-output paths
refer to host transcript files. Literal interactive `!`/`!!` input parsing is
not covered by the automated CLI/RPC tests. Other extensions can override shell
tools or consume user-shell commands earlier.

The service is cooperative. Direct SDK operations do not invoke Pi tool approval
hooks, and arbitrary host I/O from other extensions remains outside this API.
Embedded hosts with an explicit Pi `agentDir` must bind that directory through
`initialiseSandboxHost` before broker or consumer factories run. Raw embedding
hosts must call `closeSandboxSession` before disposing their Pi session. A
failed transport or unconfirmed mutation/termination quarantines the backend;
the framework does not repeat the operation or switch to host execution.
