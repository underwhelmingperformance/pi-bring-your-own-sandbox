import { existsSync } from 'node:fs';

const [release, flood] = process.argv.slice(2);

if (release === undefined || flood === undefined) {
	throw new Error('The pipe fixture requires release and flood paths.');
}

process.stdout.write('ready');

const timer = setInterval(() => {
	if (existsSync(release)) {
		clearInterval(timer);

		return;
	}

	if (existsSync(flood)) {
		process.stdout.write(Buffer.alloc(2 * 1024 * 1024));
	}
}, 10);
