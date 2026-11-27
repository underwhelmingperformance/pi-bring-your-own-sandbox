import { messageScenario } from './fixtures/message-provider.js';
import { firstOpenProfile } from './fixtures/profile-fixture.js';
import { defineSandboxProviderTests } from './testing.js';

const scenario = messageScenario();

defineSandboxProviderTests({
	...scenario,
	workspaceVisibility: 'shared',
	capabilities: firstOpenProfile(scenario.provider)
});
