# Testing a provider

Run the conformance suite from `/testing` in provider CI. The suite registers
the provider with the real broker, supplies a live test session and exercises
the public consumer, review and host operations. Calling a provider factory
directly cannot establish conformance. The [specification][spec] defines what
each profile promises.

[spec]: specification.md

## What the provider author supplies

Supply the provider declaration, configuration and a temporary host workspace
with separate checkout and copy source markers. Supply independent probes for
the declared profiles:

- A process observer checks whether a command and its descendants stop.
- A network listener records connection attempts to a reachable fixture.
- Host user-data and system-file markers distinguish host access from
  provider-owned runtime files.
- An allocation inspector reports live resources and verifies their removal.
- Transport fault injection can interrupt opening, mutation or disposal. The
  inspector verifies recovery independently of the transport.
- A verifier checks host and target files, including aliases, from outside the
  backend under test.

The suite supplies the broker and Pi session. If a probe cannot observe an
advertised property, setup fails for the corresponding case family.

Pass a provider in the suite options or return it from `createFixture`. When the
suite selects a profile, `createFixture` receives the profile and acquisition
mode. Use them to seed the right workspace and supply the policy for that case.
`verifyDisposed` receives the raw backend and its recovery descriptor. The
backend is absent if the provider failed before returning it.

## Search engines

Supply `rg` inside the target for full ripgrep semantics. The portable helper
uses descriptor-relative traversal on Linux. To enable portable search on
Darwin, call `targetSearchHelper({ sameConfinementAsCommands: true })` and run
the returned program inline through the ordinary command launcher. The helper
must run with exactly the same authority as those commands. The program includes
its matcher, so the launcher needs no additional mounts or file access
exceptions. Test the portable helper and `rg` on the same corpus, using the
[specification][search] for expected results.

[search]: specification.md#grep

## Shared settings conformance

Supply `register(pi, extensionSource)` on the fixture to install the shipped
provider in an isolated Pi runtime. If the provider reads settings, also supply
`stageSettings(shared)`. Write the supplied [shared settings][settings] beside
the provider-specific values in a test settings file. For a custom agent
directory, pass the directory to `initialiseSandboxHost` during registration.
The suite checks valid input, defaults and an invalid value for every shared
key. Each invalid file must fail with `InvalidSandboxConfigError` before backend
allocation.

For a fixed preset, use its registration path and omit `stageSettings`. The
suite verifies the configured policy against the fixture's policy.

[settings]: api-protocol.md#provider-settings

## Generate cases from declarations

Generate cases for every declared `open` and `copy` profile, including every
capability, process kind and shell dialect in each profile. Negotiate through
the broker and confirm the chosen profile before invoking operations. Fail suite
setup if the fixture cannot select a declared profile or if any declared
capability lacks cases. Run each case against an isolated fixture. Use
independent observations of target effects, live files, processes and provider
resources. A backend's own declaration cannot prove enforcement.

The suite checks workspace visibility and read-grant eligibility for each live
checkout profile. It checks placement and reads the granted file when the
profile offers file reads. Otherwise the grant must fail before allocation.
Supply `fixture.visibility` for each open profile. The suite also checks
special-file refusal for every live-checkout profile on hosts with FIFOs. Omit
`workspaceVisibility` and `capabilities` to generate the full suite from the
declaration. Use `workspaceVisibility` to focus a suite on shared or copied
checkout behaviour. The test runner labels focused suites as partial.

## Default configured policy

Omit the policy and check the SDK defaults for live checkout writes, host user
data, host system files, network and escalation. Use a provider that supports
all defaults and another that cannot supply a default setting. Check that the
broker narrows only the unsupported access and never exceeds the SDK default.
Verify that ordinary Pi tools and SDK consumers negotiate from the same
configured policy.

## Credential exclusions

For every profile that permits host user data reads, create one case per
[credential location][credentials]. Use a disposable host home with synthetic
markers outside the checkout. Put an ordinary marker under a readable [toolchain
root][toolchain-roots] and put another outside every readable root. Verify that
the default permits the first read and denies the second. Check that a
configured read root permits the second read.

Place synthetic credential markers under an allowed directory and check that
reads fail through the original paths and their aliases. A read-write profile
must also refuse writes to those markers. The suite locates the markers under
`workspace.hostUserDataRoot`. Override Pi's agent directory and verify that both
Pi credential files are excluded at the effective paths.

For a read-only profile, attempt writes to the ordinary marker and the
credential marker through the file API. If the profile omits `files.write`, the
SDK must refuse the writes with `UnsupportedSandboxCapabilityError`. Otherwise,
the provider must refuse access to both paths. Check the host files directly to
confirm that both retain their original contents.

Check that an ordinary path request for each marker fails before allocation. A
property-only escalation keeps the exclusion in the provider. Exercise a
separate decision for an escalation that grants a credential path.

[credentials]: specification.md#credential-locations
[toolchain-roots]: specification.md#default-toolchain-roots

## Paired access cases

For each access property, use the same configured policy and other request
fields. Negotiate omitted, `needed` and `prevented` states through the broker,
for ordinary opens and copies. Check that omission and a satisfied need use the
least restrictive eligible value. A need beyond the limit and a restriction that
the provider cannot enforce fail before allocation. Compare granted access at
the target for requests that differ in one property.

| Case family           | `prevented`                                                                                                                                                                    | `needed`                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `hostWorkspaceWrites` | Attempt checkout writes through shell and file operations, including an alias. Inspect the checkout independently and check that contents and directory entries are unchanged. | Edit a file and verify the live checkout changed. Verify that a copy cannot satisfy the need.           |
| `network`             | Try to connect to a reachable fixture endpoint. Assert connection failure and no received request.                                                                             | Connect and assert the endpoint receives the request.                                                   |
| `hostUserData`        | Attempt to read and write fixture user data outside the checkout, including a credential marker and a path alias. Assert failure, no leaked bytes and no host changes.         | Read a user-data marker. Verify that the result matches the configured policy and provider support.     |
| `hostSystemFiles`     | Attempt to read and write a host system fixture and its aliases. Assert failure while provider-owned runtime files remain usable.                                              | Run an installed host tool or read a host system fixture. Check that the result originates on the host. |

Fixtures that cannot expose the allowed side of a property still test the denial
and the controlled failure case. Use a broker fixture with both profiles to test
the paired selection rule independently of the provider.

For live checkouts, prepare a checkout with a socket or FIFO before opening.
Assert that the provider refuses to open it and allocates no resources.

## Workspace visibility

For a shared workspace, check that the host can read sandbox writes as soon as
the operation completes. Replace the host file by atomic rename and start a
fresh target process. File sharing can expose stale or partial content for up to
one second after the replacement completes. A read that starts after that window
must return the complete replacement.

For a polling process, add each read's start offset to the host dispatch time.
The process starts at or after dispatch, so the sum gives a lower bound for the
read's start time. For a fixture with a single-read command, retry across
executions and use the host dispatch time for each read.

## Path grants

Supply separate read and write markers and report where the granted paths appear
in the target. For an ordinary grant, verify a reachable path under the
configured policy. Try an unreachable path and a path beyond the limit. Assert a
typed error with the path and no backend allocation. Include a home-relative and
a workspace-relative path. Verify that a copy can require its own paths without
gaining host write access.

For escalation, generate cases from the declared extra path grant kinds. Check
additional read and write grants separately and verify the reported target paths
with independent target and host observations. Assert that unlisted paths remain
inaccessible and that an undeclared kind cannot be granted by that provider
profile. Include a grant of one host user file under a policy that denies the
rest of the home directory.

Exercise one-call and session approval for an eligible read path. Verify that a
session grant expires when the session ends. For a provider that supplies a
settings writer, check that **Always** appears under the configured read-only
policy and that a fresh session uses the saved root. Check that remembered
directory grants keep credential exclusions and that a specific credential read,
write grant or network grant requires a decision for each call. For an
undeclared credential grant kind, verify that the broker excludes the profile
before it chooses a destination and that no allocation starts.

## Broker and lifecycle cases

| Case family              | Operation and assertion                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Profile ordering         | Vary declaration order. Check hard requirements first. Compare omitted and needed settings within the configured policy and exercise the fixed property order when profiles differ on multiple properties.                                                                                             |
| Post-start profile check | Return a backend with a weaker policy, wrong workspace relationship, missing operation, weaker exit status or weaker termination scope. Assert failure before a consumer receives a handle, with disposal and recovery on failure.                                                                     |
| Copies                   | Put different markers in the checkout and the source destination. Negotiate a copy, assert no allocation, then open it and inspect which marker was copied. If the provider allows local writes, mutate the copy. Close the copy and verify that the source and any sibling copy are unaffected.       |
| Cancellation             | Cancel opening or a running workload by caller abort, deadline and shutdown. Observe processes independently. Assert termination within the declared scope and typed completion. Test a child that leaves its group when the scope covers the workload.                                                |
| Failed open cleanup      | Inject failure after allocation and before returning a backend. Inspect the resources independently. Assert no published handle, confirmed cleanup on success and bounded unconfirmed cleanup on timeout. Also test a backend that returns after cancellation.                                         |
| Recovery                 | Lose the transport during a mutation or disposal. Assert that the broker does not replay work, rejects reuse when the outcome is uncertain and reports the affected allocation and recovery instructions. Apply provider recovery and check that unrelated resources survive.                          |
| Forged replies           | Send malformed, unsolicited, cross-call and cross-session review replies, including replies that embed a runnable object. Assert that the reviewer's broker rejects them, allocates no copy and executes no workload. Verify that a valid identity resolves only for its pending call and destination. |

## Operation cases

- For `exec`, run every declared dialect and process kind. Check literal argv
  boundaries, target cwd, streamed bytes, capture limits, normal and non-zero
  exits, unavailable optional status, and the declared termination scope.
  Distinguish a failed launch from a command that exits with code 127. Give the
  host environment a fixture marker and verify that an external provider
  receives neither the marker nor credentials implicitly. Check that explicit
  overrides set and delete target values. Use a fixture shell startup hook such
  as `BASH_ENV` or `ENV` and a substitute shell on the target `PATH`. Check that
  the target honours documented environment behaviour while those values never
  change the transport bootstrap or its output boundary.
- For file capabilities, run the same fixture across providers. Compare whole
  read, stat and list results, access errors and the effects of writes. Queue
  two writes and verify that the second waits for the first. Point a symlink at
  a marker outside the allowed target tree. Check that read and write attempts
  fail and that the marker stays unchanged.
- For search capabilities, run identical fixtures across providers. Compare the
  complete result fields for the same supported glob or regex, including paths,
  line numbers, context and truncation. Normalise provider-defined result order.
  Check missing roots, cancellation and results at the limit.
- If the provider declares copy profiles, run the copy case family and the
  operation cases for each copy profile.
- For diagnostics, report valid warnings, invalid and oversized messages and
  more warnings than the generation can retain. Assert that warnings stay out of
  stdout and stderr, the count and message bounds apply and `diagnosticsDropped`
  records rejected messages.

Run real backend probes on the platforms where the provider claims support.
Broker fixtures test rejection and interoperability. The real backend probes
establish runtime effects. See the [validation guide][validation] for the
repository's suite commands.

[validation]: validation.md
