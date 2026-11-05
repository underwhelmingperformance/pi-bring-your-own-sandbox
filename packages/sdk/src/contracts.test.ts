import { expectTypeOf, it } from 'vitest';

import type {
	BackendProcessOutcome,
	FileStat,
	ProcessRequest,
	Sandbox,
	SandboxClient,
	SandboxErrorInfo,
	SandboxProvider
} from './api.js';
import { connectionProvider } from './fixtures/connection-provider.js';
import { inspectWorkspace } from './fixtures/consumer.js';
import { imageProvider } from './fixtures/image-provider.js';

interface ImageConfig {
	readonly image: string;
}

interface ConnectionConfig {
	readonly endpoint: URL;
}

it('keeps provider-specific configuration typed through opening', () => {
	expectTypeOf<
		SandboxProvider<ImageConfig>['validateConfig']
	>().returns.toEqualTypeOf<ImageConfig>();
	expectTypeOf<
		SandboxProvider<ConnectionConfig>['validateConfig']
	>().returns.toEqualTypeOf<ConnectionConfig>();
	expectTypeOf<SandboxProvider<ImageConfig>['open']>().parameter(0).toExtend<{
		readonly configuration: ImageConfig;
	}>();
	expectTypeOf<SandboxProvider<ImageConfig>>().not.toExtend<
		SandboxProvider<ConnectionConfig>
	>();
});

it('requires stat to report the resolved target kind', () => {
	expectTypeOf<{ kind: 'directory'; size: number }>().toExtend<FileStat>();
	expectTypeOf<{ kind: 'symlink'; size: number }>().not.toExtend<FileStat>();
});

it('keeps consumer acquisition independent of provider configuration', () => {
	expectTypeOf<SandboxClient['getSandbox']>().returns.toEqualTypeOf<
		Promise<Sandbox>
	>();
	expectTypeOf<Sandbox['exec']>().parameter(0).toEqualTypeOf<ProcessRequest>();
});

it('typechecks independently implemented providers and a consumer', () => {
	expectTypeOf(
		imageProvider.validateConfig
	).returns.toEqualTypeOf<ImageConfig>();
	expectTypeOf(
		connectionProvider.validateConfig
	).returns.toEqualTypeOf<ConnectionConfig>();
	expectTypeOf<typeof inspectWorkspace>()
		.parameter(0)
		.toEqualTypeOf<SandboxClient>();
});

it('rejects shell requests without a dialect and ambiguous termination outcomes', () => {
	expectTypeOf<{
		kind: 'shell';
		command: string;
	}>().not.toExtend<ProcessRequest>();
	expectTypeOf<{
		kind: 'argv';
		executable: string;
		args: readonly string[];
	}>().toExtend<ProcessRequest>();
	expectTypeOf<{
		kind: 'cancelled';
	}>().not.toExtend<BackendProcessOutcome>();
	expectTypeOf<{
		kind: 'cancelled';
		termination: 'confirmed';
	}>().toExtend<BackendProcessOutcome>();
	expectTypeOf<{
		kind: 'shell';
		command: string;
		dialect: 'zsh';
	}>().not.toExtend<ProcessRequest>();
	expectTypeOf<{
		kind: 'shell';
		command: string;
		dialect: 'sh';
		executable: string;
		args: readonly string[];
	}>().not.toExtend<ProcessRequest>();
	expectTypeOf<{
		sandboxErrorVersion: 1;
		message: string;
		name: 'SandboxTimeoutError';
		operation: 'exec';
		reason: 'caller';
		completion: 'confirmed';
	}>().not.toExtend<SandboxErrorInfo>();
	expectTypeOf<{
		sandboxErrorVersion: 1;
		message: string;
		name: 'UnconfirmedSandboxTerminationError';
		operation: 'exec';
		completion: 'confirmed';
	}>().not.toExtend<SandboxErrorInfo>();
});
