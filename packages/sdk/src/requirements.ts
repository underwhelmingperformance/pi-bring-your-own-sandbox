import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import {
	acquireOptions,
	checkCapabilityRequirements
} from './acquire-options.js';
import type { SandboxConfig } from './config.js';
import { selectProvider } from './config.js';
import type { SandboxHost, SandboxRequirements } from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxProviderMismatchError,
	SandboxProviderRequiredError
} from './errors.js';
import { discoverServices, publishService } from './extension-services.js';
import { resolvePolicy } from './negotiation.js';
import type { ProviderServiceV1 } from './protocol.js';
import { sandboxRequirementsSchema } from './request-schemas.js';
import { runtimeSettings } from './runtime-settings.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const CHANNEL = 'pi-byos:requirements:v1';
const isRequirements = checker(sandboxRequirementsSchema);
const isService = checker(
	Type.Object({
		id: nonEmptyStringSchema,
		requirements: sandboxRequirementsSchema
	})
);

function snapshotRequirements(
	requirements: SandboxRequirements
): SandboxRequirements {
	const { providerId, ...options } = requirements;
	const {
		signal: _signal,
		timeoutMs: _timeout,
		...snapshotOptions
	} = acquireOptions(options);

	return Object.freeze({
		...snapshotOptions,
		...(providerId !== undefined && { providerId })
	});
}

/**
Require explicit provider activation and minimum guarantees for all SDK calls.
Register synchronously during extension loading. Multiple registrations apply
together; conflicting requirements prevent acquisition. Identity checks use
provider declarations and do not authenticate the extension that registered them.
*/
export function registerSandboxRequirement(
	pi: SandboxHost,
	requirements: SandboxRequirements = {}
): void {
	runtimeSettings(pi).assertConfigurable();

	if (!isRequirements(requirements)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	const snapshot = snapshotRequirements(requirements);

	publishService(
		pi.events,
		CHANNEL,
		Object.freeze({ id: randomUUID(), requirements: snapshot })
	);
}

export function sandboxRequirements(
	pi: SandboxHost
): readonly SandboxRequirements[] {
	return Object.freeze(
		discoverServices(pi.events, CHANNEL, isService).map((service) =>
			snapshotRequirements(service.requirements)
		)
	);
}

export function checkRequiredProvider(
	requirements: readonly SandboxRequirements[],
	provider: ProviderServiceV1,
	isActivated: boolean
): void {
	if (requirements.length === 0) {
		return;
	}

	if (!isActivated) {
		throw new SandboxProviderRequiredError({ operation: 'configure' });
	}

	const identity = { operation: 'acquire' as const, providerId: provider.id };

	for (const required of requirements) {
		if (
			required.providerId !== undefined &&
			required.providerId !== provider.id
		) {
			throw new SandboxProviderMismatchError(identity);
		}

		checkCapabilityRequirements(provider.capabilities, required, identity);
	}
}

export function applySandboxRequirements(
	config: SandboxConfig,
	provider: ProviderServiceV1,
	requirements: readonly SandboxRequirements[]
): SandboxConfig {
	if (requirements.length === 0) {
		return config;
	}

	selectProvider(config, [provider]);

	let policy = config.selection.policy;

	for (const required of requirements) {
		policy = resolvePolicy(policy, provider, required.policy, {
			operation: 'acquire',
			providerId: provider.id
		});
	}

	return Object.freeze({
		...config,
		selection: Object.freeze({ ...config.selection, policy }),
		requirements
	});
}
