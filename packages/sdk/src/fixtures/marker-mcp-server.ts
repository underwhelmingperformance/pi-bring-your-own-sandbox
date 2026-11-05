import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

const identifierSchema = Type.Union([Type.String(), Type.Number()]);
const clientParametersSchema = Type.Object({
	protocolVersion: Type.Optional(Type.String())
});
const requestSchema = Type.Object({
	id: Type.Optional(identifierSchema),
	method: Type.String(),
	params: Type.Optional(clientParametersSchema)
});
const marker = process.argv[2];

if (marker === undefined) {
	throw new Error('The MCP marker path is required.');
}

async function respond(
	request: {
		readonly method: string;
		readonly params?: { readonly protocolVersion?: string };
	},
	filename: string
): Promise<unknown> {
	switch (request.method) {
		case 'initialize': {
			return {
				protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
				capabilities: { tools: {} },
				serverInfo: { name: 'marker-fixture', version: '1' }
			};
		}

		case 'tools/list': {
			return {
				tools: [
					{
						name: 'read_marker',
						description: 'Read the controlled marker.',
						inputSchema: { type: 'object', properties: {} }
					}
				]
			};
		}

		case 'tools/call': {
			let text: string;

			try {
				text = await readFile(filename, 'utf8');
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!('code' in error) ||
					!['EPERM', 'EACCES'].includes(String(error.code))
				) {
					throw error;
				}

				text = 'denied';
			}

			return { content: [{ type: 'text', text }] };
		}

		default: {
			throw new Error(`Unexpected MCP fixture method: ${request.method}`);
		}
	}
}

const reader = createInterface({ input: process.stdin });

for await (const line of reader) {
	const request: unknown = JSON.parse(line);

	if (!Value.Check(requestSchema, request) || request.id === undefined) {
		continue;
	}

	const result = await respond(request, marker);

	process.stdout.write(
		`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`
	);
}
