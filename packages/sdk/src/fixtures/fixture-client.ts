import {
	getSandbox as acquire,
	negotiateSandbox as negotiate
} from '../client.js';
import { inspectContext } from '../context.js';
import type {
	SandboxContext,
	SandboxCopyOptions,
	SandboxHost
} from '../contracts.js';
import { startSandboxRuntime } from '../default-broker.js';
import { protocolAddress } from '../protocol-address.js';
import { localRuntimeBindings } from '../runtime-participant.js';
import { checkedCopy, copyOptions } from '../sandbox-copy.js';

interface FixtureSession {
	readonly context: SandboxContext;
	starting?: Promise<void>;
	isReady?: true;
}

const sessions = new WeakMap<SandboxHost, FixtureSession>();

export function setFixtureSession(
	pi: SandboxHost,
	context: SandboxContext
): void {
	sessions.set(pi, { context });
}

function startFixture(pi: SandboxHost): Promise<void> | undefined {
	const session = sessions.get(pi);

	if (session === undefined) {
		return;
	}

	session.isReady = true;
	session.starting ??= startSandboxRuntime(pi, session.context);

	return session.starting;
}

export function isFixtureReady(pi: SandboxHost): boolean {
	return sessions.get(pi)?.isReady === true;
}

export async function getSandbox(...parameters: Parameters<typeof acquire>) {
	const starting = startFixture(parameters[0]);

	if (starting !== undefined) {
		await starting;
	}

	return acquire(...parameters);
}

export async function negotiateSandbox(
	...parameters: Parameters<typeof negotiate>
) {
	const starting = startFixture(parameters[0]);

	if (starting !== undefined) {
		await starting;
	}

	return negotiate(...parameters);
}

export function fixtureOwner(pi: SandboxHost) {
	const owner = localRuntimeBindings(pi).owner;

	if (owner === undefined) {
		throw new Error('The fixture must run in the elected SDK copy.');
	}

	return owner;
}

export async function copyHostWorkspace(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxCopyOptions
) {
	const starting = startFixture(pi);

	if (starting !== undefined) {
		await starting;
	}

	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const settings = copyOptions(options, source);
	const copy = await fixtureOwner(pi).copy(context, { kind: 'host' }, settings);

	return checkedCopy(copy, settings, source);
}

export async function closeSandboxSession(pi: SandboxHost) {
	const starting = startFixture(pi);

	if (starting !== undefined) {
		await starting;
	}

	return fixtureOwner(pi).close();
}

export function fixtureTools(pi: SandboxHost): string[] {
	if (!isFixtureReady(pi)) {
		throw new Error('The fixture factory has not finished.');
	}

	return [];
}
