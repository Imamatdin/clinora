import { providersFromEnv, type AssistantProviders } from './providers.js';

/**
 * The assistant's provider set for this process. Built from the environment on first use; tests and
 * scripts may install a set explicitly. Shared by the registry routes and the transport handler.
 */
let current: AssistantProviders | null = null;
export const assistantProviders = (): AssistantProviders => (current ??= providersFromEnv());
export const setAssistantProviders = (providers: AssistantProviders | null) => { current = providers; };
