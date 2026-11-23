# Pi file and search adapters

Pi's `read`, `write`, `edit`, `ls`, `find` and `grep` use the same BYOS
workspace as `bash`. The adapters use the facade's file and search operations.
Pi keeps its argument handling, edit algorithm, image handling and output
formatting. The [Pi integration guide][integration] describes installation and
routing.

[integration]: pi-integration.md

## Required delegation

- Resolve paths and inspect file types through target operations. The adapter
  must account for cwd, roots, home expansion, separators and filename variants
  without probing the host filesystem.
- Run the edit read, transform and write in the facade's mutation queue.
  Delegate the pure transformation to Pi through a supported API. Preview reads
  use the target boundary and follow the call's permission rules.
- Run searches and context reads in the target. Host binary discovery and
  spawning belong only to passthrough.
- Detect image type from target bytes. A local file-based helper cannot inspect
  a path that only exists inside the sandbox.
- Report unavailable operations as typed capability failures. The adapter cannot
  fill missing capability with a host operation.

Milestone 8 routes every listed tool through the facade. The [boundary
tests][boundary] show gaps in Pi 1.5.0. Some paths resolve against the host
before reaching an adapter. The edit queue, edit previews, search process
invocation and image detection also contain host-side steps. Milestone 8 decides
how to close each gap while preserving Pi's argument and output behaviour.

[boundary]: ../src/pi-boundaries.test.ts

## Acceptance cases

Run the adapters in a real Pi session with scripted model calls and permission
decisions. Use different markers in the host and target to show which tree each
tool reads and writes. Check POSIX and Windows target paths, images, preview
reads, edit ordering, cancellation, result transforms and explicit tool
allowlists. Check that Bash sees a completed edit in the same workspace and that
a missing operation produces no host effects. Provider conformance tests inspect
the target independently of Pi's rendered output.
