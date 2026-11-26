# Provider presets

Providers can ship presets that require isolation or operation capabilities. The
Docker shell preset requires Docker and denies network access, host user data
and host system files for ordinary shell calls.

The guard moves into the SDK as `/guard` in milestone 7. Provider extension
factories use it to register the requirements for presets that they ship. Users
choose a preset from the provider and configure the provider in its own settings
file.

See the [Docker provider guide][docker] and the [preset specification][spec].

[docker]: ../sdk/examples/docker/README.md
[spec]: ../sdk/docs/specification.md#provider-presets
