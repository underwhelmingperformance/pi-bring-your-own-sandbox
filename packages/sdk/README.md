# pi-bring-your-own-sandbox

This SDK connects Pi extensions to a shared sandbox broker. Users install their
chosen provider in Pi and configure it in the provider's settings file.
Consumers state restrictions, needs and path grants without depending on the
provider's implementation. With no selected provider, the SDK uses passthrough.
Failure of a selected provider stops execution.

These documents describe the target design. See the [design
principles][principles], [specification][spec] and [API appendix][api]. The SDK
routes operations that use its facade. An [outer sandbox][outer] can restrict
the Pi process.

[principles]: docs/principles.md
[spec]: docs/specification.md
[api]: docs/api-protocol.md
[outer]: docs/outer-runtime.md

## Extend Pi

Use `/consumer` to acquire a sandbox from a tool or command. The [consumer
example][consumer] shows how to pass Pi's live context and cancellation signal
and run an argv request.

The provider extension calls `/pi-tools` from its factory to route Pi's Bash,
user shell, file and search tools to the same workspace. The [Pi integration
guide][pi] describes how provider authors enable the integration.

Provider authors use `/provider` and run the [conformance suite][testing] from
`/testing`. The [Docker example][docker] shows provider setup. Embedding hosts
use `/host` to manage the session. Permission extensions use `/review` for
pending calls and escalation decisions. Providers can ship separate entry points
with stricter default policies.

[consumer]: examples/consumer/README.md
[pi]: docs/pi-integration.md
[testing]: docs/provider-testing.md
[docker]: examples/docker/README.md

## Development

Follow the [development guide][validation] to install dependencies and run
repository checks.

[validation]: docs/validation.md
