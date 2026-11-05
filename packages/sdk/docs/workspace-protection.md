# Protected workspace resources

Writable workspaces let sandboxed commands change configuration that trusted
host software later executes. `workspaceProtection` requests immutable resources
within that workspace. It does not prevent reads. It applies to every provider
operation, including arbitrary commands, file operations and searches that can
cause mutations.

Protection overrides writable workspace access and provider grants. Provider and
consumer requirements are combined; a consumer cannot remove base protections.
Omission requests no resource-specific protection. A provider must advertise
`workspace.protection`. Missing capability support fails before opening;
providers must reject resources that they cannot enforce. The framework also
validates the effective policy after opening and the consumer validates the
acquired handle. The capability is in the closed operation vocabulary, so an
older broker rejects its declaration instead of silently accepting policy
metadata that it does not understand.

The built-in passthrough and Docker example do not advertise this capability.
Their existing filesystem guarantees remain separately negotiated. A read-only
workspace alone does not establish resource immutability: Git can refer to
external metadata, and writable aliases can expose the same underlying objects.

## Resources and provider configuration

Two resource forms are available:

- `{ "kind": "path", "path": ".pi" }` protects a workspace-relative subtree.
  Paths use `/` separators. Absolute paths, empty components, `.`, `..`, colons
  and backslashes are rejected. These are portable resource identifiers;
  providers resolve them according to their target filesystem.
- `{ "kind": "git-metadata" }` protects Git administration data: the `.git`
  entry, worktree pointer files, referenced worktree and common directories,
  repository configuration, objects, refs and hooks. A provider must account for
  external metadata and configured external hook paths, or reject the request.

The exported `HOST_CONFIGURATION_PROTECTION` preset contains Git metadata,
`.pi`, `.envrc`, `.direnv`, `.vscode`, `.idea` and `.devcontainer`. Git hooks
and configuration, Pi extensions and settings, direnv activation, editor tasks
and development-container lifecycle commands can all cause host-side execution.
The preset protects these inputs. It does not make arbitrary modified source,
package scripts or build files safe to execute on the host.

A provider configuration callback can combine the preset with additional paths:

```typescript
import type { SandboxProviderConfig } from 'pi-bring-your-own-sandbox/api';
import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';

const configure = (): SandboxProviderConfig<object> => ({
  configuration: {},
  policy: {
    workspaceAccess: 'read-write',
    filesystemScope: 'workspace-only',
    networkAccess: 'denied',
    workspaceProtection: [
      ...HOST_CONFIGURATION_PROTECTION,
      { kind: 'path', path: '.custom-host-hooks' }
    ]
  }
});
```

The provider receives a typed resource array. Snapshots are deeply frozen,
duplicate and covered resources are removed, and ordering is deterministic for
backend reuse. A combined policy can contain at most 128 resources after
reduction; an oversized request fails before allocation. A protected parent
covers its subtree. A path resource for `.git` alone does not cover external Git
metadata.

## Enforcement and verification

Resources remain immutable whether they exist when the backend opens or are
initially absent. Providers must prevent content and metadata changes, creation,
unlinking, replacement, renaming and parent-directory changes that can replace a
protected resource. Symlink and hardlink aliases must not provide mutation
routes. Case-insensitive filesystems require the same protection for equivalent
spellings. Check then use validation alone cannot enforce this against
concurrent workload mutations.

A provider must reject a request if its runtime cannot enforce the complete
resource set. Filtering SDK file paths is insufficient because arbitrary
commands can mutate files. A copied workspace must explain which protected
resources are preserved in the copy and how publication back to the host
preserves them.

The [provider test kit][testing] requires `verifyPolicy` for protected-resource
scenarios. Before advertising support, independent runtime probes must cover:

- Existing and absent resources, command execution and SDK mutations.
- Writes, truncation, permission changes, unlinking, replacement and renames of
  both resources and their parents.
- Symlink and hardlink aliases, case aliases on native case-insensitive
  filesystems, worktree `.git` files and external common directories and hooks.
- Read-only workspaces separately from writable workspaces, including external
  aliases and conflicting writable grants.

Inspect the protected files and metadata independently after each attempted
mutation. Successful normal workspace operations are also required. A provider's
reported policy is not evidence of enforcement.

Git metadata protection prevents commits, index updates and configuration
changes inside the sandbox. Some read commands request optional locks and can
also fail. Users can choose a suitable outside-execution policy for intentional
host changes. Protection applies only to operations submitted through BYOS; it
does not confine Pi, peer extensions, MCP servers or independent host processes.

[testing]: provider-testing.md
