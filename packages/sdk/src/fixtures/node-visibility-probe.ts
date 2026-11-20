import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProcessRequest } from '../contracts.js';
import type { SandboxProviderTestFixture } from '../provider-test-contracts.js';

export function nodeVisibilityProbe(
	source: string,
	basename: string,
	executable: string
): NonNullable<SandboxProviderTestFixture['visibility']> {
	const file = path.join(source, basename);
	const processRequest = (
		code: string,
		...values: Uint8Array[]
	): ProcessRequest => ({
		kind: 'argv',
		executable,
		args: [
			'--input-type=module',
			'-e',
			code,
			basename,
			...values.map((value) => Buffer.from(value).toString('base64'))
		]
	});
	const write =
		"import {readFile,writeFile,rename,rm} from 'node:fs/promises';import {randomUUID} from 'node:crypto';const temp=process.argv[1]+'.'+randomUUID();await writeFile(temp,Buffer.from(process.argv[2],'base64'),{flag:'wx'});try{await rename(temp,process.argv[1]);}finally{await rm(temp,{force:true});}";

	return {
		targetPath: basename,
		findTarget: 'searchable-file',
		readSource: () => readFile(file),
		async replaceSource(bytes) {
			const temporary = path.join(source, randomUUID());

			await writeFile(temporary, bytes);
			await rename(temporary, file);
		},
		readTarget: processRequest(
			"import { readFile } from 'node:fs/promises';process.stdout.write(await readFile(process.argv[1]));"
		),
		writeTarget: (bytes) => processRequest(write, bytes),
		waitForReplacement: (bytes) =>
			processRequest(
				write +
					`process.stdout.write('ready');
						for (;;) {
							const current = await readFile(process.argv[1]);
							if (current.toString('base64') !== process.argv[2]) {
								process.stdout.write(current);
								break;
							}
							await new Promise(resolve => setTimeout(resolve, 10));
						}`,
				bytes
			)
	};
}
