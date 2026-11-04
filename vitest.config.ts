import { configDefaults, defineConfig } from 'vitest/config';

// The same files as the test:integration script. They start Pi runtimes, RPC
// processes and fresh SDK copies, which take seconds under a full parallel run.
const integration = [
	'src/*integration.test.ts',
	'src/user-shell-rpc.test.ts',
	'examples/consumer/test/integration.test.ts'
];

export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					exclude: [...configDefaults.exclude, ...integration]
				}
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: integration,
					testTimeout: 30_000,
					hookTimeout: 30_000
				}
			}
		]
	}
});
