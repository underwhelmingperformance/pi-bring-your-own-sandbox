import { execFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

const execute = promisify(execFile);

export async function run(
	cwd: string,
	executable: string,
	arguments_: readonly string[],
	environment = process.env
) {
	try {
		return await execute(executable, arguments_, {
			cwd,
			env: { ...environment, CI: 'true' },
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024
		});
	} catch (error) {
		throw new Error(
			`Package verification failed: ${executable} ${arguments_.join(' ')}`,
			{ cause: error }
		);
	}
}

export async function runIsolatedBuild(
	source: string,
	bin: string,
	script: 'prepare' | 'build'
): Promise<void> {
	const pnpm = process.env['npm_execpath'];

	if (pnpm === undefined || !path.isAbsolute(pnpm)) {
		throw new Error('Run this package test through pnpm test:package.');
	}

	await mkdir(bin);
	await Promise.all([
		symlink(process.execPath, path.join(bin, 'node')),
		symlink(pnpm, path.join(bin, 'pnpm')),
		symlink('/bin/sh', path.join(bin, 'sh'))
	]);

	const environment = { ...process.env, PATH: bin };

	await run(
		source,
		'pnpm',
		[
			'install',
			'--ignore-scripts',
			'--no-frozen-lockfile',
			'--strict-peer-dependencies',
			'--prefer-offline'
		],
		environment
	);
	await run(source, 'pnpm', ['run', script], environment);
}

export async function compilerPackage(): Promise<string> {
	const result = await run(process.cwd(), 'pnpm', ['exec', 'tsc', '--version']);
	const version = /^Version (\S+)$/.exec(result.stdout.trim())?.[1];

	if (version === undefined) {
		throw new Error('The project compiler did not report its version.');
	}

	return `typescript@${version}`;
}

export function retainedReleaseArchive(name: string): string | undefined {
	const directory = process.env['BYOS_RELEASE_ARTIFACTS'];

	return directory === undefined
		? undefined
		: path.resolve(directory, `${name}-1.0.0.tgz`);
}

export async function project(directory: string, sdkOverride?: string) {
	await mkdir(directory);
	await writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({
			name: `byos-package-${path.basename(directory)}-fixture`,
			version: '0.0.0',
			private: true,
			type: 'module',
			packageManager: 'pnpm@12.15.0'
		})
	);

	if (sdkOverride !== undefined) {
		await writeFile(
			path.join(directory, 'pnpm-workspace.yaml'),
			`overrides:
  pi-bring-your-own-sandbox: ${JSON.stringify(`file:${sdkOverride}`)}
`
		);
	}

	await writeFile(
		path.join(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2025',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				strict: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				noPropertyAccessFromIndexSignature: true,
				skipLibCheck: true,
				types: ['node']
			},
			include: ['*.ts', 'workspace/.pi/extensions/**/*.ts']
		})
	);
}

export async function add(
	directory: string,
	packages: readonly string[],
	isDevelopment = false
) {
	await run(directory, 'pnpm', [
		'add',
		...(isDevelopment ? ['--save-dev'] : []),
		...packages,
		'--ignore-scripts',
		'--strict-peer-dependencies',
		'--package-import-method=copy',
		'--prefer-offline'
	]);
}

interface PackedArchive {
	readonly filename: string;
	readonly version: string;
	readonly paths: readonly string[];
}

export function packedArchive(output: string): PackedArchive {
	const result: unknown = JSON.parse(output);

	if (
		!isRecord(result) ||
		typeof result['filename'] !== 'string' ||
		typeof result['version'] !== 'string' ||
		!Array.isArray(result['files'])
	) {
		throw new Error('pnpm pack did not report the archive and packed files.');
	}

	return {
		filename: result['filename'],
		version: result['version'],
		paths: result['files']
			.map((file: unknown) => {
				if (!isRecord(file) || typeof file['path'] !== 'string') {
					throw new Error('pnpm pack reported an invalid file path.');
				}

				return file['path'];
			})
			.toSorted((left, right) => left.localeCompare(right))
	};
}
