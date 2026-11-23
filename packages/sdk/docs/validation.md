# Development and validation

Use the Node version in `.node-version` and the pnpm version in `package.json`.
The workspace targets Pi 1.5.0 and Node 24 or later. Native search tests require
fd (`fdfind` on Debian) and ripgrep. Commit hooks require pre-commit and Deno.

## Run repository checks

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
```

`pnpm check` builds the packages and checks formatting, dependencies, lint,
Markdown, tests and types. Build and type checking use TypeScript 7. ESLint uses
the TypeScript 6 compiler API for type-aware Unicorn rules. Use
`pnpm fix:format` for formatting.

| Command                 | Coverage                                      | Requirements                         |
| ----------------------- | --------------------------------------------- | ------------------------------------ |
| `pnpm test:integration` | Real Pi sessions and CLI/RPC tool dispatch    | Local fixtures                       |
| `pnpm test:package`     | Installed archives and independent SDK copies | Dependency installation access       |
| `pnpm test:provider`    | Real Docker operations, isolation and cleanup | Local Docker daemon and pinned image |

The ordinary test run includes integration tests. Package and Docker tests have
separate commands. Package tests compile source exports in an isolated consumer
with `noPropertyAccessFromIndexSignature` enabled. Model and permission fixtures
require no live model requests.

The [CI workflow][workflow] runs tests on Linux and macOS, and static, package
and Docker checks on Linux. Separate workflows check Actions security, commit
messages and CodeQL.

[workflow]: ../../../.github/workflows/check.yml

## Check the redesign

The documentation describes the target design. The [user-flow coverage][flows]
specifies the integration evidence that each later milestone needs. The
[provider testing guide][testing] specifies the conformance cases and how they
inspect runtime effects. The [Docker guide][docker] explains daemon and image
preparation from this checkout.

Use actual Pi registration, dispatch and lifecycle events for integration tests.
Run protocol tests across independent SDK builds and vary the load order. Check
SDK behaviour with broker and passthrough fixtures. Use the real provider suite
to verify isolation and cleanup on each provider's platform. POSIX process-group
tests do not establish Windows process-tree cancellation, and a scripted
PowerShell backend does not establish native PowerShell support.

[flows]: user-flow-coverage.md
[testing]: provider-testing.md
[docker]: ../examples/docker/README.md
