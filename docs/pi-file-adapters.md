# Pi file and search adapter prerequisites

Pi 1.5.0's public tool factories do not provide a complete target-filesystem
boundary. Host path resolution, mutation identities, edit previews and grep
execution need additional public hooks. The [Pi integration guide][integration]
lists the current limits. Until those hooks exist, `/pi-tools` routes shell
tools only.

[integration]: pi-integration.md#upstream-extension-point-gaps

Complete adapters require changes in Pi. BYOS must preserve Pi's editing,
search, image and presentation algorithms. Private imports, duplicated edit
logic and host reads hidden behind an SDK filename check do not establish the
required boundary.

## Required public hooks

These are requirements for upstream APIs, not APIs available in Pi 1.5.0:

- Delegate target path resolution, including cwd, roots, home expansion,
  separators and filename variants. Resolution must use target operations and
  must not inspect host files. Workspace display paths can remain separate.
- Delegate mutation identity and the complete edit transaction. Pi should expose
  its pure edit transformation through a supported API, or supply an operation
  callback that executes that transformation within the backend transaction.
  BYOS can then use `files.updateText` without copying Pi's algorithm. An
  asynchronous Pi read/transform/write sequence cannot be passed directly as the
  SDK's synchronous text transform.
- Route edit-preview reads through an explicit boundary. Define whether preview
  reads require approval and when they can execute. Renderers must not read host
  content independently before approval, and must handle missing target
  capabilities without falling back to host reads.
- Provide a complete grep execution operation, including context reads and
  cancellation. Pi can retain search argument validation and output formatting;
  a supplied operation must replace host ripgrep discovery and spawning.
- Detect image content from backend bytes through a supported byte-based API. A
  file-based MIME helper cannot inspect a remote path safely.

Pi also owns full shell-output transcript files. An output-storage hook would
make those references readable from a remote target; the current integration
reports host paths according to Pi's public behaviour.

## Adapter acceptance after upstream support

Adapters must pass target-boundary regressions against the supported Pi version.
Use one operation adapter per public file/search factory, preserve Pi's tool
selection and modifiers, and acquire the user's provider through the SDK.
Capability failures must be typed and happen without host fallback.

Integration cases must distinguish host-only and target-only marker contents,
remote POSIX and Windows paths, images, edit previews before approval, mutation
transactions, unsupported methods and shells, cancellation, result transforms
and explicit tool allowlists. Exercise the real Pi runtime with scripted model
and approval decisions. Provider conformance must independently inspect actual
target reads and mutations.

Providers implement and verify their own file/search operations and access
restrictions. Complete Pi hooks would allow adapters to use those capabilities;
the framework's interfaces alone do not implement them.
