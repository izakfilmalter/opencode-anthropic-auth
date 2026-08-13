import { createAnthropic } from '@ai-sdk/anthropic'
import { AUTH_TYPE_METADATA } from './constants.ts'
import { createOAuthFetch } from './oauth-fetch.ts'

/**
 * Loaded by OpenCode's dynamic-provider hook before the auth plugin's later SDK
 * hook runs. Manual compaction can resolve a model while plugins are reloading,
 * so this factory must be safe even when that later hook is not yet installed.
 */
export const createAnthropicAuth = (options: Record<string, unknown>) => {
  const { [AUTH_TYPE_METADATA]: authType, ...providerOptions } = options
  if (authType !== 'oauth') return createAnthropic(providerOptions)

  const accessToken = providerOptions.apiKey
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Anthropic OAuth credential has no access token')
  }
  const upstream =
    typeof providerOptions.fetch === 'function'
      ? (providerOptions.fetch as typeof fetch)
      : undefined
  return createAnthropic({
    ...providerOptions,
    fetch: createOAuthFetch(accessToken, upstream) as typeof fetch,
  })
}
