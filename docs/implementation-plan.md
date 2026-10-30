# Implementation plan

Implement the [specification][spec] in dependency order. The
[research][research] contains immutable upstream references and results from the
exploratory probes. This plan authorises no publishing, deployment or user-wide
Pi configuration changes.

[spec]: specification.md
[research]: research.md

## 0. Freeze the public types and inter-extension protocol

The exported declarations and [API/protocol appendix][api] define the proposed
interoperability contract. Two independently implemented provider fixtures and a
consumer fixture typecheck, including execution-only backends. Error and
discovery validators pass independent-message and physical-SDK-copy tests on
Pi's event bus and loader. Synchronous bootstrap is tested with independent
service stubs, including failed and re-entrant construction. Backend validation
and real-broker integration remain. Complete this stage before implementing
broker behaviour.

[api]: api-protocol.md

Keep one published framework package, `pi-bring-your-own-sandbox`, with `/api`,
`/extension`, `/pi-tools` and `/testing` subpaths. Include passthrough and the
on-demand broker service in that package. Consumers and providers use a normal
framework dependency; do not require it as a peer or rely on one deduplicated
SDK instance. Host-provided Pi imports are peers with pinned development
versions. Use an optional Vitest peer for `/testing`, with Vitest installed as a
development dependency by contract-test users. Keep production exports
independent of the test runner and backend-specific clients.

Write the complete exported structural types in `contracts.ts`, with the public
re-exports in `api.ts`, and a normative API/protocol appendix in the spec.
Decide the following explicitly:

| Contract                | Decisions required before implementation                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquisition and facade  | Exact `getSandbox` and close-helper signatures; operation options and defaults; immutable metadata; how capabilities narrow optional operation groups.                                        |
| Provider configuration  | The type relationship between unknown input, validated provider-specific configuration and `open`; validation errors; public versus backend-only fields.                                      |
| Capabilities and policy | Exact declaration shapes, supported values, effective-policy representation and runtime consistency checks against available methods.                                                         |
| Process operations      | Exact argv/shell fields, environment overrides/deletion, target cwd, output callback and capture options, byte ownership, exit results, termination acknowledgement and timing fields.        |
| Files and search        | Method signatures, access/stat/list shapes, byte/text encodings, update callbacks/results, search request/result schemas, limits and cancellation completion.                                 |
| Discovery               | Literal channels; request/reply discriminants and fields; service identity and supported versions; callback signature; duplicate, malformed, repeated and late replies.                       |
| Service bootstrap       | Exact shared service interface; synchronous discover/create/publish boundary; owning Pi runtime; optional diagnostic-factory reuse; stale service detection and invalidation.                 |
| Errors and recovery     | Concrete error classes and typed context; structural guard across SDK copies; cancellation versus unknown completion; cause handling; non-secret recovery descriptors and reporting callback. |
| Compatibility           | Required/optional/unknown fields; extension rules for service and discovery versions; behaviour of incompatible SDK copies; deliberate mutable versus readonly values.                        |

Use the declarations to typecheck one consumer and at least two independently
written providers. Include an execution-only provider so capability groups do
not become mandatory accidentally. The consumer must use the same code with
default passthrough and a selected external backend. Use no unchecked casts to
hide holes in the public types. Compile negative cases for unsupported literals,
invalid result variants and configuration type mismatches.

Create protocol fixtures that do not import the implementation's envelope
constructors or validators. Test structural compatibility through independent
SDK copies, including compatible replies, malformed/incompatible replies and
exactly one on-demand service registration during concurrent first use. Define
expected outcomes for absent, conflicting, stale and already-closing services.
Callbacks and service objects remain in-process; this is not a JSON/RPC wire
protocol and must not assume serialisation of functions or abort signals. At
this stage, exercise fixtures against minimal independent responder stubs.
Stages 1 and 2 verify the same contract through real Pi and the implemented SDK;
stub agreement alone does not establish that runtime discovery works.

Exit criterion: provider and consumer authors can implement against the types
and protocol appendix without inventing message fields or operational semantics.
The declarations compile, negative type cases fail as expected, and independent
protocol fixtures agree. Only then implement the broker and execution backends.

## 1. Bootstrap the package and prove the integration contract

Use the scaffold's pnpm lockfile, Node 24, strict TypeScript, Vitest, typed
ESLint with Unicorn/import sorting, Prettier and Markdownlint. Pre-commit runs
the checks, and Wrapscallion validates commit messages. These conventions come
from the sibling repositories. Add/change dependencies with pnpm commands. Pi
1.4.0 is pinned in the private scaffold; prepare host-provided peers for
distribution according to Pi's package guidance. Keep Pi as a host-provided
peer, not a bundled runtime dependency.

Use dependency injection at the broker, provider and consumer boundaries. Unit
fixtures use in-memory backends and controlled promises; independent integration
fixtures exercise Pi's actual loader and event bus. Avoid global replacements of
provider or host APIs.

Give each failure a concrete error class with typed context and a fixed display
message. The shared base is abstract. Test each class and structural recognition
across physical SDK copies. Cancellation and completion fields must remain
closed types; diagnostic causes are not routine output.

Document every public declaration and its behavioural constraints in TSDoc.
Explain ownership, units, defaults, cancellation and target path semantics at
the relevant member. Keep constructor identity separate from structural
recognition in error documentation. Check emitted declarations so installed SDK
consumers receive the same documentation.

Separate modules by responsibility, provisionally:

```text
src/
  api.ts                    public re-exports
  contracts.ts              provider, facade, process, path and policy types
  errors.ts                 concrete errors and structural guards
  discovery.ts              versioned collection protocol
  provider-registration.ts  provider responder
  client.ts                 consumer discovery and facade
  service.ts                shared service discovery and on-demand creation
  broker.ts                 registry, selection and state machine
  passthrough.ts            built-in host execution and filesystem backend
  config.ts                 personal/trusted-project configuration
  lifecycle.ts              startup, cancellation and shutdown
  extension.ts              broker factory and diagnostic commands
  pi-tools.ts               optional public-hook integration factory
  user-shell.ts             public user_bash operations bridge
  testing.ts                public contract-test re-exports
test/
  unit/
  integration/
  fixtures/                 independent provider/consumer packages
examples/
  provider/
  consumer/
```

Only re-export from API/re-export files. Keep extension factory logic in
`extension.ts` and `pi-tools.ts`, not `index.ts`. Publish compiled JS and
`.d.ts` files with explicit export maps and a manifest containing only the
optional diagnostic broker factory as the package's default extension. Consumers
must also work when only their SDK dependency is installed; loading that factory
separately must not be required.

First add a minimal real-Pi harness: temporary workspace and agent directory,
in-memory settings/session storage, network-disabled model catalogue, isolated
resource loader and a faux model that issues scripted tool calls. Explicitly
bind extensions. Avoid personal configuration and real credentials. Use public
package exports; do not import upstream test helpers or unexported source paths.

Start red/green tests for discovery before implementing the protocol. Test all
six orders of broker/provider/consumer factories, synchronous reply collection,
async failures, missing replies, duplicate brokers and separate module copies.
Test consumer-only loading with no configured packages and concurrent first
acquisitions through independent SDK copies. Discovery and registration must
publish one service before any asynchronous initialisation. Loading the optional
broker factory later must reuse that service. Incompatible or malformed replies
must fail without creating a replacement service. Also test a provider factory
that installs a responder and then throws. A failed factory must not leave a
usable declaration.

Exit criterion: real Pi establishes discovery and nested tool dispatch without
an external model call, and the package skeleton passes type checking,
formatting and linting. Record exact Pi/Node versions in test output on failure.

## 2. Implement the SDK against the frozen contracts

Use the public declarations, provider/consumer examples and protocol fixtures
from stage 0. Implement their behaviour without silently changing the contract.
If implementation reveals a missing decision, revise the declarations, normative
appendix and independent fixtures together before proceeding. Keep the public
surface limited to the roles in the specification.

Implement structural declaration validation and the synchronous collection
protocol. Operational APIs return promises directly; do not implement async
request/reply by assuming that `events.emit()` awaits handlers. Get a broker
only from a live context, after loading. Register provider responders in
factories without starting backends. Accept compatible protocol metadata across
separate installed SDK copies.

Use `it.each` for invalid declarations and capability/policy mismatches. Assert
complete deterministic outcomes, including concrete error types and context.
Verify error handling through structural checks across SDK copies. Include a
compiled ESM consumer fixture to test package export resolution as well as Pi's
TS loader.

Exit criterion: a consumer can compile against only `/api` and use default host
execution without a separately loaded broker. Invalid discovery or an explicit
sandbox selection that cannot be satisfied must never select host execution.

## 3. Implement selection, configuration and broker lifetime

Add focused tests before each behaviour:

- Personal configuration, trusted project override, untrusted project exclusion,
  absent file, malformed JSON, unknown keys and provider-specific validation.
- No configuration selects built-in `passthrough`; installing an external
  provider alone does not select it. Null/empty provider values are errors.
- Explicit external selection with a missing provider, startup failure or lost
  transport produces an error, with host execution guarded against in each case.
- Complete-object policy replacement, provider-ID change and removal of stale
  provider configuration.
- Explicit selection, duplicate IDs, unsupported policy values and a frozen
  provider set for the runtime generation.
- Lazy startup, concurrent acquisition, failure persistence and waiter-specific
  cancellation/deadlines, including distinct signals and all waiters cancelling.
- Shutdown while idle, opening and executing; late startup completion; repeated
  close; cleanup rejection; failed/cancelled opening after allocation; stale
  facade after reload or raw Pi disposal.
- Aggregate recovery metadata reported before allocation, replaced after
  resource creation and available when opening or disposal never returns.
  Descriptor updates retain coverage of every outstanding resource. Backend
  metadata matches the final report; lease descriptions are not allocation keys.
- Incomplete cleanup warnings during ordinary shutdown, durable recovery during
  an active turn and failed-startup status before explicit close.

Keep backend allocation behind one generation-scoped opening promise. Initialise
metadata idempotently from either the broker's start handler or acquisition.
Consumer-first lifecycle ordering must work without waiting for a later handler.
Persist failed state even when Pi reports and swallows a start-handler error.
Test consumer-first shutdown ordering too: the enforceable barrier starts when
the broker observes shutdown or an embedding host explicitly closes the broker.

Export the explicit close helper for bare SDK hosts. Test normal lifecycle with
`AgentSessionRuntime` and raw disposal separately. Use bounded shutdown and
generation/liveness checks before backend calls. No backend state goes into Pi
session persistence.

Exit criterion: one backend per generation, independent concurrent sessions,
exactly-once disposal and no backend published after the broker enters closing.
Partially created allocations are released or identified for provider recovery.

## 4. Implement passthrough, foreground execution and file/search groups

Implement the built-in `passthrough` provider as a normal backend. Cover host
cwd, argv/shell execution, inherited host environment, filesystem operations,
mutation serialisation, cancellation and actual capability reporting. It must
report no isolation and reject unsupported protection requirements. Reuse
verified public local helpers where appropriate, without routing through a
possibly overridden tool and creating recursion.

Run the ordinary consumer fixture with only its SDK dependency: no broker
extension, provider extension, configuration file or real model credentials.
Verify that this path requires no setup dialogue. Then select a test sandbox and
run the same consumer code through it. Consumer source must not change between
those runs.

Use two deterministic test providers: one records calls with an in-memory
workspace; another models remote paths and a distinct transport. Keep both as
fixtures, clearly described as test doubles without OS isolation. Run the same
consumer and provider-contract cases against both.

Implement argv/shell separation, target environment policy, bounded capture,
ordered byte streaming, UTF-8 decoding at text boundaries, deadlines and
cancellation. Use controllable promises for concurrency tests, not sleeps. Test
non-zero exit independently from failure to spawn or loss of transport. A
timed-out promise must not be accepted as proof that a process stopped.

Cover output above the capture limit, split UTF-8 sequences, signal termination,
callback errors, abort before execution, timeout during execution and a provider
that cannot confirm cancellation. Distinguish process-tree termination from an
early local transport rejection, and apply the grace period to every abort
cause. Verify unhealthy-backend rejection, suppressed late output and that no
mutation is automatically retried.

Implement file/search groups with explicit target path semantics and a shared
mutation queue. Test missing path versus denied path versus transport failure,
remote-only files, symlink escapes, read-only policy and cross-platform lexical
path conversion, including overlapping host/target roots. Exercise a direct SDK
write racing with a consumer transformation through `files.updateText`. The
complete transformation must use the broker's mutation queue. Unknown
cancellation of a queued mutation must quarantine the backend before subsequent
operations can execute.

Keep search operations independent of Pi's tool presentation. Providers document
regex dialects, glob matching, ignore behaviour and result order. Validate typed
paths, limits, context and duplicate identities. Test unsupported operations
without substituting a host backend. The built-in host provider may use native
fd and ripgrep; it does not define compatibility rules for Pi's search tools.

Extract the reusable `/testing` contract suite from these tests. Providers opt
into relevant capability groups; the suite must reject a provider that
advertises unimplemented methods or policy. Use MSW if an HTTP provider fixture
needs network simulation. Do not mock a network service merely to test the local
event bus.

Exit criterion: provider interchangeability, complete result/error semantics,
bounded process-output capture and confirmed cancellation behaviour are covered
automatically. Complete-file reads are not claimed to use bounded memory.

## 5. Connect public Pi operation hooks

Implement an explicitly loaded integration factory separate from the default
broker entry. Keep the adapter limited to public hooks and SDK calls. Use Pi's
definition factories with custom operations where their extension points cover
the complete required boundary. Preserve Pi's active tool selection and test
broker-only loading separately.

Maintain an integration coverage table. For each tool or user-shell path, record
the public hook, delegated operations, tests and upstream blockers. Review the
pinned Pi source before claiming support. If execution probes host files, starts
host tools or computes previews outside the supplied operations, record that gap
as an upstream Pi issue. Include a minimal reproduction and the required hook.
Leave that integration path unsupported until Pi supplies the boundary. Do not
implement replacement edit, read, search, rendering, truncation or progress
algorithms.

Use `BashOperations` for model shell tools and the `user_bash` operations hook
for user commands. Keep Pi's own output accumulation and tool-result creation.
Where Pi emits a host-only full-output reference, record the upstream limitation
without building a separate output-spooling system.

Retain the user-shell bridge's acquisition inside `exec()`. Test cold startup
cancellation, configured/default dialects, unsupported capabilities, persistent
provider failure and unconfirmed termination. Exercise CLI/RPC user-shell input
with a temporary agent directory and no real model credentials. Record any
untested interactive input path explicitly.

Add real-Pi tests with a scripted model and fake approver for supported hooks.
Cover direct and nested tool calls, validation before backend execution, allow
and deny decisions, result transforms and cancellation. Compare target and host
sentinel contents where relevant. Verify that supported delegated operations use
the selected provider and that a configured failure never falls back to the
host. Do not assert universal interception across unsupported Pi paths.

Exit criterion: every claimed integration path has evidence through its public
hook; gaps are documented as upstream work, and the framework contains no copied
Pi tool algorithms. SDK consumers remain usable independently of these gaps.

## 6. Validate a real provider and authoring workflow

Supply a small reference provider extension using an actual isolation backend.
Use Docker as the initial integration example if no target provider has been
chosen by implementation time. It remains an optional example/test dependency,
not a framework runtime dependency. Pin the test image by digest. Provider
configuration validation must reject unsupported policies before allocation.

Run the reusable provider contract suite plus integration checks for target cwd,
argv boundaries, output, filesystem effects, denied host access, denied network,
timeouts, cancellation of descendants and resource cleanup. Verify two sessions
use distinct allocations. Distinguish bind-mounted workspace changes from
changes confined to the target. Verify no host environment secret is inherited
using a synthetic sentinel value.

Prefer a Linux CI job with a known Docker daemon for this integration. A
provider test that lacks its runtime must be visibly skipped with a reason, not
reported as passed. The release gate requires at least one successful
real-provider run; unit tests and fake transport results alone are insufficient.

Finish the provider and consumer examples, including the same consumer running
against both test providers and the reference backend. Document package loading,
explicit selection, policy, workspace mapping, unsupported operations, cleanup,
SDK host shutdown and the distinction between direct SDK calls and Pi tool
hooks. Check the instructions in a clean temporary project.

Exit criterion: extension authors can implement and consume a provider from the
published contracts, with reproducible evidence from a real backend.

## 7. Verify packaging and prepare release

Keep the scaffold's `build`, `check:types`, `check:lint`, `check:format`, `test`
and `check` scripts, and add `test:integration` and `test:provider`. `check`
runs ordinary deterministic gates; the real-provider job is an explicit
additional CI gate. A build emits SDK JS/declarations and the extension files.
Do not introduce tests solely to mirror a trivial implementation detail.

Run `pnpm pack --dry-run`, then install the actual tarball into a temporary
provider/consumer project. Verify all export paths, declarations, Pi manifest
paths and optional adapter loading. Include separate dependency roots, because
workspace deduplication can hide an SDK-singleton bug. Confirm that development
files, credentials and local test state are absent from the tarball.

Verify manifest dependency relationships in those clean installs: a consumer or
provider supplies the framework as a normal dependency; host Pi packages resolve
through the supported host setup; production `/api` use does not require Vitest;
and `/testing` uses the provider author's supported Vitest installation. None of
these cases may require a separate SDK or broker package installation.

Test Pi 1.4.0 as the supported baseline. Add another Pi version to the support
matrix only after running the same integration cases. Treat upstream tool-schema
or lifecycle changes as compatibility work, especially grep/path resolution and
output spooling. A permissive host peer declaration is not evidence of support
for every Pi version.

Review all newly public APIs and comments against the repository instructions.
Put change rationale in commit messages; comment only on constraints that the
code cannot show. Inspect the repository's commit history before committing.
Keep implementation commits reviewable by following the stages above; do not
publish packages or modify personal Pi settings as part of local validation.

Exit criterion: all specification acceptance criteria have linked test evidence,
the tarball loads in a clean Pi setup, and remaining platform/provider limits
are explicit in release documentation.
