# Pi integration

Install the sandbox provider in Pi and follow its settings instructions. The
provider activates the sandbox and loads the Pi tool integration.

In the provider extension factory, call the default export from `/pi-tools` with
the Pi extension API and the provider's module filename. The integration routes
Pi's shell, file and search operations through the sandbox facade.

## Tool routing

Pi's `bash`, `user_bash`, file and search tools omit the access record for
ordinary acquisition. They use the [shared negotiation rule][negotiation] and
receive the configured policy within the provider's support. A read-only
checkout remains available for reads.

The integration preserves Pi's selected tools, explicit allowlists and tool
modifiers. Pi owns input validation, tool permission hooks, rendering and output
storage. The shell adapter runs `bash` in the target Bash dialect. The
user-shell handler uses `userShell` or the provider's default shell. Available
dialects come from the selected profile. The file and search adapters share the
same workspace as Bash and fail with a typed reason if a capability is
unavailable. The [adapter guide][adapters] describes how Pi and the SDK share
the work.

Pi applies its shell command prefix in the target. Full output files stored by
Pi remain on the Pi host. Access from the sandbox depends on its policy. Direct
SDK calls follow the [execution contract][spec]. They bypass Pi's tool
permission hooks because they are not Pi tool calls.

Pi 1.5.0 strips ANSI sequences and removes most C0 controls in `getTextOutput`
(`core/tools/render-utils.js`, lines 51 to 56) and `executeBashWithOperations`
(`core/bash-executor.js`, lines 38 to 40). Pi also recognises complete 8-bit CSI
sequences. DEL, unmatched C1 controls and some bidirectional and invisible
characters still reach the display. BYOS escapes those characters in output from
routed Bash, PowerShell and user-shell operations. This includes the 8-bit CSI
introducer U+009B. BYOS preserves 7-bit ANSI sequences and C0 controls for Pi to
handle.

Loading the integration does not control competing handlers registered by other
extensions. Use an [outer sandbox][outer] to confine Pi, its extensions and
local MCP servers.

[negotiation]: specification.md#configuration-and-negotiation
[adapters]: pi-file-adapters.md
[spec]: specification.md#execution-and-capabilities
[outer]: outer-runtime.md

## Escalation and model descriptions

<!-- `escalate`, `allowEscalation` and `violations` are provisional. -->

A `bash` call can request extra access with `escalate` and a justification. For
example, it can request network access and permission to read one configuration
file. The provider's `allowEscalation` setting controls whether this request is
available. The [escalation rules][escalation] define how the broker selects a
destination. If no provider profile grants the request, the proposed destination
is the host, with no effective restrictions.

The confirmation identifies the provider by its label and shows the command,
justification, requested access and paths, destination and restrictions. A
permission extension can record its decision for that pending call. The
integration then uses the recorded verdict. The model sees effective
restrictions from the policy and path grants. Provider `violations` appear
separately from command output.

The system prompt describes the effective host user data policy and roots.
`/byos status` shows the policy mode. Read-only and read-write access apply
under the [toolchain roots][toolchain-roots] and the provider's configured read
roots. [Credential exclusions][credentials] take precedence. Access to a
specific credential path requires approval for each call.

Eligible read grants can apply to the current call, the session or **Always**.
The prompt defaults to the current call. **Always** records the path in the
provider's configured read roots. Directory grants keep credential exclusions.
Write and network grants apply only to the current call.

[credentials]: specification.md#credential-locations
[escalation]: specification.md#escalation
[toolchain-roots]: specification.md#default-toolchain-roots

## Permission review

With a sandbox active, configure pi-permission-system to allow ordinary
sandboxed commands. BYOS asks when a call requires access beyond the ordinary
policy, whether the call uses an expanded provider profile, an extra path grant
or host execution. A matching remembered read grant or an existing decision from
a permission extension avoids a second prompt.

Pi awaits `tool_execution_start` before running the `tool_call` permission
hooks. BYOS records the pending call at the earlier event. A permission
extension calls `findShellReviewSource` on a `/consumer` client with the tool
call ID. The review route supplies an identity and the reviewer's broker
resolves it. The resulting source describes the destination and lets the
reviewer negotiate or create a copy. The original workload remains pending. For
an escalation, the source also describes the chosen destination and effective
restrictions. A permission extension calls `recordEscalationDecision` on the
same client to decide the call before dispatch.

The pi-permission-auto-review extension can show investigation only when copy
negotiation succeeds. An unavailable route includes a typed reason. The
extension must inspect copy cleanup and report unconfirmed disposal. See the
[review contract][review] for isolation and lifetime.

[review]: specification.md#copies-and-review

## Session ledger

<!-- `/byos log` is provisional. -->

Use `/byos log` to inspect escalation decisions, review copies and reported
violations for the current Pi session. Pass a tool call ID to filter the
[ledger][ledger].

[ledger]: specification.md#ledger

## Extension load order

Pi 1.5.0 loads extensions in this order.

1. Extensions passed with `-e`.
2. Project `extensions` settings entries, then `.pi/extensions/` in the project.
3. Personal `extensions` settings entries, then `~/.pi/agent/extensions/`.
4. Project packages, then personal packages, each in settings array order.
5. Built-in extensions.

`pi install` appends new packages to the relevant `packages` array. The review
route works whichever extension loads first because Pi awaits
`tool_execution_start` before invoking permission hooks.
