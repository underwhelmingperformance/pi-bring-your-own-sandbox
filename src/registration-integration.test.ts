import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	createEventBus,
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import type {
	isSandboxError,
	registerSandboxProvider,
	SandboxOperationError
} from './api.js';
import { discoverProviders } from './discovery.js';
import { imageProvider } from './fixtures/image-provider.js';
import { brokerReply } from './fixtures/protocol-peer.js';
import type { ensureBroker } from './service.js';

interface FixtureApi {
	readonly registerSandboxProvider: typeof registerSandboxProvider;
	readonly isSandboxError: typeof isSandboxError;
	readonly SandboxOperationError: typeof SandboxOperationError;
}

interface BootstrapModule {
	readonly ensureBroker: typeof ensureBroker;
}

function isBootstrapModule(value: unknown): value is BootstrapModule {
	return (
		typeof value === 'object' &&
		value !== null &&
		'ensureBroker' in value &&
		typeof value.ensureBroker === 'function'
	);
}

function isFixtureApi(value: unknown): value is FixtureApi {
	return (
		typeof value === 'object' &&
		value !== null &&
		'registerSandboxProvider' in value &&
		typeof value.registerSandboxProvider === 'function' &&
		'isSandboxError' in value &&
		typeof value.isSandboxError === 'function' &&
		'SandboxOperationError' in value &&
		typeof value.SandboxOperationError === 'function'
	);
}

async function loadCopy(directory: string): Promise<FixtureApi> {
	await cp(new URL('../dist/', import.meta.url), directory, {
		recursive: true
	});
	const module: unknown = await import(
		pathToFileURL(path.join(directory, 'api.js')).href
	);
	if (!isFixtureApi(module)) {
		throw new TypeError(
			'The built SDK does not export the registration and error APIs.'
		);
	}

	return module;
}

it('interoperates across physical SDK copies and removes failed-factory responders in Pi', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-registration-'));

	try {
		const first = await loadCopy(path.join(directory, 'first'));
		const second = await loadCopy(path.join(directory, 'second'));
		const events = createEventBus();
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: path.join(directory, 'agent'),
			settingsManager: SettingsManager.inMemory(),
			eventBus: events,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: 'first',
					factory: (pi) => {
						first.registerSandboxProvider(pi, {
							...imageProvider,
							id: 'first'
						});
					}
				},
				{
					name: 'failed',
					factory: (pi) => {
						second.registerSandboxProvider(pi, {
							...imageProvider,
							id: 'failed'
						});
						throw new Error('deliberate factory failure');
					}
				},
				{
					name: 'second',
					factory: (pi) => {
						second.registerSandboxProvider(pi, {
							...imageProvider,
							id: 'second'
						});
					}
				}
			]
		});
		await loader.reload();
		const error = new first.SandboxOperationError({
			operation: 'exec'
		});

		expect({
			providers: discoverProviders(events).map((provider) => provider.id),
			loadErrors: loader.getExtensions().errors.map((failure) => failure.error),
			differentConstructors:
				first.SandboxOperationError !== second.SandboxOperationError,
			structuralRecognition: second.isSandboxError(
				error,
				second.SandboxOperationError
			),
			localRecognition: error instanceof first.SandboxOperationError,
			foreignInstanceof: error instanceof second.SandboxOperationError
		}).toStrictEqual({
			providers: ['first', 'second'],
			loadErrors: ['deliberate factory failure'],
			differentConstructors: true,
			structuralRecognition: true,
			localRecognition: true,
			foreignInstanceof: false
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('publishes one service during concurrent bootstrap through independent SDK copies', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-bootstrap-'));

	try {
		const copies = [
			path.join(directory, 'first'),
			path.join(directory, 'second')
		];
		await Promise.all(copies.map((copy) => loadCopy(copy)));
		const modules: readonly unknown[] = await Promise.all(
			copies.map(
				(copy) => import(pathToFileURL(path.join(copy, 'service.js')).href)
			)
		);
		const events = createEventBus();
		let constructions = 0;
		const services = await Promise.all(
			modules.map((module) => {
				if (!isBootstrapModule(module)) {
					throw new TypeError(
						'The compiled service module has no bootstrap function.'
					);
				}

				return Promise.try(() =>
					module.ensureBroker(events, (id) => {
						constructions++;
						return brokerReply(id).service;
					})
				);
			})
		);

		expect({
			ids: services.map((service) => service.id),
			constructions
		}).toStrictEqual({
			ids: [services[0]?.id, services[0]?.id],
			constructions: 1
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
