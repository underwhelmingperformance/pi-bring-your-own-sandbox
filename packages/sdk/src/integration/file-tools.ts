import { homedir } from 'node:os';
import path from 'node:path';

import type {
	EditToolDetails,
	EditToolInput,
	ExtensionAPI,
	ExtensionContext,
	GrepToolDetails,
	GrepToolInput,
	ToolDefinition
} from '@earendil-works/pi-coding-agent';
import {
	createEditTool,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	defineTool,
	formatSize,
	generateDiffString,
	renderDiff,
	truncateHead,
	truncateLine,
	truncateToVisualLines
} from '@earendil-works/pi-coding-agent';
import type { Sandbox } from 'pi-bring-your-own-sandbox/consumer';
import { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';
import type {
	GrepRequest,
	ProcessRequest
} from 'pi-bring-your-own-sandbox/provider';
import {
	isSandboxError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	UnsupportedSandboxCapabilityError
} from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	encodePosixArgv
} from 'pi-bring-your-own-sandbox/provider-kit';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { GrepOutput } from '../grep-output.js';
import { sandboxRipgrepArguments } from '../ripgrep-arguments.js';

type GrepResult = Awaited<ReturnType<Sandbox['search']['grep']>>;

const pngSignature = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const grepLineLimit = 500;

function isStaticPng(bytes: Buffer): boolean {
	if (
		bytes.length < 16 ||
		bytes.readUInt32BE(8) !== 13 ||
		bytes.toString('latin1', 12, 16) !== 'IHDR'
	) {
		return false;
	}

	for (let offset = 8; offset + 8 <= bytes.length;) {
		const chunk = bytes.toString('latin1', offset + 4, offset + 8);

		if (chunk === 'acTL') {
			return false;
		}

		if (chunk === 'IDAT') {
			return true;
		}

		offset += bytes.readUInt32BE(offset) + 12;
	}

	return true;
}

function isBmp(bytes: Buffer): boolean {
	if (bytes.length < 26) {
		return false;
	}

	const size = bytes.readUInt32LE(2);
	const pixels = bytes.readUInt32LE(10);
	const header = bytes.readUInt32LE(14);

	if (pixels < 14 + header || (size !== 0 && (size < 26 || pixels >= size))) {
		return false;
	}

	const planes = header === 12 ? 22 : 26;

	return (
		(header === 12 || (header >= 40 && header <= 124 && bytes.length >= 30)) &&
		bytes.readUInt16LE(planes) === 1 &&
		[1, 4, 8, 16, 24, 32].includes(bytes.readUInt16LE(planes + 2))
	);
}

// Pi's byte detector is private. Its exported detectSupportedImageMimeTypeFromFile
// opens a host path, so this detector uses the bytes from the facade.
function detectImageMimeType(input: Buffer): string | undefined {
	const bytes = input.subarray(0, 4100);

	if (bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
		return isStaticPng(bytes) ? 'image/png' : undefined;
	}

	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return bytes[3] === 0xf7 ? undefined : 'image/jpeg';
	}

	const prefix = bytes.toString('latin1', 0, 6);

	if (prefix === 'GIF87a' || prefix === 'GIF89a') {
		return 'image/gif';
	}

	if (prefix.startsWith('RIFF') && bytes.toString('latin1', 8, 12) === 'WEBP') {
		return 'image/webp';
	}

	return prefix.startsWith('BM') && isBmp(bytes) ? 'image/bmp' : undefined;
}

class FileToolWorkspace {
	readonly #cachedReads = new Map<string, Promise<Buffer>>();
	readonly sandbox: Sandbox;
	readonly cwd: string;
	readonly options: { readonly signal?: AbortSignal };

	read = async (filename: string): Promise<Buffer> => {
		const bytes = await this.sandbox.files.readFile(
			this.targetPath(filename),
			this.options
		);

		return Buffer.from(bytes);
	};

	readSnapshot = (filename: string): Promise<Buffer> => {
		let pending = this.#cachedReads.get(filename);

		if (pending === undefined) {
			pending = this.read(filename);
			this.#cachedReads.set(filename, pending);
		}

		return pending;
	};

	write = (filename: string, text: string): Promise<void> =>
		this.sandbox.files.writeFile(
			this.targetPath(filename),
			Buffer.from(text),
			this.options
		);

	mkdir = (directory: string): Promise<void> =>
		this.sandbox.files.mkdir(this.targetPath(directory), this.options);

	constructor(sandbox: Sandbox, cwd: string, signal: AbortSignal | undefined) {
		this.sandbox = sandbox;
		this.cwd = cwd;
		this.options = signal === undefined ? {} : { signal };
	}

	targetPath(filename: string): string {
		const hostPath = path.resolve(this.cwd, filename);
		const relative = path.relative(this.cwd, hostPath);
		const flavor = path[this.sandbox.workspace.pathFlavor];

		return relative === '..' ||
			relative.startsWith('..' + path.sep) ||
			path.isAbsolute(relative)
			? hostPath
			: flavor.resolve(
					this.sandbox.workspace.root,
					...relative.split(path.sep)
				);
	}

	async hasFile(filename: string): Promise<boolean> {
		try {
			await this.sandbox.files.stat(this.targetPath(filename), this.options);

			return true;
		} catch (error) {
			if (isSandboxError(error, SandboxPathNotFoundError)) {
				return false;
			}

			throw error;
		}
	}
}

function grepPath(filename: string, cwd: string): string {
	const expanded =
		filename === '~'
			? homedir()
			: filename.startsWith('~/')
				? path.join(homedir(), filename.slice(2))
				: filename;

	return path.resolve(cwd, expanded);
}

type RipgrepRequest = (
	arguments_: readonly string[],
	cwd?: string
) => ProcessRequest;

function ripgrepRequest({ profile }: Sandbox): RipgrepRequest | undefined {
	if (profile.processKinds.includes('argv')) {
		return (arguments_, cwd) => ({
			kind: 'argv',
			executable: 'rg',
			args: arguments_,
			...(cwd !== undefined && { cwd })
		});
	}

	const dialect = profile.shells.find(
		(shell) => shell === 'sh' || shell === 'bash'
	);

	if (dialect !== undefined && profile.processKinds.includes('shell')) {
		return (arguments_, cwd) => ({
			kind: 'shell',
			dialect,
			command: 'exec ' + encodePosixArgv(['rg', ...arguments_]),
			...(cwd !== undefined && { cwd })
		});
	}

	return;
}

async function hasTargetRipgrep(
	workspace: FileToolWorkspace,
	probe: ProcessRequest
): Promise<boolean> {
	try {
		const result = await workspace.sandbox.exec(probe, {
			...workspace.options,
			maxCaptureBytes: 256
		});

		if (result.exit.kind === 'code' && result.exit.code === 0) {
			return true;
		}

		if (
			probe.kind === 'shell' &&
			result.exit.kind === 'code' &&
			result.exit.code === 127
		) {
			return false;
		}

		throw new SandboxOperationError({
			operation: 'grep',
			providerId: workspace.sandbox.providerId
		});
	} catch (error) {
		if (
			isSandboxError(error, SandboxPathNotFoundError) ||
			isSandboxError(error, UnsupportedSandboxCapabilityError)
		) {
			return false;
		}

		throw error;
	}
}

async function targetGrep(
	workspace: FileToolWorkspace,
	request: GrepRequest,
	ripgrepAvailability: Map<string, boolean>
): Promise<GrepResult> {
	const { sandbox, options } = workspace;
	const ripgrep = ripgrepRequest(sandbox);

	if (ripgrep === undefined) {
		return sandbox.search.grep(request, options);
	}

	const target = request.path ?? sandbox.workspace.root;
	// Each acquisition returns a new facade for the same backend.
	const key = JSON.stringify([sandbox.generationId, sandbox.backendId]);
	const hasRipgrep =
		ripgrepAvailability.get(key) ??
		(await hasTargetRipgrep(workspace, ripgrep(['--version'])));

	ripgrepAvailability.set(key, hasRipgrep);

	if (!hasRipgrep) {
		return sandbox.search.grep(request, options);
	}

	const stat = await sandbox.files.stat(target, options);

	if (stat.kind === 'other') {
		throw new SandboxOperationError({
			operation: 'grep',
			providerId: sandbox.providerId
		});
	}

	const flavor = path[sandbox.workspace.pathFlavor];
	const isDirectory = stat.kind === 'directory';
	const cwd = isDirectory ? target : flavor.dirname(target);
	const operand = isDirectory ? '.' : flavor.basename(target);
	const output = new GrepOutput(0, request.limit ?? 100);
	const result = await sandbox.exec(
		ripgrep(sandboxRipgrepArguments(request, operand), cwd),
		{
			...options,
			maxCaptureBytes: 16_384,
			onOutput(frame) {
				if (frame.stream === 'stdout') {
					output.write(frame.data);
				}
			}
		}
	);

	if (result.exit.kind !== 'code' || ![0, 1].includes(result.exit.code)) {
		throw new SandboxOperationError(
			{ operation: 'grep', providerId: sandbox.providerId },
			{ cause: new Error(Buffer.from(result.stderr).toString('utf8')) }
		);
	}

	const matches = output.finish();
	const context = request.context ?? 0;

	if (context === 0) {
		return matches;
	}

	const files = new Map<string, readonly string[]>();

	for (const match of matches.matches) {
		if (files.has(match.path)) {
			continue;
		}

		const name = isDirectory ? flavor.resolve(target, match.path) : target;
		const relative = flavor.relative(target, name);

		if (
			relative === '..' ||
			relative.startsWith('..' + flavor.sep) ||
			flavor.isAbsolute(relative)
		) {
			throw new SandboxOperationError({
				operation: 'grep',
				providerId: sandbox.providerId
			});
		}

		const data = await sandbox.files.readFile(name, options);

		files.set(
			match.path,
			Buffer.from(data).toString('utf8').replaceAll('\r\n', '\n').split('\n')
		);
	}

	return {
		...matches,
		matches: matches.matches.map((match) => {
			const lines = files.get(match.path) ?? [];
			const index = match.line - 1;

			return {
				...match,
				text: lines[index] ?? match.text,
				before: lines.slice(Math.max(0, index - context), index),
				after: lines.slice(index + 1, index + 1 + context)
			};
		})
	};
}

function grepResult(result: GrepResult, limit: number) {
	const details: GrepToolDetails = {};
	const lines: string[] = [];

	for (const match of result.matches) {
		const filename = match.path.replaceAll('\\', '/');
		const first = match.line - match.before.length;

		for (const [index, text] of [
			...match.before,
			match.text,
			...match.after
		].entries()) {
			const number = first + index;
			const separator = number === match.line ? ':' : '-';
			const shortened = truncateLine(text.replaceAll('\r', ''));

			if (shortened.wasTruncated) {
				details.linesTruncated = true;
			}

			lines.push(
				`${filename}${separator}${String(number)}${separator} ${shortened.text}`
			);
		}
	}

	if (lines.length === 0) {
		return {
			content: [{ type: 'text' as const, text: 'No matches found' }],
			details: undefined
		};
	}

	const truncation = truncateHead(lines.join('\n'), {
		maxLines: Number.MAX_SAFE_INTEGER
	});
	const notices: string[] = [];

	if (result.truncated || result.matches.length >= limit) {
		details.matchLimitReached = limit;
		notices.push(
			`${String(limit)} matches limit reached. Use limit=${String(limit * 2)} for more, or refine pattern`
		);
	}

	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}

	if (details.linesTruncated === true) {
		notices.push(
			`Some lines truncated to ${String(grepLineLimit)} chars. Use read tool to see full lines`
		);
	}

	const text =
		notices.length === 0
			? truncation.content
			: `${truncation.content}\n\n[${notices.join('. ')}]`;

	return {
		content: [{ type: 'text' as const, text }],
		details: notices.length === 0 ? undefined : details
	};
}

function grepRequest(
	input: GrepToolInput,
	workspace: FileToolWorkspace
): GrepRequest {
	return {
		pattern: input.pattern,
		path: workspace.targetPath(grepPath(input.path ?? '.', workspace.cwd)),
		...(input.glob && { glob: input.glob }),
		...(input.ignoreCase !== undefined && { ignoreCase: input.ignoreCase }),
		...(input.literal !== undefined && { literal: input.literal }),
		context: Math.max(0, Math.floor(input.context ?? 0)),
		limit: Math.max(1, Math.ceil(input.limit ?? 100))
	};
}

type EditPreviewOutcome =
	{ readonly diff: string } | { readonly unavailable: string };

interface EditPreviewRequest {
	readonly key: string;
	outcome?: EditPreviewOutcome;
}

interface EditPreviewState {
	preview?: EditPreviewRequest;
}

function displayLines(text: string): string {
	return text
		.split('\n')
		.map((line) => cleanDisplayText(line))
		.join('\n');
}

function textComponent(text: string, padding: number) {
	let cached: { readonly width: number; readonly lines: string[] } | undefined;

	return {
		render(width: number) {
			if (cached?.width !== width) {
				const lines =
					text === ''
						? []
						: truncateToVisualLines(
								text,
								Number.MAX_SAFE_INTEGER,
								width,
								padding
							).visualLines;

				cached = { width, lines };
			}

			return cached.lines;
		},
		invalidate() {
			cached = undefined;
		}
	};
}

async function previewEdit(
	workspace: FileToolWorkspace,
	callId: string,
	input: EditToolInput,
	signal: AbortSignal
): Promise<string> {
	let before = '';
	let after = '';
	const dryRun = createEditTool(workspace.cwd, {
		operations: {
			access: (file) =>
				workspace.sandbox.files.access(
					workspace.targetPath(file),
					'read',
					workspace.options
				),
			async readFile(file) {
				const bytes = await workspace.read(file);

				before = bytes.toString('utf8');

				return bytes;
			},
			writeFile(_file, text) {
				after = text;

				return Promise.resolve();
			}
		}
	});

	await dryRun.execute(callId, input, signal);

	return displayLines(generateDiffString(before, after).diff);
}

function routedEditDefinition(
	base: ReturnType<typeof createEditToolDefinition>,
	preview: (
		callId: string,
		cwd: string,
		input: EditToolInput
	) => Promise<string>
): ToolDefinition<
	typeof base.parameters,
	EditToolDetails | undefined,
	EditPreviewState
> {
	return {
		...base,
		renderCall(arguments_: EditToolInput | undefined, theme, context) {
			const title = theme.fg('toolTitle', theme.bold('edit'));
			const header =
				typeof arguments_?.path === 'string'
					? title + ' ' + cleanDisplayText(arguments_.path)
					: title;

			if (
				!context.argsComplete ||
				!Value.Check(base.parameters, arguments_) ||
				arguments_.path.length === 0 ||
				arguments_.edits.length === 0
			) {
				return textComponent(header, context.outputPad);
			}

			const key = JSON.stringify({
				path: arguments_.path,
				edits: arguments_.edits
			});

			if (context.state.preview?.key !== key) {
				const request: EditPreviewRequest = { key };

				context.state.preview = request;

				const update = async () => {
					try {
						request.outcome = {
							diff: await preview(context.toolCallId, context.cwd, arguments_)
						};
					} catch {
						request.outcome = {
							unavailable: 'Preview unavailable\n' + cleanDisplayText(key)
						};
					}

					if (context.state.preview === request) {
						context.invalidate();
					}
				};

				void update();
			}

			const outcome = context.state.preview.outcome;
			const body =
				outcome === undefined
					? ''
					: 'diff' in outcome
						? renderDiff(outcome.diff)
						: outcome.unavailable;

			return textComponent(
				body === '' ? header : header + '\n' + body,
				context.outputPad
			);
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) {
				const message = result.content
					.filter((block) => block.type === 'text')
					.map((block) => displayLines(block.text))
					.join('\n');

				return textComponent(theme.fg('error', message), context.outputPad);
			}

			const diff = displayLines(result.details?.diff ?? '');
			const outcome = context.state.preview?.outcome;
			const isDisplayed =
				outcome !== undefined && 'diff' in outcome && diff === outcome.diff;

			return textComponent(
				isDisplayed || diff === '' ? '' : renderDiff(diff),
				context.outputPad
			);
		}
	};
}

export function registerSandboxFileTools(
	pi: ExtensionAPI,
	extensionPath: string
): void {
	const client = createSandboxClient(pi, extensionPath);
	const ripgrepAvailability = new Map<string, boolean>();
	let session:
		| { readonly context: ExtensionContext; readonly abort: AbortController }
		| undefined;

	pi.on('session_start', (_event, context) => {
		session?.abort.abort();
		ripgrepAvailability.clear();
		session = { context, abort: new AbortController() };
	});
	pi.on('session_shutdown', () => {
		session?.abort.abort();
		session = undefined;
		ripgrepAvailability.clear();
	});

	async function getWorkspace(
		context: ExtensionContext,
		signal?: AbortSignal
	): Promise<FileToolWorkspace> {
		const options = signal === undefined ? {} : { signal };
		const sandbox = await client.get(context, options);

		if (sandbox.workspace.relationship !== 'shared') {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'acquire',
				providerId: sandbox.providerId
			});
		}

		return new FileToolWorkspace(sandbox, context.cwd, signal);
	}

	function route<Parameters extends TSchema, Details, State>(
		base: ToolDefinition<Parameters, Details, State>,
		create: (
			workspace: FileToolWorkspace
		) => Pick<ToolDefinition<Parameters, Details, State>, 'execute'>
	): void {
		pi.registerTool(
			defineTool({
				...base,
				defaultActive: false,
				async execute(id, input, signal, update, context) {
					const workspace = await getWorkspace(context, signal);
					const tool = create(workspace);

					return tool.execute(id, input, signal, update, context);
				}
			})
		);
	}

	const cwd = '/unused';

	route(createReadToolDefinition(cwd), (workspace) => {
		const autoResizeImages = pi.getSettings().images?.autoResize;

		return createReadToolDefinition(workspace.cwd, {
			...(autoResizeImages !== undefined && { autoResizeImages }),
			operations: {
				readFile: workspace.readSnapshot,
				access: (file) =>
					workspace.sandbox.files.access(
						workspace.targetPath(file),
						'read',
						workspace.options
					),
				async detectImageMimeType(file) {
					return detectImageMimeType(await workspace.readSnapshot(file));
				}
			}
		});
	});
	route(createWriteToolDefinition(cwd), (workspace) =>
		createWriteToolDefinition(workspace.cwd, {
			operations: { writeFile: workspace.write, mkdir: workspace.mkdir }
		})
	);

	const edit = routedEditDefinition(
		createEditToolDefinition(cwd),
		async (id, currentCwd, input) => {
			const current = session;

			if (current === undefined || current.context.cwd !== currentCwd) {
				throw new SandboxOperationError({ operation: 'readFile' });
			}

			const signal = current.abort.signal;
			const workspace = await getWorkspace(current.context, signal);

			return previewEdit(workspace, id, input, signal);
		}
	);

	route(edit, (workspace) =>
		createEditToolDefinition(workspace.cwd, {
			operations: {
				readFile: workspace.read,
				writeFile: workspace.write,
				async access(file) {
					const target = workspace.targetPath(file);

					await workspace.sandbox.files.access(
						target,
						'read',
						workspace.options
					);
					await workspace.sandbox.files.access(
						target,
						'write',
						workspace.options
					);
				}
			}
		})
	);
	route(createLsToolDefinition(cwd), (workspace) =>
		createLsToolDefinition(workspace.cwd, {
			operations: {
				exists: (file) => workspace.hasFile(file),
				async stat(file) {
					const result = await workspace.sandbox.files.stat(
						workspace.targetPath(file),
						workspace.options
					);

					return { isDirectory: () => result.kind === 'directory' };
				},
				async readdir(file) {
					const entries = await workspace.sandbox.files.listDirectory(
						workspace.targetPath(file),
						workspace.options
					);

					return entries.map((entry) => entry.name);
				}
			}
		})
	);
	route(createFindToolDefinition(cwd), (workspace) =>
		createFindToolDefinition(workspace.cwd, {
			operations: {
				exists: (file) => workspace.hasFile(file),
				async glob(pattern, directory, { limit }) {
					const result = await workspace.sandbox.search.find(
						{
							pattern,
							path: workspace.targetPath(directory),
							limit
						},
						workspace.options
					);

					return [...result.paths];
				}
			}
		})
	);

	const grep = createGrepToolDefinition(cwd);

	route(grep, (workspace) => ({
		...grep,
		async execute(_id, input) {
			const request = grepRequest(input, workspace);
			const result = await targetGrep(workspace, request, ripgrepAvailability);

			return grepResult(result, request.limit ?? 100);
		}
	}));
}
