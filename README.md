# BYOS workspace

BYOS lets Pi extensions use a sandbox without depending on a particular
isolation technology. The [design principles][principles] govern the [SDK][sdk],
the [guard][guard] and the [Docker provider][docker]. The documentation
describes the redesign. The packages in this checkout are private development
builds.

[principles]: packages/sdk/docs/principles.md
[sdk]: packages/sdk/README.md
[guard]: packages/guard/README.md
[docker]: packages/sdk/examples/docker/README.md

## Use a sandbox in Pi

Install your chosen provider and configure it in its own settings file. The
provider loads the Pi tool integration. The [Docker guide][docker] describes the
reference provider.

## Development

Use the Node version in `.node-version` and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
```

The [development guide][development] lists prerequisites and the separate Pi
integration, package installation and real Docker suites.

[development]: packages/sdk/docs/validation.md
