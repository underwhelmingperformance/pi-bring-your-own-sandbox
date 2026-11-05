# Development and validation

The framework targets Pi 1.5.0 and Node 24 or later. Use the development Node
version in `.node-version` and the pnpm version in `package.json`. Native search
tests require fd (`fdfind` on Debian) and ripgrep. Commit hooks require
pre-commit and Deno.

## Run the checks

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
```

`pnpm check` builds the SDK, then checks formatting, dependency usage, lint,
Markdown, tests and types. Use `pnpm fix` to apply ESLint and Prettier fixes.

Additional test commands run specific suites:

| Command                 | Purpose                                                      | Requirements                          |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `pnpm test:integration` | Real Pi sessions, CLI/RPC approval and consumer integration. | Local fixtures; no model credentials. |
| `pnpm test:package`     | Packed archives, exports and independent SDK copies.         | Dependency installation access.       |
| `pnpm test:provider`    | Real Docker execution, isolation and cleanup.                | Local Docker daemon and pinned image. |

The ordinary test run includes integration tests but skips the package and
Docker suites. Run their dedicated commands separately. The [Docker
guide][docker] explains daemon configuration and image preparation. Model and
approval fixtures require no live model requests.

The [CI workflow][workflow] runs tests on Linux and macOS, and static checks,
package installation and Docker tests on Linux. The required `check` job depends
on all of those jobs. Separate workflows check Actions security, commit messages
and CodeQL results.

[docker]: ../examples/docker/README.md
[workflow]: ../../../.github/workflows/check.yml

## Try the checkout

Load the diagnostic extension without changing Pi settings:

```sh
pi --no-extensions -e ./src/extension.ts
```

Use `/byos status`, `/byos providers` or `/byos approval-policies` to inspect
configuration without allocating a sandbox. Pi Git installations load TypeScript
source directly. `pnpm build` produces the compiled SDK used by packed archives.

## Test boundaries

The [user-flow coverage][user-flows] maps supported flows to integration tests.
The [provider testing guide][provider-testing] explains independent target
checks. The [specification][spec] and [API appendix][api] define the shared
contract.

Host execution uses POSIX process groups. Windows host process-tree cancellation
is unsupported. A descendant that creates another session or process group can
continue after completion, cancellation or disposal under a `process-group`
guarantee. Tests must clean up surviving children independently. Target-native
Windows path tests do not establish Windows host execution support.

The Docker example supports execution through POSIX `sh` and Bash, with copied
workspace volumes. It does not provide SDK file/search operations or PowerShell.
Workspace volumes have no storage quota, and the initial copy container has no
job resource limits. A host crash requires manual resource cleanup; see the
Docker guide for recovery instructions.

See the [Pi integration guide][pi] for unsupported tool paths, host transcript
files and competing shell handlers. Terminal drawing, keyboard navigation and
literal interactive `!`/`!!` parsing have no terminal automation here.
PowerShell approval tests use a provider fixture, not a native PowerShell
installation.

[user-flows]: user-flow-coverage.md
[provider-testing]: provider-testing.md
[spec]: specification.md
[api]: api-protocol.md
[pi]: pi-integration.md
