# Pi integration

The target `/pi-tools` entry routes Pi's shell, file and search tools through
the BYOS facade. Load it explicitly. The SDK is a dependency and Pi does not
load a default extension from it. From a trusted directory outside the
workspace, add a `sandbox-tools.ts` extension and load the file with Pi's `-e`
option.

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import sandboxTools from 'pi-bring-your-own-sandbox/pi-tools';

export default function extension(pi: ExtensionAPI): void {
  sandboxTools(pi, import.meta.filename);
}
```

## Tool routing

Pi's `bash`, `user_bash`, file and search tools use ordinary acquisition. They
set `network`, `hostWorkspaceWrites`, `hostUserData` and `hostSystemFiles` to
`preferred` and use the [shared negotiation rule][negotiation]. A configured
read-only checkout stays read-only, and acquisition succeeds.

The integration preserves Pi's selected tools, explicit allowlists and tool
modifiers. Pi owns input validation, tool permission hooks, rendering and output
storage. The shell adapter runs `bash` in the target Bash dialect. The
user-shell handler uses `userShell` or the provider's default shell. Available
dialects come from the selected profile. The file and search adapters share the
same workspace as Bash and fail with a typed reason if a capability is
unavailable. The [adapter guide][adapters] specifies the required delegation and
acceptance cases.

Pi applies its shell command prefix in the target. Full output files stored by
Pi remain on the Pi host. Access from the sandbox depends on its policy. Direct
SDK calls follow the [execution contract][spec]. They bypass Pi's tool
permission hooks because they are not Pi tool calls.

Loading the integration does not control competing handlers registered by other
extensions. Use an [outer sandbox][outer] to confine Pi, its extensions and
local MCP servers.

[negotiation]: specification.md#configuration-and-negotiation
[adapters]: pi-file-adapters.md
[spec]: specification.md#execution-and-capabilities
[outer]: outer-runtime.md

## Model descriptions and outside execution

<!--
`bash_outside`, `outsideApproval`, `outsideDestinations` and `violations`
are provisional in milestone 1.
-->

The integration describes the effective restrictions of each destination to the
model, using a description generated from the negotiated policy. Providers that
support `violations` can attach structured policy violations to results. BYOS
renders these separately from command output.

The separate `bash_outside` tool takes an `access` record and a justification.
The user's trusted host extension sets `outsideDestinations` and
`outsideApproval` with `initialiseSandboxHost` from `/host`. It can enable
profiles declared by the selected provider or explicitly enable passthrough.
When a permission extension decides the call, add a rule for that tool. A rule
for `bash` does not approve it. With the default BYOS confirmation, the user
sees the negotiated destination and the exact command before dispatch. See the
[destination rules][destinations] and [tool arguments][api].

[destinations]: specification.md#destinations-and-permission
[api]: api-protocol.md#outside-tool-and-review

## Permission review

Pi awaits `tool_execution_start` before running the `tool_call` permission
hooks. BYOS records the pending call at the earlier event. A permission
extension uses `/review` to request the source for that tool call ID. The review
route supplies an identity and the reviewer's broker resolves it. The resulting
source describes the destination and lets the reviewer negotiate or create a
copy. The original workload remains pending.

The pi-permission-auto-review extension can show investigation only when copy
negotiation succeeds. An unavailable route includes a typed reason. The
extension must inspect copy cleanup and report unconfirmed disposal. See the
[review contract][review] for isolation and lifetime.

[review]: specification.md#copies-and-review

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
