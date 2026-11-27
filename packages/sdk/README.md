# pi-bring-your-own-sandbox

This SDK connects Pi extensions to a shared sandbox broker. Users install their
chosen provider in Pi and configure it in the provider's settings file.
Consumers state restrictions, needs and path grants without depending on the
provider's implementation. With no selected provider, the SDK uses passthrough.
Failure of a selected provider stops execution.

See the [design principles][principles], [specification][spec] and [API
appendix][api]. The SDK routes operations that use its facade. An [outer
sandbox][outer] can restrict the Pi process. Follow the [1.0 upgrade
guide][upgrade] when replacing a development build.

[principles]: docs/principles.md
[spec]: docs/specification.md
[api]: docs/api-protocol.md
[outer]: docs/outer-runtime.md
[upgrade]: docs/upgrade-1.0.md

## Extend Pi

Use `/consumer` to acquire a sandbox from a tool or command. The [consumer
example][consumer] shows how to pass Pi's live context and cancellation signal
and run an argv request.

The provider extension calls `/pi-tools` from its factory to route Pi's Bash,
PowerShell and user-shell operations to the selected workspace. The [Pi
integration guide][pi] describes how provider authors enable the integration.

Provider authors register through `/provider`, can use implementation helpers
from `/provider-kit` and run the [conformance suite][testing] from `/testing`.
The [Docker example][docker] shows provider setup. Embedding hosts use `/host`
to manage the session. Permission extensions use `/review` to review pending
calls and record escalation decisions. Providers can ship separate entry points
with stricter default policies.

[consumer]: examples/consumer/README.md
[pi]: docs/pi-integration.md
[testing]: docs/provider-testing.md
[docker]: ../provider-docker/README.md

## Install the SDK from Git

To install a revision of the SDK with pnpm, add the Git subdirectory to
`package.json`.

```json
{
  "dependencies": {
    "pi-bring-your-own-sandbox": "git+https://github.com/underwhelmingperformance/pi-bring-your-own-sandbox.git#<sha>&path:/packages/sdk"
  }
}
```

The SDK compiles its entry points during installation. Allow the build with an
entry in `pnpm-workspace.yaml`.

```yaml
allowBuilds:
  'pi-bring-your-own-sandbox@git+https://github.com/underwhelmingperformance/pi-bring-your-own-sandbox.git#<sha>&path:/packages/sdk': true
```

Replace `<sha>` with the same full commit SHA in both files. The [pnpm build
setting][pnpm-builds] checks the package name, Git URL, revision and
subdirectory together.

[pnpm-builds]: https://pnpm.io/settings#allowbuilds

## Development

Follow the [development guide][validation] to install dependencies and run
repository checks.

[validation]: docs/validation.md
