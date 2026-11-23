# BYOS guard

Use the optional guard when SDK consumers must have an explicitly activated
provider. The guard can also require a specific provider, restrictions, needs or
operation capabilities. The broker combines the guard and consumer requests
before acquiring a sandbox or copy. A need or restriction takes precedence over
a preference. Conflicting hard states fail before allocation.

The guard moves into the SDK as `/guard` in milestone 7. This checkout still has
the standalone [extension][extension]. The example below describes the target
API.

[extension]: src/index.ts

## Require a provider and restrictions

```typescript
import { createSandboxGuard } from 'pi-bring-your-own-sandbox/guard';

export default createSandboxGuard({
  providerId: 'example.docker',
  capabilities: ['exec'],
  access: { network: 'prevented', hostUserData: 'prevented' },
  terminationScope: 'process-group'
});
```

Omit `providerId` to accept any explicitly activated provider. Multiple guards
apply together, and consumers cannot weaken the combined requirements. A guard
that requires only activation accepts an explicitly activated passthrough
provider. Add the restrictions that the model's tools depend on. Reload Pi when
configuration changes.

The guard checks declarations and cannot enforce isolation itself. The
[specification][spec] describes negotiation and the boundary of the cooperative
SDK.

[spec]: ../sdk/docs/specification.md
