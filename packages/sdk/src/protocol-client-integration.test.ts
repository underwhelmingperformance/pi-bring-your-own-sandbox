import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { createSandboxClient } from './client.js';
import * as consumer from './consumer.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import * as host from './embedding-host.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxInitialisationError
} from './errors.js';
import { imageProvider } from './fixtures/image-provider.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProvider } from './fixtures/register-provider.js';
import { initialiseSandboxHost } from './host.js';
import {
	registerSandboxDiagnostics,
	registerShellOnlyTools
} from './pi-tools.js';
import { protocolAddress } from './protocol-address.js';
import * as provider from './provider.js';
import * as providerKit from './provider-kit.js';
import * as review from './review.js';

it('rejects acquisition during factory loading and client creation after loading', async () => {
	let api: ExtensionAPI | undefined;
	const outcomes: string[] = [];

	await withPiRuntime(
		[
			{
				name: 'consumer',
				async factory(pi) {
					api = pi;

					const client = createSandboxClient(pi, '<inline:consumer>');
					const premature = client.get({
						cwd: '/workspace',
						sessionManager: SessionManager.inMemory('/workspace')
					});

					await expect(premature).rejects.toThrow(SandboxInitialisationError);
					outcomes.push('premature rejected');

					pi.on('session_start', async (_event, context) => {
						const sandbox = await client.get(context);

						outcomes.push(sandbox.providerId);
					});
				}
			},
			{
				name: 'provider',
				factory(pi) {
					initialiseSandboxHost(pi, '<inline:provider>', {});
				}
			}
		],
		(_runtime, errors) => {
			const loaded = api;

			if (loaded === undefined) {
				throw new Error('The consumer extension did not load.');
			}

			expect(() => createSandboxClient(loaded, '<inline:consumer>')).toThrow(
				SandboxInitialisationError
			);
			expect({ errors, outcomes }).toStrictEqual({
				errors: [],
				outcomes: ['premature rejected', 'passthrough']
			});

			return Promise.resolve();
		},
		{ bindFixtureSources: false }
	);
});

it('keeps a lazy provider discoverable and retains its factory failure', async () => {
	const cause = new Error('Fixture factory failure.');
	const findings: unknown[] = [];
	const extensionSource = '<inline:factory-failure>';
	let creates = 0;
	const loaded: unknown[] = [];

	await withPiRuntime(
		[
			{
				name: 'factory-failure',
				factory(pi) {
					const { id, label, profiles } = imageProvider;

					provider.registerSandboxProvider(pi, extensionSource, {
						id,
						label,
						profiles,
						create() {
							creates++;

							throw cause;
						}
					});
					loaded.push({
						ids: discoverProviders(pi.events).map((entry) => entry.id),
						creates
					});

					const client = createSandboxClient(pi, extensionSource);

					pi.on('session_start', async (_event, context) => {
						const broker = discoverBroker(pi.events);

						if (broker === undefined) {
							throw new Error('The broker did not publish its provider list.');
						}

						const providers = await broker.providers(context);

						loaded.push({ ids: providers.map((entry) => entry.id), creates });

						const result = await client.negotiate(context);

						expect(await client.negotiate(context)).toStrictEqual(result);

						if (
							result.ok ||
							!isSandboxError(result.error, InvalidSandboxConfigError)
						) {
							throw new Error(
								'The provider factory error should prevent acquisition.'
							);
						}

						findings.push({
							name: result.error.name,
							operation: result.error.operation,
							providerId: result.error.providerId,
							extensionSource: result.error.extensionSource
						});

						const after = await broker.providers(context);
						const status = await broker.status(context);

						findings.push({
							ids: after.map((entry) => entry.id),
							state: status.state,
							failure: status.failure?.name,
							creates
						});
						expect(after).toStrictEqual(providers);
					});
				}
			}
		],
		(_runtime, errors) => {
			expect({ errors, findings, loaded, creates }).toStrictEqual({
				errors: [],
				loaded: [
					{ ids: [imageProvider.id], creates: 0 },
					{ ids: ['passthrough', imageProvider.id], creates: 0 }
				],
				creates: 1,
				findings: [
					{
						name: 'InvalidSandboxConfigError',
						operation: 'configure',
						providerId: imageProvider.id,
						extensionSource
					},
					{
						ids: ['passthrough', imageProvider.id],
						state: 'failed',
						failure: 'InvalidSandboxConfigError',
						creates: 1
					}
				]
			});

			return Promise.resolve();
		}
	);
});

const nonFactoryFunctions = new Set([
	'SandboxLaunchFrames',
	'ShellTransportRunner',
	'canonicalHostPath',
	'checkSandboxTargetStatus',
	'cleanDisplayText',
	'createSandboxCleanupContext',
	'createTargetFileOperations',
	'encodePosixArgv',
	'isSandboxError',
	'isWithinHostRoots',
	'mapSandboxErrno',
	'isProtectedWorkspacePath',
	'resolveSandboxCopySource',
	'sendDisplayMessage',
	'targetFileHelper',
	'targetSearchHelper'
]);

const factoryArguments = new Map<string, readonly unknown[]>([
	['createSandboxClient', []],
	['createShellReviewClient', []],
	['initialiseSandboxHost', []],
	['registerSandboxDiagnostics', []],
	['registerSandboxProvider', [fixtureProvider(imageProvider)]],
	['registerShellOnlyTools', []]
]);

const factoryExports = Object.entries<unknown>({
	...consumer,
	...host,
	...provider,
	...providerKit,
	...review,
	registerSandboxDiagnostics,
	registerShellOnlyTools
}).filter(
	([name, value]) =>
		typeof value === 'function' &&
		!Object.prototype.isPrototypeOf.call(Error, value) &&
		!nonFactoryFunctions.has(name)
);

it.each(factoryExports)(
	'keeps %s from registering without a factory source',
	async (name, register) => {
		const arguments_ = factoryArguments.get(name);

		if (arguments_ === undefined || typeof register !== 'function') {
			throw new Error(
				`Classify the public function ${name} in the factory source test.`
			);
		}

		const extensionSource = '<inline:missing-source>';
		const registered: string[] = [];

		await withPiRuntime(
			[
				{
					name: 'missing-source',
					factory(pi) {
						expect(() => {
							Reflect.apply(register, undefined, [
								pi,
								undefined,
								...arguments_
							]);
						}).toThrow(InvalidSandboxRequestError);
						expect(() => protocolAddress(pi.events)).toThrow(
							SandboxInitialisationError
						);

						Reflect.apply(register, undefined, [
							pi,
							extensionSource,
							...arguments_
						]);
						registered.push(protocolAddress(pi.events).extensionSource);
					}
				}
			],
			(_runtime, errors) => {
				expect({ errors, registered }).toStrictEqual({
					errors: [],
					registered: [extensionSource]
				});

				return Promise.resolve();
			},
			{ bindFixtureSources: false }
		);
	}
);
