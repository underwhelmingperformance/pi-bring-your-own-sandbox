import { messageScenario } from './fixtures/message-provider.js';
import { defineSandboxProviderTests } from './testing.js';

defineSandboxProviderTests(messageScenario());
