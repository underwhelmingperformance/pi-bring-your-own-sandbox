import { expectTypeOf, it } from 'vitest';

import type {
	AvailableSandboxProvider,
	BackendProcessOutcome,
	FileStat,
	ProcessRequest,
	Sandbox,
	SandboxClient,
	SandboxErrorInfo,
	SandboxHost,
	SandboxProvider,
	SharedSettingsSchema
} from './contracts.js';
import { connectionProvider } from './fixtures/connection-provider.js';
import { inspectWorkspace } from './fixtures/consumer.js';
import { imageProvider } from './fixtures/image-provider.js';
import { registerSandboxProvider } from './provider-registration.js';

interface ImageConfig {
	readonly image: string;
}

interface ConnectionConfig {
	readonly endpoint: URL;
}

type Implementation<Config> = ReturnType<
	AvailableSandboxProvider<Config>['create']
>;

it('keeps provider-specific configuration typed through opening', () => {
	expectTypeOf<Implementation<ImageConfig>['open']>().parameter(0).toExtend<{
		readonly configuration: ImageConfig;
	}>();
	expectTypeOf<AvailableSandboxProvider<ImageConfig>>().not.toExtend<
		AvailableSandboxProvider<ConnectionConfig>
	>();
});

it('requires stat to report the resolved target kind', () => {
	expectTypeOf<{ kind: 'directory'; size: number }>().toExtend<FileStat>();
	expectTypeOf<{ kind: 'symlink'; size: number }>().not.toExtend<FileStat>();
});

it('keeps consumer acquisition independent of provider configuration', () => {
	expectTypeOf<SandboxClient['get']>().returns.toEqualTypeOf<
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
		.toEqualTypeOf<Pick<SandboxClient, 'get'>>();
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
		message: string;
		name: 'SandboxTimeoutError';
		operation: 'exec';
		reason: 'caller';
		completion: 'confirmed';
	}>().not.toExtend<SandboxErrorInfo>();
	expectTypeOf<{
		message: string;
		name: 'UnconfirmedSandboxTerminationError';
		operation: 'exec';
		completion: 'confirmed';
	}>().not.toExtend<SandboxErrorInfo>();
});

it('accepts one declaration and passes the shared settings schema to configure', () => {
	expectTypeOf<typeof registerSandboxProvider<ImageConfig>>()
		.parameter(2)
		.toEqualTypeOf<SandboxProvider<ImageConfig>>();
	expectTypeOf<Implementation<ImageConfig>['configure']>()
		.parameter(1)
		.toEqualTypeOf<SharedSettingsSchema>();
	expectTypeOf<{
		configure: () => { configuration: { image: number } };
	}>().not.toExtend<Pick<Implementation<ImageConfig>, 'configure'>>();
});

function invalidRegistration(pi: SandboxHost): void {
	registerSandboxProvider<ImageConfig>(pi, import.meta.filename, {
		id: imageProvider.id,
		label: imageProvider.label,
		profiles: imageProvider.profiles,
		create: () => ({
			// @ts-expect-error The provider requires a string image identifier.
			configure: () => ({ configuration: { image: 123 } }),
			open: imageProvider.open
		})
	});
}

it('rejects a declaration with incompatible typed configuration', () => {
	expectTypeOf(invalidRegistration).toBeFunction();
});
