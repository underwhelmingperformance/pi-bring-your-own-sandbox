import path from 'node:path';

import type { Rule } from 'eslint';

import manifest from '../packages/sdk/package.json' with { type: 'json' };

const sdk = path.resolve(import.meta.dirname, '../packages/sdk');
const examples = path.join(sdk, 'examples');
const piEntry = path.join(sdk, 'src/pi-tools.ts');
const privileged = path.join(sdk, 'src/integration/privileged');
const publicEntries = new Set(
	Object.keys(manifest.exports).map(
		(subpath) => manifest.name + subpath.slice(1)
	)
);

function isInside(directory: string, file: string): boolean {
	const relative = path.relative(directory, file);

	return (
		relative !== '..' &&
		!relative.startsWith('..' + path.sep) &&
		!path.isAbsolute(relative)
	);
}

export const sdkImportBoundary: Rule.RuleModule = {
	meta: {
		type: 'problem',
		schema: [],
		messages: {
			publicEntry: 'Import the SDK through a public entry point.',
			piIntegration:
				'Import SDK internals through src/integration/privileged.ts.'
		}
	},
	create(context) {
		const isPiEntry = context.filename === piEntry;
		const isExample = isInside(examples, context.filename);

		function check(node: Rule.Node): void {
			if (node.type !== 'Literal' || typeof node.value !== 'string') {
				return;
			}

			const specifier = node.value;

			if (
				specifier === manifest.name ||
				specifier.startsWith(manifest.name + '/')
			) {
				if (!publicEntries.has(specifier)) {
					context.report({ node, messageId: 'publicEntry' });
				}

				return;
			}

			if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
				return;
			}

			const file = path.resolve(path.dirname(context.filename), specifier);

			if (isPiEntry) {
				if (file !== privileged + '.js' && file !== privileged + '.ts') {
					context.report({ node, messageId: 'piIntegration' });
				}

				return;
			}

			if (isInside(sdk, file) && !(isExample && isInside(examples, file))) {
				context.report({ node, messageId: 'publicEntry' });
			}
		}

		return {
			[[
				'ImportDeclaration > Literal',
				'ExportNamedDeclaration > Literal',
				'ExportAllDeclaration > Literal',
				'ImportExpression > Literal.source',
				'CallExpression[callee.name="require"] > Literal.arguments',
				'TSImportType > Literal',
				'TSImportType > TSLiteralType > Literal',
				'TSExternalModuleReference > Literal'
			].join(', ')]: check
		};
	}
};
