import { acquireOptions, checkRequirements } from './acquire-options.js';
import { inspectContext } from './context.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxClient,
	SandboxContext,
	SandboxErrorInfo,
	SandboxHost,
	SandboxNegotiation
} from './contracts.js';
import { bindFactory, ensureSandboxService } from './default-broker.js';
import {
	isSandboxError,
	rehydrateSandboxError,
	SandboxInitialisationError
} from './errors.js';
import { isPiBound, protocolAddress } from './protocol-address.js';

function identifyRequester(
	error: SandboxErrorInfo,
	extensionSource: string
): SandboxErrorInfo {
	if (error.extensionSource !== undefined || error.detail === undefined) {
		return error;
	}

	const {
		operation,
		configurationSource,
		providerId,
		backendId,
		recovery,
		detail
	} = error;

	return rehydrateSandboxError(
		error,
		{ cause: error.cause },
		{
			operation,
			extensionSource,
			detail,
			...(configurationSource !== undefined && { configurationSource }),
			...(providerId !== undefined && { providerId }),
			...(backendId !== undefined && { backendId }),
			...(recovery !== undefined && { recovery })
		}
	);
}

/**
Acquire the selected sandbox from a live Pi event, command or tool context.
Call after extension loading. All consumers share the user's provider selection;
an unconfigured user gets the host backend. A requested policy can tighten the
user's policy but not loosen it, and consumers that request the same policy
share one backend. Configured failures never select host execution. Cancelling
an acquisition leaves shared startup running.
*/
export async function getSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<Sandbox> {
	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const settings = acquireOptions(options, source);

	try {
		const sandbox = await ensureSandboxService(pi).acquire(context, settings);

		checkRequirements(sandbox, settings, source);

		return sandbox;
	} catch (error) {
		throw isSandboxError(error) ? identifyRequester(error, source) : error;
	}
}

/**
Check whether `getSandbox` with the same options could succeed, without
provisioning a backend. Returns the profile for acquisition, or a typed refusal. Acquisition validates the
opened backend against the selected profile.
*/
export async function negotiateSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<SandboxNegotiation> {
	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const result = await ensureSandboxService(pi).negotiate(
		context,
		acquireOptions(options, source)
	);

	return result.ok
		? result
		: { ok: false, error: identifyRequester(result.error, source) };
}

/**
Register a consumer during its Pi extension factory. The client records the
extension source for discovery and review.
*/
export function createSandboxClient(
	pi: SandboxHost,
	extensionSource: string
): SandboxClient {
	if (isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	bindFactory(pi, extensionSource);

	return Object.freeze<SandboxClient>({
		get: (context, options) => getSandbox(pi, context, options),
		negotiate: (context, options) => negotiateSandbox(pi, context, options)
	});
}
