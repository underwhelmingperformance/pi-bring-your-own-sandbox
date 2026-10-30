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
installed fd and ripgrep executables. Windows process-tree handling and the
optional Pi integration remain implementation work. Integration must use public
operation hooks; missing Pi extension points remain upstream work.

The default extension provides `/byos status` and `/byos providers`. These
commands inspect metadata without opening a backend or changing active tools.
The design documents specify the remaining implementation:

- [Specification][spec]: scope, contracts, discovery, lifecycle, execution and
  integration through public Pi operation hooks.
- [Implementation plan][plan]: staged work, tests and release criteria.
- [API/protocol appendix][api]: structural declarations, byte ownership and
  versioned discovery semantics.
- [Research][research]: verified Pi APIs, source references and exploratory
  results from Pi 1.4.0.
- [Adversarial review][review]: findings from three independent reviews and the
  resulting design changes.

[spec]: docs/specification.md
[plan]: docs/implementation-plan.md
[api]: docs/api-protocol.md
[research]: docs/research.md
[review]: docs/review.md

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
