import { passthroughProvider } from './passthrough-provider.js';
import { ProviderRegistry } from './provider-registry.js';

export const builtinProviders = new ProviderRegistry(passthroughProvider);
