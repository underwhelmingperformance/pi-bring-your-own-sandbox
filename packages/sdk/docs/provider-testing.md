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

## Shared settings conformance

Run the provider's settings parser through its registration path. Supply a valid
file with every [shared settings key][settings] and the required
provider-specific settings. Assert that the parser preserves the shared values
and that the broker uses them. Omit settings that have defaults and check the
effective values. Then invalidate one shared key at a time. Include an omitted
policy if the provider has no default. Each invalid file must fail with
`InvalidSandboxConfigError` before backend allocation. Use the same parser that
the provider runs in Pi.

[settings]: api-protocol.md#provider-settings

## Generate cases from declarations

Generate cases for every declared `open` and `copy` profile, including every
capability, process kind and shell dialect in each profile. Negotiate through
the broker and confirm the chosen profile before invoking operations. Fail suite
setup if the fixture cannot select a declared profile or if any declared
capability lacks cases. Run each case against an isolated fixture. Use
independent observations of target effects, live files, processes and provider
resources. A backend's own declaration cannot prove enforcement.

## Paired access cases

For each access property, use the same configured policy and otherwise identical
options. Negotiate and exercise omitted, `needed`, `prevented` and `preferred`
through the broker. Run the cases for ordinary opens and copies. Copy cases use
a broker-resolved source. If two requests succeed, assert that only the related
property differs. When that change is impossible, assert typed preflight failure
and zero allocations. Deny each needed property in configured policy and check
the same rejection. For omission, assert that the broker chooses the most
restrictive setting that the provider supports within the configured policy. For
a preference, supply a profile that grants access and one that denies it. When
the configured policy allows both, assert that the broker grants access. Repeat
with only the denying profile, and with a configured policy that denies the
preference. Both cases must succeed with the property denied.

| Case family           | `prevented`                                                                                                                                                                    | `needed`                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `hostWorkspaceWrites` | Attempt checkout writes through shell and file operations, including an alias. Inspect the checkout independently and check that contents and directory entries are unchanged. | Edit a file and verify the live checkout changed. Verify that a copy cannot satisfy the need.           |
| `network`             | Try to connect to a reachable fixture endpoint. Assert connection failure and no received request.                                                                             | Connect and assert the endpoint receives the request.                                                   |
| `hostUserData`        | Attempt to read and write fixture user data outside the checkout, including a credential marker and a path alias. Assert failure, no leaked bytes and no host changes.         | Read a user-data marker. Assert a write is denied if the profile permits only reads.                    |
| `hostSystemFiles`     | Attempt to read and write a host system fixture and its aliases. Assert failure while provider-owned runtime files remain usable.                                              | Run an installed host tool or read a host system fixture. Check that the result originates on the host. |

Fixtures that cannot expose the allowed side of a property still test the denial
and the controlled failure case. Use a broker fixture with both profiles to test
the paired selection rule independently of the provider.

## Broker and lifecycle cases

| Case family              | Operation and assertion                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Profile ordering         | Vary declaration order and check that hard requirements filter profiles first. Give one profile more preferences and another the first preference in the fixed order. Assert that the higher count wins. Use an equal count to check the property tie-break.                                           |
| Post-start profile check | Return a backend with a weaker policy, wrong workspace relationship, missing operation, weaker exit status or weaker termination scope. Assert failure before a consumer receives a handle, with disposal and recovery on failure.                                                                     |
| Copies                   | Put different markers in the checkout and the source destination. Negotiate a copy, assert no allocation, then open it and inspect which marker was copied. If the provider allows local writes, mutate the copy. Close the copy and verify that the source and any sibling copy are unaffected.       |
| Cancellation             | Cancel opening or a running workload by caller abort, deadline and shutdown. Observe processes independently. Assert termination within the declared scope and typed completion. Test a child that leaves its group when the scope covers the workload.                                                |
| Failed open cleanup      | Inject failure after allocation and before returning a backend. Inspect the resources independently. Assert no published handle, confirmed cleanup on success and bounded unconfirmed cleanup on timeout. Also test a backend that returns after cancellation.                                         |
| Recovery                 | Lose the transport during a mutation or disposal. Assert that the broker does not replay work, rejects reuse when the outcome is uncertain and reports the affected allocation and recovery instructions. Apply provider recovery and check that unrelated resources survive.                          |
| Forged replies           | Send malformed, unsolicited, cross-call and cross-session review replies, including replies that embed a runnable object. Assert that the reviewer's broker rejects them, allocates no copy and executes no workload. Verify that a valid identity resolves only for its pending call and destination. |

## Operation cases

<!-- `violations` is provisional in milestone 1. -->

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
  two text edits and verify that the second reads the first result. Check that
  an unsuccessful transform leaves the file unchanged. Point a symlink at a
  marker outside the allowed target tree. Check that read and write attempts
  fail and that the marker stays unchanged.
- For search capabilities, run identical fixtures across providers. Compare the
  complete result fields for the same supported glob or regex, including paths,
  line numbers, context and truncation. Normalise provider-defined result order.
  Check missing roots, cancellation and results at the limit.
- For `copy`, run the copy case family and the operation cases for that copy's
  own declared capabilities.
- For `violations`, attempt an operation that policy denies. Assert that the
  provider reports the actual restriction in structured data and that the Pi
  adapter includes it separately from output.
- For diagnostics, report valid warnings, invalid and oversized messages and
  more warnings than the generation can retain. Assert that warnings stay out of
  stdout and stderr, the count and message bounds apply and `diagnosticsDropped`
  records rejected messages.

Run real backend probes on the platforms where the provider claims support.
Broker fixtures test rejection and interoperability. The real backend probes
establish runtime effects. See the [validation guide][validation] for the
repository's suite commands.

[validation]: validation.md
