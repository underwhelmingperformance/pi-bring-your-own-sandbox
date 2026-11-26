import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ProcessRequest } from 'pi-bring-your-own-sandbox/provider';
import type { SandboxProviderTestFixture } from 'pi-bring-your-own-sandbox/testing';

const run = promisify(execFile);
const attribute = 'user.byos-conformance';

async function seedAttribute(file: string) {
	if (process.platform === 'darwin') {
		await run('/usr/bin/xattr', ['-w', attribute, 'original', file]);

		return async () => {
			const { stdout } = await run('/usr/bin/xattr', ['-p', attribute, file], {
				encoding: 'buffer'
			});

			return { [attribute]: new Uint8Array(stdout) };
		};
	}

	if (process.platform !== 'linux') {
		return;
	}

	const arguments_ = [file, attribute];

	try {
		const { stdout } = await run('python3', [
			'-c',
			`import errno, os, sys
try:
    os.setxattr(sys.argv[1], sys.argv[2], b"original")
except OSError as error:
    if error.errno != errno.ENOTSUP:
        raise
    print("unsupported")`,
			...arguments_
		]);

		if (stdout.trim() === 'unsupported') {
			return;
		}
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}

	return async () => {
		const { stdout } = await run(
			'python3',
			[
				'-c',
				'import os, sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], sys.argv[2]))',
				...arguments_
			],
			{ encoding: 'buffer' }
		);

		return { [attribute]: new Uint8Array(stdout) };
	};
}

export function nodeVisibilityProbe(
	source: string,
	basename: string,
	executable: string
): NonNullable<SandboxProviderTestFixture['visibility']> {
	const file = path.join(source, basename);
	const processRequest = (
		code: string,
		...arguments_: string[]
	): ProcessRequest => ({
		kind: 'argv',
		executable,
		args: ['--input-type=module', '-e', code, basename, ...arguments_]
	});
	const write =
		"import {readFile,writeFile,rename,rm} from 'node:fs/promises';import {randomUUID} from 'node:crypto';const temp=process.argv[1]+'.'+randomUUID();await writeFile(temp,Buffer.from(process.argv[2],'base64'),{flag:'wx'});try{await rename(temp,process.argv[1]);}finally{await rm(temp,{force:true});}";
	const readReplacement = `
		async function readReplacement(expected, staleReadLimitMs = Infinity, report) {
			const start = performance.now();
			for (;;) {
				const offset = performance.now() - start;
				const current = await readFile(process.argv[1]);
				const contents = current.toString('base64');
				report?.(offset, performance.now() - start, contents);
				if (contents === expected || offset > staleReadLimitMs) return current;
				await new Promise(resolve => setTimeout(resolve, 10));
			}
		}
	`;

	return {
		targetPath: basename,
		findTarget: 'searchable-file',
		readSource: () => readFile(file),
		async replaceSource(bytes) {
			const temporary = path.join(source, randomUUID());

			await writeFile(temporary, bytes);
			await rename(temporary, file);
		},
		async linkSource() {
			const alias = path.join(source, randomUUID());

			await link(file, alias);

			const readAttributes = await seedAttribute(alias);

			return async () => {
				const entry = await stat(alias, { bigint: true });

				return {
					identity: [entry.dev, entry.ino].join('/'),
					content: new Uint8Array(await readFile(alias)),
					mode: Number(entry.mode),
					uid: Number(entry.uid),
					gid: Number(entry.gid),
					links: Number(entry.nlink),
					...(readAttributes && { xattrs: await readAttributes() })
				};
			};
		},
		readTarget: processRequest(
			"import { readFile } from 'node:fs/promises';process.stdout.write(await readFile(process.argv[1]));"
		),
		pollHostReplacement: (bytes, staleReadLimitMs) =>
			processRequest(
				"import { readFile } from 'node:fs/promises';" +
					readReplacement +
					`await readReplacement(process.argv[2], Number(process.argv[3]), (offset, elapsed, contents) => {
						process.stdout.write([offset, elapsed, contents].join('\\t') + '\\n');
					});`,
				Buffer.from(bytes).toString('base64'),
				String(staleReadLimitMs)
			),
		writeTarget: (bytes) =>
			processRequest(write, Buffer.from(bytes).toString('base64')),
		stageSave(bytes) {
			const temporary = basename + '.' + randomUUID();

			return {
				prepare: processRequest(
					"import {writeFile} from 'node:fs/promises'; await writeFile(process.argv[2], Buffer.from(process.argv[3], 'base64'), {flag: 'wx'});",
					temporary,
					Buffer.from(bytes).toString('base64')
				),
				commit: processRequest(
					"import {rename} from 'node:fs/promises'; await rename(process.argv[2], process.argv[1]);",
					temporary
				)
			};
		},
		waitForReplacement: (bytes, replacement) =>
			processRequest(
				write +
					readReplacement +
					`process.stdout.write('ready');
					process.stdout.write(await readReplacement(process.argv[3]));`,
				Buffer.from(bytes).toString('base64'),
				Buffer.from(replacement).toString('base64')
			)
	};
}
