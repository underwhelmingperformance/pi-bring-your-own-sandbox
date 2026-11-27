import { messageScenario } from './fixtures/message-provider.js';
import { firstOpenProfile } from './fixtures/profile-fixture.js';
import { defineFixtureOperationTests } from './fixtures/provider-operation-tests.js';

const scenario = messageScenario();

defineFixtureOperationTests({
	...scenario,
	workspaceVisibility: 'shared',
	capabilities: firstOpenProfile(scenario.provider)
});
