import { expect, it } from 'vitest';

import workspace from '../../../tsconfig.json' with { type: 'json' };
import build from '../tsconfig.build.json' with { type: 'json' };

it('uses the workspace compiler options when building the SDK', () => {
	const { noEmit: workspaceNoEmit, ...workspaceOptions } =
		workspace.compilerOptions;
	const {
		noEmit: buildNoEmit,
		rootDir: _rootDirectory,
		outDir: _outDirectory,
		declaration: _declaration,
		sourceMap: _sourceMap,
		inlineSources: _inlineSources,
		composite: _composite,
		...buildOptions
	} = build.compilerOptions;

	expect({
		compilerOptions: buildOptions,
		emission: [workspaceNoEmit, buildNoEmit]
	}).toStrictEqual({
		compilerOptions: workspaceOptions,
		emission: [true, false]
	});
});
