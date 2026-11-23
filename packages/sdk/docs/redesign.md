# Redesign plan

This plan brings the SDK, the Docker and MXC providers, and the
pi-permission-auto-review consumer into line with the [design
principles][principles]. It records the decisions behind the redesign, the
target design, and the work in each repository. Delete this file when the
redesign is complete.

[principles]: principles.md

## Decisions

- Consumers pass one `access` record. Its properties are `network`,
  `hostWorkspaceWrites`, `hostUserData` and `hostSystemFiles`. A property marked
  `prevented` is a restriction. A property marked `needed` is a need.
  `preferred` requests access when available. An omitted property gets the most
  restrictive setting that the provider supports. Passthrough supports only full
  access, so omission prevents nothing there and a restriction fails before
  allocation.
- One [negotiation rule][negotiation] applies to acquisition, copy, guard and
  outside destination selection.
- Set `hostWorkspaceWrites` to `needed` to work on the user's live files. Set it
  to `prevented` to prevent changes to the host checkout. Private workspaces
  exist only through `copy`. The provider decides whether writes to a copy are
  allowed. The workspace relationship is part of the workspace.
- Pi's shell, file and search tools mark all access properties `preferred`. The
  tools use the live checkout, which may be read-only. Project trust selects
  neither the workspace nor the policy.
- Providers declare profiles separately for `open` and `copy`. A profile is a
  combination of policy settings with the capabilities, exit status and
  termination scope that hold under it. Negotiation chooses a profile before
  anything is allocated.
- Workspace protection leaves the contract. `workspaceProtection`, the
  `workspace.protection` capability and the related validation are removed. The
  provider kit contains a default list of protected paths and a matcher, and
  providers expose protection in their own settings.
- One protocol, with a major number and a feature level. Changes within a major
  number are additions only. Offers are reduced to the shared level and demands
  above it fail. The broker is created after all extensions have loaded, by the
  build with the highest feature level. `serviceVersions`,
  `configurationVersion`, `guardVersion`, the `v2` channel name and every
  compatibility branch for older brokers are removed. The first release of the
  redesign is major 1, level 0.
- BYOS does not run its own approval system. The approval-policy registry, its
  channels and the built-in `user`, `always` and `never` policies are removed.
- Running outside the selected sandbox uses a separate Pi tool, registered next
  to the sandboxed `bash`, so a permission extension can give it its own rules.
  The tool takes an `access` record and a justification. BYOS negotiates the
  destination using the shared rule. Access can exceed the ordinary configured
  policy only at a destination that the user's configuration allows. A
  configuration setting decides who approves these calls: BYOS itself (the
  default, which asks the user) or the permission extension (BYOS runs the call
  once it reaches execution).
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
  `/review`, `/pi-tools`, `/guard` and `/testing`. The guard package folds into
  the SDK. The Docker provider moves to `packages/provider-docker`.
- The SDK provides a provider kit: argv encoding over a POSIX shell, a process
  runner with process-group termination and a hook for wrappers, file and search
  helpers that run inside the sandbox, errno mapping, cleanup budgets in the
  request, an extension wrapper that turns factory errors into configuration
  errors, and copy-source resolution.
- The conformance suite runs providers through the real broker, generates cases
  from each provider's declared profiles and capabilities, and covers copies,
  cancellation, cleanup after a failed open and recovery.

[negotiation]: specification.md#configuration-and-negotiation

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
   advertisements and `/byos status`, and broker creation after load by the
   highest build.
4. Policy model: access record, profiles for `open` and `copy`, one negotiation
   function, decisions before allocation, removal of workspace protection and of
   the relationship from the policy, and errors with structured detail.
5. Outside execution and model feedback: removal of the approval system, the
   separate outside tool, escalation through the access record, the approval
   setting, the policy description for the model, and the violation capability.
6. Review route: identity replies, copies through the reviewer's broker,
   negotiation without allocation, typed reasons and a destination description.
7. Surface: audience entry points, a committed public API report, import
   boundary lint, the guard folded in, and Docker moved to its own package.
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
2. After SDK milestones 4 to 6: access record, the review route's identities and
   typed reasons, offering investigation only when a copy can be negotiated, the
   destination description in the review prompt, and reviewing the outside tool
   as its own tool.
