import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'examples/docker/test/provider.test.ts',
			'examples/docker/test/benchmark.test.ts',
			'examples/docker/test/mount.test.ts',
			'examples/docker/test/session.test.ts'
		],
		env: { BYOS_DOCKER_TESTS: '1' },
		testTimeout: 30_000,
		fileParallelism: false
	}
});
