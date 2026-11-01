# pi-bring-your-own-sandbox

A Pi extension framework under development. Provider extensions supply a sandbox
and consumer extensions use a common execution API.

The SDK works without sandbox setup: built-in `passthrough` executes on the host
by default and follows a user's separately configured sandbox provider when
present. A configured sandbox failure never switches to host execution.

`/api` exports provider registration, shared sandbox acquisition, typed errors
and explicit session cleanup. Consumers use the SDK without loading the broker
extension separately. The built-in host backend implements filesystem operations
and POSIX foreground execution with process-group cancellation. Host search uses
installed fd and ripgrep executables. Windows host process-tree cancellation is
unsupported. Optional `/pi-tools` integration connects shell-operation hooks
while Pi keeps its tool algorithms and output handling. File/search routing
needs upstream Pi extension points.

The default extension provides `/byos status` and `/byos providers`. These
commands inspect metadata without opening a backend or changing active tools.
The following documents specify the contract and record its validation:

- [Validation record][validation]: acceptance evidence, reproducible gates and
  supported platform/integration boundaries.
- [User-flow coverage][user-flows]: integration evidence for supported entry
  points, approval decisions, lifecycle and diagnostics.
- [Specification][spec]: scope, contracts, discovery, lifecycle, execution and
  integration through public Pi operation hooks.
- [Implementation plan][plan]: staged work, tests and release criteria.
- [API/protocol appendix][api]: structural declarations, byte ownership and
  versioned discovery semantics.
- [Research][research]: verified Pi APIs, source references and exploratory
  results from Pi 1.4.0.
- [Adversarial review][review]: findings from three independent reviews and the
  resulting design changes.

[validation]: docs/validation.md
[user-flows]: docs/user-flow-coverage.md
[spec]: docs/specification.md
[plan]: docs/implementation-plan.md
[api]: docs/api-protocol.md
[research]: docs/research.md
[review]: docs/review.md

## Optional Pi integration

Load the shell integration explicitly from a project extension:

```typescript
export { default } from 'pi-bring-your-own-sandbox/pi-tools';
```

Bash, PowerShell and user shell commands use the selected provider. Pi file and
search tools retain their own execution paths. See the [coverage
table][coverage] for supported hooks, tests, host transcript storage and
upstream gaps.

[coverage]: docs/pi-integration.md

## Provider contract tests

The optional `/testing` entry exports `defineSandboxProviderTests`. Provider
authors supply target probes and independent checks for cancellation, policy and
cleanup. The suite uses the provider project's Vitest installation. See the
[provider testing guide][testing] for the fixture contract and coverage.

[testing]: docs/provider-testing.md

## Consumer example

The [consumer guide][consumer] shows a Pi tool that calls the SDK with the live
context and per-tool cancellation signal. The same helper runs with default
passthrough, both provider fixtures and Docker. Consumer projects install the
framework as a normal dependency.

[consumer]: examples/consumer/README.md

## Docker reference provider

An optional [Docker example][docker] implements argv and POSIX shell execution
with a copied workspace volume, unprivileged target commands, denied network
access and confirmed container removal. It uses the public provider API.
`pnpm test:provider` runs its separate daemon-backed integration gate.

[docker]: examples/docker/README.md

## Development

Use Node 24.22.2 and pnpm 12.15.0. Deno and pre-commit are also needed to run
the commit hooks. Native search tests require fd (`fdfind` on Debian) and
ripgrep. The backend advertises only installed search tools and does not
download them. The private scaffold pins Pi 1.4.0 for development and peer
compatibility; broader host compatibility is not yet tested.

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
pnpm build
pnpm test:package
```

Try the source extension without changing Pi settings:

```sh
pi --no-extensions -e ./src/extension.ts
```

Run `/byos status` or `/byos providers`. Both commands produce displayable Pi
messages in TUI and headless sessions. The package manifest loads
`dist/extension.js` after a build. `pnpm test` checks both source and compiled
loading with Pi's actual extension loader, without model credentials.

Tooling follows the sibling repositories: pnpm and typed ESLint with Unicorn and
import sorting from Identify/Cupboard; Prettier, Markdownlint and EditorConfig
from Cupboard; SHA-pinned pre-commit and Wrapscallion hooks from
Identify/Wrapscallion. `pnpm check` runs formatting, dependency usage, lint,
Markdown, loader tests and type checks. `pnpm fix` applies ESLint and Prettier
fixes. GitHub Actions runs checks/builds, workflow lint and commit-message lint.

`pnpm test:package` packs the build and installs the tarball into separate
temporary consumer and provider projects. It checks declarations, Pi loading,
shared broker discovery across SDK copies and the provider's own Vitest peer.
The gate installs dependencies with lifecycle scripts disabled and removes its
temporary projects afterwards. It runs separately from the ordinary checks.

## Execution approvals

The framework provides user prompting, always-allow and never-allow policies.
Extensions can register other approval policies independently of sandbox
providers. SDK consumers and Pi Bash/PowerShell tools can request explicit
execution outside the sandbox. Personal configuration selects the approval
policy and execution destination independently.

See [approval and outside execution][approval-execution] for configuration,
provider capabilities, SDK calls and lifecycle guarantees.

[approval-execution]: docs/approval-execution.md
