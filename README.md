# BYOS workspace

This repository contains the [sandbox SDK][sdk] and the optional guard extension
for Pi. Development uses pnpm workspaces. The packages are unpublished
development builds.

[sdk]: packages/sdk/README.md

## Development

Use the Node version in `.node-version` and pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
```

Run `pnpm test:integration`, `pnpm test:package` and `pnpm test:provider` for
the integration, package installation and real Docker suites. See the
[development guide][development] for prerequisites.

[development]: packages/sdk/docs/validation.md
