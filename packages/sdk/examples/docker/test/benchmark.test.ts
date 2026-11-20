import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { createDockerProvider } from '../src/provider.js';

import { DockerFixture, operationContext } from './fixture.js';

it.skipIf(
	process.env['BYOS_DOCKER_TESTS'] !== '1' ||
		process.env['BYOS_DOCKER_BENCHMARK'] !== '1'
)(
	'measures a copied workspace with the local Docker daemon',
	async () => {
		const fixture = await DockerFixture.create();
		const provider = createDockerProvider(() => fixture.providerClient());
		const source = 'export default ' + JSON.stringify('x'.repeat(1024)) + ';\n';
		const times: Record<string, number> = {};

		async function measure<T>(operation: string, run: () => Promise<T>) {
			const start = performance.now();
			const result = await run();

			times[operation] = Math.round((performance.now() - start) * 10) / 10;

			return result;
		}

		try {
			await Promise.all(
				Array.from({ length: 100 }, (_, index) =>
					writeFile(
						path.join(fixture.workspace, 'nested', String(index) + '.mjs'),
						source
					)
				)
			);
			await writeFile(
				path.join(fixture.workspace, 'package.json'),
				JSON.stringify({
					name: 'benchmark',
					version: '1.0.0',
					files: ['nested']
				})
			);

			const backend = await measure('openMs', () =>
				provider.open(
					{
						sessionId: randomUUID(),
						generationId: randomUUID(),
						hostWorkspace: fixture.workspace,
						configuration: fixture.config,
						policy: {
							workspaceRelationship: 'copied',
							workspaceAccess: 'read-write',
							networkAccess: 'denied',
							filesystemScope: 'workspace-only'
						}
					},
					{
						...operationContext(),
						reportRecovery() {
							return;
						},
						confirmCleanup() {
							return;
						}
					}
				)
			);

			try {
				const files = backend.files?.read;
				const search = backend.search;

				if (!files || !search?.grep) {
					throw new Error('The benchmark requires file and search operations.');
				}

				const read = () =>
					files.readFile('/workspace/nested/0.mjs', operationContext());
				const expected = new TextEncoder().encode(source);

				expect(await measure('firstReadMs', read)).toStrictEqual(expected);
				await measure('twentyReadsMs', async () => {
					for (let index = 0; index < 20; index++) {
						expect(await read()).toStrictEqual(expected);
					}
				});

				const grep = search.grep;
				const found = await measure('searchMs', () =>
					grep(
						{
							path: '/workspace/nested',
							pattern: 'export default',
							literal: true,
							limit: 101
						},
						operationContext()
					)
				);

				const byPath = (left: { path: string }, right: { path: string }) =>
					left.path.localeCompare(right.path);

				expect({
					...found,
					matches: found.matches.toSorted(byPath)
				}).toStrictEqual({
					matches: Array.from({ length: 100 }, (_, index) => ({
						path: String(index) + '.mjs',
						line: 1,
						text: source.trimEnd(),
						before: [],
						after: []
					})).toSorted(byPath),
					truncated: false
				});

				const build = await measure('packageBuildMs', () =>
					backend.exec(
						{
							kind: 'argv',
							executable: '/usr/local/bin/npm',
							args: [
								'pack',
								'--offline',
								'--ignore-scripts',
								'--cache=/tmp/npm-cache'
							]
						},
						{
							...operationContext(),
							onOutput() {
								return;
							}
						}
					)
				);

				expect(build).toStrictEqual({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});

				const artifact = await files.stat(
					'/workspace/benchmark-1.0.0.tgz',
					operationContext()
				);

				expect({
					kind: artifact.kind,
					hasContent: artifact.size > 0
				}).toStrictEqual({ kind: 'file', hasContent: true });
				process.stdout.write(JSON.stringify(times) + '\n');
			} finally {
				await backend.dispose(operationContext());
			}
		} finally {
			await fixture.cleanup();
		}
	},
	120_000
);
