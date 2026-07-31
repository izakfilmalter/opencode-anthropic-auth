import { createAnthropic } from '@ai-sdk/anthropic'

/**
 * Loaded by OpenCode's dynamic-provider hook before the auth plugin's later SDK
 * hook replaces it with the OAuth-aware instance.
 */
export const createAnthropicAuth = (options: Record<string, unknown>) =>
  createAnthropic(options)
