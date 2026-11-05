# pi-bring-your-own-sandbox-guard

An optional Pi extension that requires an activated sandbox provider before BYOS
SDK calls can proceed. Use it when a missing provider extension should block
execution instead of using the SDK's default host implementation.

The default guard accepts any explicitly activated provider. It has no
configuration file or command-line flags. Your chosen provider extension owns
its configuration.

## Use from this checkout

Install workspace dependencies, then load the guard alongside your provider:

```sh
pnpm install --frozen-lockfile
pi --no-extensions -e ./packages/guard -e /path/to/provider-extension.ts
```

Pi loads the TypeScript extension source. Archive exports for Node consumers use
the compiled factory. These packages remain private development packages; this
command does not require publication.

## Require a provider or guarantees

A local extension can use the exported factory:

```typescript
import { createSandboxGuard } from 'pi-bring-your-own-sandbox-guard';

export default createSandboxGuard({
  providerId: 'example.native',
  capabilities: ['exec'],
  processKinds: ['argv'],
  terminationScope: 'process-group',
  policy: {
    workspaceAccess: 'read-only',
    filesystemScope: 'system-read-only'
  }
});
```

Omit `providerId` to accept any activated provider. Requirements use the SDK's
capability and policy vocabulary. Multiple guards apply together. Incompatible
requirements block acquisition. Consumers cannot loosen guard requirements.
Reload Pi to change providers, configuration or guard requirements.

The SDK checks declarations before allocation and checks ordinary backends again
after opening. The guard also applies before outside execution is prepared or
approved. Once the ordinary provider satisfies the guard, explicitly approved
outside execution can use its independently selected destination without opening
the ordinary backend.

## Boundary

The guard applies to cooperating extensions that use BYOS. It does not replace
Pi tools or intercept direct host I/O. Provider IDs and advertised capabilities
are declarations, not authenticated extension metadata. A malicious extension
can register a matching declaration and misrepresent its behaviour. Users must
trust installed extensions and the provider's implementation.

An explicitly activated host provider can satisfy a guard that requires only
activation. Specify policy and capability requirements when activation alone is
insufficient. Provider startup and configuration failures remain errors; the SDK
does not select another provider after a failure.
