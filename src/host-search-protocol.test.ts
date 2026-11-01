import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest
} from './contracts.js';
import { HostOperations } from './host-operations.js';
import type { HostProcessRunner } from './host-process.js';
import type { SearchTools } from './host-search.js';
import { HostSearch } from './host-search.js';

class ScriptedProcess implements HostProcessRunner {
	readonly #output: string;
	readonly #outcome: BackendProcessOutcome;
	readonly #beforeResult: (() => void) | undefined;
	readonly calls: ProcessRequest[] = [];

	constructor(
		output: string,
		outcome?: BackendProcessOutcome,
		beforeResult?: () => void
	) {
		this.#output = output;
		this.#outcome = outcome ?? {
			kind: 'exited',
			exit: { kind: 'code', code: 0 }
		};
		this.#beforeResult = beforeResult;
	}

	run(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		this.calls.push(request);

		const bytes = new TextEncoder().encode(this.#output);

		for (let offset = 0; offset < bytes.byteLength; offset++) {
			context.onOutput({
				stream: 'stdout',
				data: bytes.subarray(offset, offset + 1)
			});
		}

		this.#beforeResult?.();

		return Promise.resolve(this.#outcome);
	}
}

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function fixture(processes: HostProcessRunner) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'pi-byos-search-protocol-')
	);

	directories.push(directory);
	await mkdir(path.join(directory, '.git'));

	const operations = new HostOperations();
	const search = new HostSearch(
		directory,
		{ find: 'fixture-fd', grep: 'fixture-rg' },
		processes,
		operations
	);
	const context = {
		operationId: 'search',
		signal: new AbortController().signal,
		deadline: Date.now() + 5000
	};

	return { directory, search, context };
}

function grepOutput(): string[] {
	return [
		'{"type":"begin","data":{"path":{"text":"./file"}}}',
		'{"type":"match","data":{"path":{"text":"./file"},"line_number":1,"lines":{"text":"😀 needle\\n"}}}',
		'{"type":"end","data":{"path":{"text":"./file"},"binary_offset":null}}',
		'{"type":"summary","data":{}}'
	];
}

it('preserves split UTF-8 bytes and invokes only an argv search process inside the selected root', async () => {
	const processes = new ScriptedProcess(`${grepOutput().join('\n')}\n`);
	const { directory, search, context } = await fixture(processes);

	expect({
		result: await search.grep({ pattern: 'needle' }, context),
		calls: processes.calls
	}).toStrictEqual({
		result: {
			matches: [
				{ path: 'file', line: 1, text: '😀 needle', before: [], after: [] }
			],
			truncated: false
		},
		calls: [
			{
				kind: 'argv',
				executable: 'fixture-rg',
				cwd: directory,
				args: [
					'--no-config',
					'--json',
					'--line-number',
					'--color=never',
					'--hidden',
					'--no-mmap',
					'--no-follow',
					'--threads',
					'1',
					'--context',
					'0',
					'--',
					'needle',
					'.'
				]
			}
		]
	});
});

it.each([
	'missing-end',
	'missing-summary',
	'invalid-encoding',
	'invalid-line',
	'invalid-json'
] as const)('rejects malformed grep output: %s', async (malformed) => {
	const rows = grepOutput();

	switch (malformed) {
		case 'missing-end': {
			rows.splice(2, 1);
			break;
		}

		case 'missing-summary': {
			rows.pop();
			break;
		}

		case 'invalid-encoding': {
			rows[1] =
				'{"type":"match","data":{"path":{"text":"./file"},"line_number":1,"lines":{"bytes":"invalid!"}}}';
			break;
		}

		case 'invalid-line': {
			rows[1] =
				'{"type":"match","data":{"path":{"text":"./file"},"line_number":0,"lines":{"text":"needle"}}}';
			break;
		}

		case 'invalid-json': {
			rows[1] = '{';
			break;
		}
	}

	const { search, context } = await fixture(
		new ScriptedProcess(`${rows.join('\n')}\n`)
	);

	await expect(
		search.grep({ pattern: 'needle' }, context)
	).rejects.toMatchObject({ name: 'SandboxOperationError' });
});

it('rejects an incomplete null-delimited find record', async () => {
	const { search, context } = await fixture(new ScriptedProcess('./partial'));

	await expect(search.find({ pattern: '*' }, context)).rejects.toMatchObject({
		name: 'SandboxOperationError'
	});
});

it('replaces retained find candidates when an earlier path arrives after the limit', async () => {
	const { search, context } = await fixture(
		new ScriptedProcess('./z\0./y\0./a\0')
	);

	expect(await search.find({ pattern: '*', limit: 2 }, context)).toStrictEqual({
		paths: ['a', 'y'],
		truncated: true
	});
});

it('applies the grep limit across complete files without depending on enumeration order', async () => {
	const rows = ['z', 'y', 'a'].flatMap((filename) =>
		grepOutput()
			.slice(0, -1)
			.map((row) => row.replaceAll('./file', () => `./${filename}`))
	);

	rows.push('{"type":"summary","data":{}}');

	const { search, context } = await fixture(
		new ScriptedProcess(`${rows.join('\n')}\n`)
	);

	expect(
		await search.grep({ pattern: 'needle', limit: 2 }, context)
	).toStrictEqual({
		matches: [
			{ path: 'a', line: 1, text: '😀 needle', before: [], after: [] },
			{ path: 'y', line: 1, text: '😀 needle', before: [], after: [] }
		],
		truncated: true
	});
});

it('preserves unknown termination after caller cancellation', async () => {
	const controller = new AbortController();
	const processes = new ScriptedProcess(
		'',
		{ kind: 'cancelled', termination: 'unconfirmed' },
		() => {
			controller.abort();
		}
	);
	const { search, context } = await fixture(processes);

	await expect(
		search.grep(
			{ pattern: 'needle' },
			{ ...context, signal: controller.signal }
		)
	).rejects.toMatchObject({
		name: 'UnconfirmedSandboxTerminationError',
		completion: 'unknown'
	});
});

it.each([
	{ tools: {}, methods: [] },
	{ tools: { find: 'fd' }, methods: ['find'] },
	{ tools: { grep: 'rg' }, methods: ['grep'] },
	{ tools: { find: 'fd', grep: 'rg' }, methods: ['find', 'grep'] }
] satisfies readonly { tools: SearchTools; methods: readonly string[] }[])(
	'exposes only available search tools: $methods',
	({ tools, methods }) => {
		const search = new HostSearch(
			'/unused',
			tools,
			new ScriptedProcess(''),
			new HostOperations()
		);

		expect(Object.keys(search.methods() ?? {})).toStrictEqual(methods);
	}
);
