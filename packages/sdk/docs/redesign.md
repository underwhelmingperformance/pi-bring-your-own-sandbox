# Redesign plan

This plan brings the SDK, the Docker and MXC providers, and the
pi-permission-auto-review consumer into line with the [design
principles][principles]. It records the decisions behind the redesign, the
target design, and the work in each repository. Delete this file when the
redesign is complete.

[principles]: principles.md

## Decisions

<!-- `allowEscalation` is provisional. -->

- Users install and configure their sandbox provider. The provider loads
  `/pi-tools` as part of its extension factory. All user settings, including the
  configured policy and `allowEscalation`, live in the provider's settings file.
  The SDK exposes the [shared settings schema][settings] through
  `registerSandboxProvider`. Provider conformance verifies that the parser
  accepts and validates those keys. The user sees BYOS only in diagnostics.
- Consumers use one access record for needs, restrictions and path grants. The
  configured policy is the default and the limit for ordinary requests. The
  [negotiation rule][negotiation] specifies profile ranking. Pi's ordinary tools
  omit the access record.
- The SDK defines the default configured policy. A provider may narrow it only
  where its profiles cannot support a setting. Passthrough stays unrestricted.
- The workspace relationship is part of the workspace. Ordinary opening uses the
  live checkout. Private workspaces exist only through `copy`. Providers decide
  whether writes to a copy are allowed. Project trust selects neither the
  workspace nor the policy.
- Providers declare profiles separately for `open` and `copy`. A profile is a
  combination of policy settings with the capabilities, exit status and
  termination scope that the provider supports together. The profile also
  declares support for extra read and write paths. Negotiation chooses a profile
  before allocation.
- Workspace protection leaves the contract. `workspaceProtection`, the
  `workspace.protection` capability and the related validation are removed. The
  provider kit contains a default list of protected paths and a matcher, and
  providers expose protection in their own settings.
- One protocol, with a major number and a feature level. Changes within a major
  number are additions only. Offers are reduced to the shared level and demands
  above it fail. The broker is created after all extensions have loaded, by the
  build with the highest feature level. BYOS removes the service-specific
  version fields, old channels and compatibility code for older brokers. The
  first release of the redesign is major 1, level 0.
- A `bash` call can request [escalation][escalation]. If `allowEscalation` is
  false, the broker rejects the request with a typed reason before prompting.
  Otherwise the broker chooses the provider profile with the least extra access
  that satisfies the request. If no provider profile can provide that access,
  the host is an unrestricted destination.
- BYOS confirms escalations unless a permission extension has recorded a
  decision for the pending call. BYOS has no approval-policy registry, approval
  channels or built-in approval policies.
- The ledger records escalations, outcomes, review copies and reported
  violations as typed Pi session entries. The diagnostics command can filter
  entries by tool call ID.
- The Pi integration describes the effective restrictions of each destination to
  the model. It generates the description from the negotiated policy. Providers
  can report sandbox violations as structured data through an optional
  capability, and BYOS appends them to the tool result.
- The review route replies with source identities. The reviewer resolves an
  identity through its own broker, can negotiate a copy without allocating it,
  and receives a typed reason when no source is available. The route records
  pending calls on `tool_execution_start`.
- The SDK routes Pi's file tools through the facade, so file tools and `bash`
  always use the same workspace. MXC's own file tools are retired.
- Entry points are split by audience: `/consumer`, `/provider`, `/host`,
  `/review`, `/pi-tools` and `/testing`. The Docker provider moves to
  `packages/provider-docker`.
- Providers ship presets as extension entry points with their own defaults in
  shared settings. Remove the user-written guard and the guard package.
- The SDK provides a provider kit: argv encoding over a POSIX shell, a process
  runner with process-group termination and a hook for wrappers, file and search
  helpers that run inside the sandbox, errno mapping, cleanup budgets in the
  request, an extension wrapper that turns factory errors into configuration
  errors, and copy-source resolution.
- The conformance suite runs providers through the real broker, generates cases
  from each provider's declared profiles and capabilities, and covers copies,
  cancellation, cleanup after a failed open and recovery.

[negotiation]: specification.md#configuration-and-negotiation
[settings]: api-protocol.md#provider-settings
[escalation]: specification.md#escalation

## Work

Each milestone ends with every repository check passing and with a review by the
integrator before the next milestone starts. Commits are small, have
conventional subjects, and follow the plain technical prose style. Behaviour
changes use red/green TDD.

### SDK

1. Align the documentation with the principles and this plan: the specification,
   the API and protocol appendix, the provider testing guide, the Pi integration
   guide, the validation guide, the user flow coverage, the READMEs and the
   Docker example's documentation. Remove the approval and workspace protection
   guides. The documents describe the target design.
2. Independent fixes: neutralise control characters in user-visible text, record
   review routes on `tool_execution_start`, and remove the unused exports that
   knip reports in production mode.
3. Protocol: one envelope, the runtime, provider and review channels, major
   number and feature level, a schema snapshot test, build identity in
   advertisements and `/byos status`, factory-bound consumer clients, and broker
   creation after load by the highest build.
4. Policy model: access record, profiles for `open` and `copy`, one negotiation
   function, decisions before allocation, removal of workspace protection and of
   the relationship from the policy, removal of the guard package, and errors
   with structured detail.
5. Escalation and model feedback: extend `bash` with an escalation request,
   including path grants. Decide once per call, record decisions in the ledger,
   and describe effective restrictions and reported violations to the model.
   Delete the legacy approval, approval-policy and outside-execution channels.
   Add a repository check for remaining legacy version fields and channel names.
6. Review route: identity replies, copies through the reviewer's broker,
   negotiation without allocation, typed reasons and a destination description.
7. Surface: audience entry points, a committed public API report, import
   boundary lint, and Docker moved to its own package.
8. Provider kit, conformance suite, and file-tool routing through the facade.

### MXC

1. Documentation corrections that do not depend on the SDK: installation order
   relative to permission extensions, how to load diagnostics, and the wording
   about which tools use the live checkout.
2. After SDK milestones 3 and 4: declare profiles, including guaranteed exit
   status only for profiles with the network denied, and move protection
   entirely into MXC's settings using the provider kit's list.
3. After SDK milestone 8: adopt the provider kit, run the conformance suite in
   CI, and retire MXC's own Pi file tools.

### pi-permission-auto-review

1. Corrections that do not depend on the SDK: the stale SDK pin note in
   `docs/codex-parity.md`, a footer that reports what the last review actually
   did, logging of unconfirmed copy closes, and the documented install order.
2. After SDK milestones 4 to 6: adopt the access record and review route
   identities, report typed unavailability, and offer investigation only when
   copy negotiation succeeds. Decide escalations, including path grants, and
   record the verdict through the SDK's decision function. Log each verdict and
   its reasoning under the tool call ID and add a command to list the decisions.
   Fix `targetPath` misclassification of paths such as `..notes`, keep
   `truncate()` within 32 KiB for multibyte text, and guard `setStatus` in
   `session_shutdown`.
