import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SandboxCleanupError } from 'pi-bring-your-own-sandbox/api';
import { expect, it, vi } from 'vitest';

import { DockerResources } from '../src/resources.js';
import { DockerWorkspaceService } from '../src/workspace-service.js';

import { operationContext } from './fixture.js';

vi.mock('node:fs/promises', { spy: true });

it.skipIf(process.platform !== 'darwin')(
	'retains staging recovery if identification fails after creation',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-staging-'));
		const parent = await realpath(directory);
		const workspace = path.join(parent, 'workspace');
		const config = {
			socketPath: '/socket',
			executable: '/docker',
			defaultWorkspaceRelationship: 'copied' as const
		};
		const resources = new DockerResources(
			{ command: vi.fn() },
			config.socketPath,
			parent
		);
		const confirmCleanup = vi.fn();
		const reportRecovery = vi.fn();

		try {
			await mkdir(workspace);
			vi.spyOn(resources, 'checked').mockResolvedValue({
				status: 0,
				stdout: Buffer.from('[]'),
				stderr: Buffer.alloc(0)
			});
			vi.spyOn(resources, 'dispose').mockResolvedValue();
			vi.mocked(lstat).mockRejectedValueOnce(
				new Error('Cannot read staging identity')
			);

			await expect(
				DockerWorkspaceService.open(
					config,
					resources,
					{
						workspace,
						bootstrap: '/bootstrap',
						access: 'read-write',
						protectedPaths: []
					},
					{ ...operationContext(), reportRecovery, confirmCleanup }
				)
			).rejects.toBeInstanceOf(SandboxCleanupError);
			expect(reportRecovery).toHaveBeenCalledWith(resources.recovery);
			expect(confirmCleanup).not.toHaveBeenCalled();

			if (!resources.hostStaging) {
				throw new Error('Expected a staging directory.');
			}

			const entry = await lstat(resources.hostStaging);

			expect(entry.isDirectory()).toBe(true);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	}
);
