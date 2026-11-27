import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { createSandboxClient } from './client.js';
import * as consumer from './consumer.js';
import * as host from './embedding-host.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxInitialisationError
} from './errors.js';
import { imageProvider } from './fixtures/image-provider.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { initialiseSandboxHost } from './host.js';
import { registerShellOnlyTools } from './pi-tools.js';
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

it('reports a provider factory failure as configuration before opening', async () => {
	const cause = new Error('Fixture factory failure.');
	const findings: unknown[] = [];
	const extensionSource = '<inline:factory-failure>';

	await withPiRuntime(
		[
			{
				name: 'factory-failure',
				factory(pi) {
					provider.registerSandboxProviderFactory(
						pi,
						extensionSource,
						imageProvider,
						() => {
							throw cause;
						}
					);

					const client = createSandboxClient(pi, extensionSource);

					pi.on('session_start', async (_event, context) => {
						const result = await client.negotiate(context);

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
					});
				}
			}
		],
		(_runtime, errors) => {
			expect({ errors, findings }).toStrictEqual({
				errors: [],
				findings: [
					{
						name: 'InvalidSandboxConfigError',
						operation: 'configure',
						providerId: imageProvider.id,
						extensionSource
					}
				]
			});

			return Promise.resolve();
		}
	);
});

const nonFactoryFunctions = new Set([
	'GrepOutput',
	'SandboxLaunchFrames',
	'ShellTransportRunner',
	'checkSandboxTargetStatus',
	'cleanDisplayText',
	'createSandboxCleanupContext',
	'createTargetFileOperations',
	'encodePosixArgv',
	'isSandboxError',
	'mapSandboxErrno',
	'isProtectedWorkspacePath',
	'resolveSandboxCopySource',
	'sandboxRipgrepArguments',
	'sendDisplayMessage',
	'targetFileHelper',
	'targetSearchHelper'
]);

const factoryArguments = new Map<string, readonly unknown[]>([
	['createSandboxClient', []],
	['createShellReviewClient', []],
	['initialiseSandboxHost', [{}]],
	['registerSandboxDiagnostics', []],
	[
		'registerSandboxProvider',
		[
			imageProvider,
			{ configure: () => ({ configuration: { image: 'fixture' } }) }
		]
	],
	['registerSandboxProviderFactory', [imageProvider, () => imageProvider]],
	[
		'registerUnavailableSandboxProvider',
		[
			{
				id: 'fixture.unavailable',
				label: 'Unavailable fixture',
				unavailable: {
					kind: 'unsupported-platform',
					platform: 'fixture-system',
					message: 'Native sandbox runtime unavailable.'
				}
			}
		]
	],
	['registerShellOnlyTools', []]
]);

const factoryExports = Object.entries<unknown>({
	...consumer,
	...host,
	...provider,
	...providerKit,
	...review,
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
