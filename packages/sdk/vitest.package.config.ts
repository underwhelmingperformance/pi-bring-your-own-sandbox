import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/package.test.ts', 'src/source-package-integration.test.ts'],
		env: { BYOS_PACKAGE_TESTS: '1' }
	}
});
