# Pi file and search adapters

Pi's `read`, `write`, `edit`, `ls`, `find` and `grep` use the same live BYOS
checkout as `bash`. Load the [Pi integration][integration] and select tools in
Pi.

[integration]: pi-integration.md

## File operations

BYOS supplies SDK operations to Pi's built-in `read`, `write`, `edit`, `ls` and
`find` definitions. Pi keeps argument handling, the edit algorithm and the
mutation queue. The adapter translates paths inside the host checkout to the
corresponding paths inside the target. Image detection reads bytes through the
SDK.

Paths outside the checkout keep their absolute host locations. A leading `~`
expands against the host home directory. The selected provider applies its
policy when the facade passes the resulting path to it.

Pi's file tools require a live checkout. Pi resolves filename variants in the
host checkout and keys its mutation queue by host path.

BYOS reads target bytes through the facade for the edit preview. It runs Pi's
edit algorithm in memory and escapes display-unsafe characters in the diff. If
the provider refuses the read, the preview shows the edit arguments and reports
that the preview is unavailable. The model receives output from the SDK-backed
tool execution.

## Search

`find` uses the facade's glob operation. `grep` uses Pi's schema, display format
and output truncation. BYOS probes for `rg` inside the target and runs it with
Pi's flags. If the target lacks `rg`, BYOS uses the facade's portable search.
Target `rg` emits matches and context in the same stream. The SDK refuses
records larger than 1 MiB and limits retained match and context data to 8 MiB.
The [specification][grep] describes the fallback scope.

[grep]: specification.md#grep
