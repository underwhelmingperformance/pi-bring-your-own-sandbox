import {
	closeSandboxSession as close,
	copyHostWorkspace as copy,
	getSandbox as acquire,
	negotiateSandbox as negotiate
} from '../client.js';
import type { SandboxHost } from '../contracts.js';

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

export function copyHostWorkspace(...parameters: Parameters<typeof copy>) {
	ready.add(parameters[0]);

	return copy(...parameters);
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
