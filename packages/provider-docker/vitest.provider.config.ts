import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'test/package.test.ts',
			'test/provider.test.ts',
			'test/benchmark.test.ts',
			'test/session.test.ts'
		],
		env: { BYOS_DOCKER_TESTS: '1' },
		testTimeout: 30_000,
		fileParallelism: false
	}
});
