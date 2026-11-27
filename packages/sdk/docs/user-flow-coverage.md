# Integration coverage of user flows

The table specifies the evidence required for the redesign. The linked suites in
this checkout are starting points for the later milestones. Run
`pnpm test:integration` for Pi sessions and CLI/RPC flows. The [validation
guide][validation] lists the separate package and provider gates.

[validation]: validation.md

## Host and configuration

| User flow                                         | Integration case                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install a consumer without selecting a provider.  | Acquire passthrough with no diagnostics extension loaded. With an omitted property, assert full access. Set it to `prevented` and assert rejection before allocation. Exercise both source and archive fixtures. |
| Select a provider independently of consumers.     | Load different SDK builds as provider, consumer and host. Vary extension order and assert the same broker, provider and policy selection.                                                                        |
| Discover an incompatible build.                   | Verify that older peers reduce offers, reject newer demands, and identify both builds and extensions on a major mismatch.                                                                                        |
| Fail to configure or start the selected provider. | Check typed diagnostic detail and verify that the host executes no workload. Assert that diagnostics allocate nothing.                                                                                           |
| Load a preset that the provider ships.            | Verify that the entry point uses its default policy. Reject incompatible requirements before allocation.                                                                                                         |
| Inspect or reload a session.                      | Check build identity in status, new generations after reload, and rejection of cached facades after close. Verify cleanup reports through the real shutdown path.                                                |

Extend the [broker][broker], [Docker provider][docker-provider] and
[diagnostics][diagnostics] suites for these cases.

[broker]: ../src/broker-integration.test.ts
[docker-provider]: ../../provider-docker/test/provider-unit.test.ts
[diagnostics]: ../src/diagnostics-integration.test.ts

## Tools and permission

<!-- `escalate`, `allowEscalation` and `/byos log` are provisional. -->

| User flow                                      | Integration case                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run Bash or a user shell command.              | Use Pi model dispatch and CLI/RPC `user_bash`. Inspect target effects, cancellation, prefixes, explicit allowlists and output storage.                                                                                                               |
| Edit files through the selected provider.      | Route `write`, `edit`, `read` and searches through the same workspace as Bash. Grant live write access when the policy and provider allow it. Repeat with a read-only policy. Acquisition succeeds, writes fail and the host marker stays unchanged. |
| Show effective restrictions.                   | Compare the model description with the negotiated destination.                                                                                                                                                                                       |
| Request `bash` with `escalate`.                | Exercise an added property and a path grant. Check the provider profile, then test the host destination when no provider profile can satisfy the request. Verify that the decision input and ledger both describe the unrestricted host.             |
| Turn off escalation.                           | Set `allowEscalation` to false. Assert a typed refusal, no prompt, no workload allocation and a ledger entry attributed to the configuration.                                                                                                        |
| Decide an escalation.                          | Count prompts with and without a recorded permission extension verdict. Verify that the broker dispatches exactly the reviewed command and destination after allowance and records the decision before execution.                                    |
| Deny, dismiss, cancel or expire an escalation. | Exercise Pi RPC confirmation and inspect target effects. Assert the outcome in the ledger and no dispatch. Cancel or expire before a decision and assert that the entry has no decider.                                                              |
| Inspect `/byos log`.                           | Verify typed records for every escalation path, and review copy. Filter by tool call ID and check that the command lists only the current session.                                                                                                   |
| Investigate a pending call.                    | Load the permission gate before and after the route. Query by tool call ID, negotiate without allocation and make a copy through the reviewer's broker. Assert typed unavailability for forged or stale identities and verify cleanup.               |

Extend the [shell][shell], [user-shell RPC][user-rpc] and [copy][copy] suites.
Use local model and permission fixtures. Terminal drawing and literal
interactive `!` and `!!` parsing are Pi's responsibility. The [integration
guide][pi] describes the boundary for tool routing.

[shell]: ../src/pi-tools-integration.test.ts
[user-rpc]: ../src/user-shell-rpc.test.ts
[copy]: ../src/copy-integration.test.ts
[pi]: pi-integration.md

## Real provider effects

The [Docker session suite][docker] checks model dispatch and target effects with
a real daemon. Expand it to cover the declared open and copy profiles, read-only
and writable live mounts, cleanup and recovery. The [provider testing
guide][testing] defines the generated case families and independent probes.

[docker]: ../../provider-docker/test/session.test.ts
[testing]: provider-testing.md
