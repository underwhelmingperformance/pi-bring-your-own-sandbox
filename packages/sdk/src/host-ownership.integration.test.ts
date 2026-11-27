import { expect, it } from 'vitest';

import { snapshotBackend } from './backend-snapshot.js';
import type { SandboxContext } from './contracts.js';
import { discoverBroker } from './discovery.js';
import * as embeddingHost from './embedding-host.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { bindProtocolAddress } from './protocol-address.js';

it('gives the embedding host an idempotent close handle across SDK copies', async () => {
	const [hostSdk, peer] = await Promise.all([
		loadSdkInstance(),
		loadSdkInstance()
	]);
	const backend = new MemoryBackend();
	const observations: {
		host?: ReturnType<typeof embeddingHost.initialiseSandboxHost>;
		context?: SandboxContext;
		client?: ReturnType<typeof peer.createSandboxClient>;
		owner: string | undefined;
	} = { owner: undefined };
	let disposals = 0;

	await withPiRuntime(
		[
			{
				name: 'embedding-host',
				factory(pi) {
					const source = '<inline:embedding-host>';

					bindProtocolAddress(pi.events, source);
					observations.host = hostSdk.initialiseSandboxHost(pi, source, {});
					pi.on('session_start', async (_event, context) => {
						const status = await discoverBroker(pi.events)?.status(context);

						observations.context = context;
						observations.owner = status?.protocol?.extensionSource;
					});
				}
			},
			{
				name: 'z-provider',
				factory(pi) {
					const source = '<inline:z-provider>';

					observations.client = peer.createSandboxClient(pi, source);
					peer.registerSandboxProvider(pi, source, {
						id: 'fixture',
						label: 'Fixture',
						profiles: { open: [backend.profile], copy: [] },
						validateConfig: () => ({}),
						open: () =>
							Promise.resolve({
								...snapshotBackend(backend),
								dispose() {
									disposals++;

									return Promise.resolve();
								}
							})
					});
				}
			}
		],
		async (runtime, errors) => {
			const { host, context, client } = observations;
			const close = expect.any(Function) as unknown;

			expect({
				host,
				isFrozen: Object.isFrozen(host),
				legacyExport: Object.hasOwn(embeddingHost, 'closeSandboxSession'),
				owner: observations.owner,
				errors
			}).toStrictEqual({
				host: { close },
				isFrozen: true,
				legacyExport: false,
				owner: '<inline:z-provider>',
				errors: []
			});

			if (host === undefined || context === undefined || client === undefined) {
				throw new Error('Pi did not initialise the host and consumer.');
			}

			await client.get(context);

			const first = host.close();
			const second = host.close();

			expect(second).toBe(first);
			await expect(first).resolves.toStrictEqual({
				confirmed: true,
				recoveries: [],
				failures: []
			});
			await runtime.dispose();
			expect({ disposals, result: host.close() === first }).toStrictEqual({
				disposals: 1,
				result: true
			});
		},
		{ bindFixtureSources: false }
	);
});

it('rejects host initialisation after Pi finishes loading extension factories', async () => {
	await withPiRuntime(
		[
			{
				name: 'late-host',
				factory(pi) {
					pi.on('session_start', () => {
						expect(() =>
							embeddingHost.initialiseSandboxHost(pi, '<inline:late-host>', {})
						).toThrow(
							expect.objectContaining({
								name: 'SandboxInitialisationError',
								operation: 'configure'
							})
						);
					});
				}
			}
		],
		(_runtime, errors) => {
			expect(errors).toStrictEqual([]);

			return Promise.resolve();
		}
	);
});
