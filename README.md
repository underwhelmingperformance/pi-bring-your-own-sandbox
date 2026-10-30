# pi-bring-your-own-sandbox

A proposed Pi extension framework through which provider extensions supply a
sandbox and consumer extensions use a common execution API.

The proposed SDK works without sandbox setup: built-in `passthrough` executes on
the host by default and follows a user's separately configured sandbox provider
when present. A configured sandbox failure never switches to host execution.

The scratch extension currently registers `/byos`, which reports that the
framework is not implemented. It does not create a sandbox or replace Pi tools.
`/api` exports structural types, provider registration and structural errors.
The consumer acquisition and execution APIs remain unimplemented. The design
documents describe the intended implementation:

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
the commit hooks. The private scaffold pins Pi 1.4.0 for development and peer
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

Then run `/byos`. The package manifest loads `dist/extension.js` after a build.
`pnpm test` checks both source and compiled loading with Pi's actual extension
loader, without model credentials.

Tooling follows the sibling repositories: pnpm and typed ESLint with Unicorn and
import sorting from Identify/Cupboard; Prettier, Markdownlint and EditorConfig
from Cupboard; SHA-pinned pre-commit and Wrapscallion hooks from
Identify/Wrapscallion. `pnpm check` runs formatting, dependency usage, lint,
Markdown, loader tests and type checks. `pnpm fix` applies ESLint and Prettier
fixes. GitHub Actions runs checks/builds, workflow lint and commit-message lint.
