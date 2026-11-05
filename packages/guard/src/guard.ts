import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { SandboxRequirements } from 'pi-bring-your-own-sandbox/api';
import { registerSandboxRequirement } from 'pi-bring-your-own-sandbox/api';

/**
Require an activated provider before BYOS SDK operations can proceed. Omit
requirements to accept any activated provider, or specify identity, capability
and policy requirements. This guard does not authenticate provider extensions
or intercept operations outside the SDK.
*/
export function createSandboxGuard(
	requirements: SandboxRequirements = {}
): ExtensionFactory {
	return (pi) => {
		registerSandboxRequirement(pi, requirements);
	};
}
