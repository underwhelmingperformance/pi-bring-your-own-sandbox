import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/package.test.ts'],
		env: { BYOS_PACKAGE_TESTS: '1' }
	}
});
