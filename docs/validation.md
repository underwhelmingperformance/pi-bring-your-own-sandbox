# Validation and supported boundaries

The implementation targets Pi 1.4.0 and Node 24.22.2. The package remains a
private `0.0.0` development build. The [specification][spec] and [implementation
plan][plan] define the contract and delivery criteria.

Local verification on 31 October 2026 used macOS on Apple Silicon, pnpm 12.15.0,
fd 10.5.0, ripgrep 15.2.0 and Docker 29.8.2 through a local Unix socket. Docker
jobs ran the digest-pinned Linux image specified by the reference provider. The
Linux CI jobs are configured in the [workflow][workflow]; hosted results have
not been observed as part of this local validation.

[spec]: specification.md
[plan]: implementation-plan.md
[workflow]: ../.github/workflows/check.yml

## Reproduce the gates

```sh
pnpm install --frozen-lockfile
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

The ordinary run visibly skips the package case and the daemon-backed cases. The
dedicated commands execute those cases. Model and approval fixtures are local;
the gates need no real model credentials. Commit hooks also check file hygiene,
workflows and commit-message formatting.

[docker]: ../examples/docker/README.md

## Specification acceptance evidence

| Criterion                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Independent extensions and SDK copies share one broker, in every factory order. Consumer-only use works without configuration. | The six-order matrix in [broker integration][broker] invokes distinct SDK copies for provider registration and consumer acquisition. It checks one service, one opening and disposal. [Client integration][client] covers consumer-only host execution, concurrent independent SDK copies, unselected providers and separate sessions. [Registration integration][registration] checks failed-factory cleanup and concurrent bootstrap.                                                                         |
| 2. The same consumer works with different providers, including a real isolated backend.                                           | The [consumer example tests][consumer-tests] run the same tool with passthrough, a direct in-memory provider and a MessageChannel provider with remote paths. The [direct provider tests][memory-contract] and [message provider tests][message-contract] register the same [contract cases][contracts]. [Docker session tests][docker-sessions] run the same helper against the isolated reference backend.                                                                                                    |
| 3. Configuration, discovery, policy and backend failures produce typed errors without switching to host execution.                | [Configuration tests][config] cover trust, merging, absence, read errors, invalid keys and explicit selection. [Discovery tests][discovery] and [backend validation][backend] cover conflicting declarations, incompatible versions, capabilities and effective policy. [Client integration][client], [Pi shell integration][shell] and [user-shell integration][user-shell] guard selected-provider failure paths. [Error tests][errors] verify concrete classes and structural recognition across SDK copies. |
| 4. Output, exits, cancellation, deadlines, shared startup and shutdown obey the contract.                                         | [Execution tests][execution] cover byte ownership, capture bounds, draining, exit variants, all abort causes and quarantine. [Lifecycle tests][lifecycle] exercise deadlines and confirmation with controlled promises. [Generation tests][generation] cover independent waiters, shared opening, late completion, shutdown and recovery. The [host contract][host-contract] and [Docker contract scenarios][docker-contract] independently check target termination.                                           |
| 5. Runtime replacement and disposal reject stale work and release resources.                                                      | [Broker integration][broker] exercises reload, new sessions and raw disposal. [Client integration][client] checks explicit raw-host shutdown and separate sessions. [Generation tests][generation] cover rejected backends, exactly-once cleanup, timeout recovery and stale facades. The provider suite checks repeated and overlapping disposal; [Docker sessions][docker-sessions] check distinct allocations and cleanup through the daemon.                                                                |
| 6. Optional integration uses public hooks and preserves Pi's own algorithms and approval. Upstream gaps have reproductions.       | [Pi shell integration][shell] covers direct/nested calls, allow/deny decisions, validation, transforms, active tool selection and native full-output files. [RPC tests][rpc] cover CLI user-shell execution and cold-start cancellation. [Boundary reproductions][boundaries] demonstrate unsupported file/search paths through public factories. The [coverage table][coverage] specifies the required upstream hooks.                                                                                         |
| 7. The packed SDK loads through Pi with usable declarations and without real credentials.                                         | The [package gate][package] checks that a clean build removes obsolete modules, compares the pack preview and archive, checks exports and manifest paths, installs two physical SDK copies, compiles consumers and copied examples, and loads the compiled entries through Pi. Production imports work without Vitest; the provider's own Vitest installation runs the shipped contract suite. [Loader tests][loader] cover source and compiled extension entry points.                                         |

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
