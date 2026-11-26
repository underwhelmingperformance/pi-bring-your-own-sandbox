import {
	closeSandboxSession as close,
	getSandbox as acquire,
	negotiateSandbox as negotiate
} from '../client.js';
import { inspectContext } from '../context.js';
import type {
	SandboxContext,
	SandboxCopyOptions,
	SandboxHost
} from '../contracts.js';
import { ensureSandboxService } from '../default-broker.js';
import { protocolAddress } from '../protocol-address.js';
import { checkedCopy, copyOptions } from '../sandbox-copy.js';

const ready = new WeakSet<SandboxHost>();

export function isFixtureReady(pi: SandboxHost): boolean {
	return ready.has(pi);
}

export function getSandbox(...parameters: Parameters<typeof acquire>) {
	ready.add(parameters[0]);

	return acquire(...parameters);
}

export function negotiateSandbox(...parameters: Parameters<typeof negotiate>) {
	ready.add(parameters[0]);

	return negotiate(...parameters);
}

export async function copyHostWorkspace(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxCopyOptions
) {
	ready.add(pi);
	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const settings = copyOptions(options, source);
	const copy = await ensureSandboxService(pi).copy(
		context,
		{ kind: 'host' },
		settings
	);

	return checkedCopy(copy, settings, source);
}

export function closeSandboxSession(...parameters: Parameters<typeof close>) {
	ready.add(parameters[0]);

	return close(...parameters);
}

export function fixtureTools(pi: SandboxHost): string[] {
	if (!isFixtureReady(pi)) {
		throw new Error('The fixture factory has not finished.');
	}

	return [];
}
