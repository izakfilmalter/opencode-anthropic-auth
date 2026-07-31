import { createAnthropic } from '@ai-sdk/anthropic'
import { Credential, Integration, Model, Plugin } from '@opencode-ai/plugin'
import { authorize, exchange } from './auth.ts'
import { CLIENT_ID, TOKEN_URL } from './constants.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const INTEGRATION_ID = 'anthropic'
const MAX_METHOD_ID = 'claude-max'
const API_KEY_METHOD_ID = 'create-api-key'
export const AUTH_TYPE_METADATA = 'opencodeAnthropicAuthType'

/**
 * An importable AI SDK shim keeps Anthropic models on OpenCode's generic AI SDK
 * path. V2's dynamic-provider hook runs before external hooks and requires the
 * package to resolve before this plugin can replace its SDK with the OAuth-aware
 * implementation.
 */
export const ANTHROPIC_AUTH_SDK_PACKAGE = new URL(
  './sdk-provider.js',
  import.meta.url,
).href
export const ANTHROPIC_AUTH_PACKAGE = `aisdk:${ANTHROPIC_AUTH_SDK_PACKAGE}`

type OAuthCredential = Credential.OAuth
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function oauthCredential(
  methodID: string,
  value: { refresh: string; access: string; expires: number },
  authType: 'oauth' | 'key',
): OAuthCredential {
  return Credential.OAuth.make({
    type: 'oauth',
    methodID: Integration.MethodID.make(methodID),
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    metadata: { [AUTH_TYPE_METADATA]: authType },
  })
}

function isSubscriptionCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== 'object') return false
  const credential = value as {
    type?: unknown
    metadata?: Record<string, unknown>
  }
  return (
    credential.type === 'oauth' &&
    credential.metadata?.[AUTH_TYPE_METADATA] === 'oauth'
  )
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('fetch failed') ||
      ('code' in error &&
        (error.code === 'ECONNRESET' ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'UND_ERR_CONNECT_TIMEOUT')))
  )
}

async function refreshCredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  if (!credential.refresh) {
    throw new Error('Token refresh failed: credential has no refresh token')
  }

  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credential.refresh,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel()
          continue
        }

        const body = await response.text().catch(() => '')
        throw new Error(`Token refresh failed: ${response.status} — ${body}`)
      }

      const json = (await response.json()) as {
        refresh_token?: string
        access_token?: string
        expires_in?: number
      }
      if (!json.access_token || typeof json.expires_in !== 'number') {
        throw new Error('Token refresh failed: invalid token response')
      }

      return oauthCredential(
        credential.methodID,
        {
          refresh: json.refresh_token ?? credential.refresh,
          access: json.access_token,
          expires: Date.now() + json.expires_in * 1000,
        },
        'oauth',
      )
    } catch (error) {
      if (attempt < maxRetries && isNetworkError(error)) continue
      throw error
    }
  }

  throw new Error('Token refresh exhausted all retries')
}

/** Deduplicates concurrent refreshes for the same rotating refresh token. */
const sharedRefreshes = new Map<string, Promise<OAuthCredential>>()

export function createCredentialRefresher(inflight = sharedRefreshes) {
  return (credential: OAuthCredential): Promise<OAuthCredential> => {
    const existing = inflight.get(credential.refresh)
    if (existing) return existing

    const pending = refreshCredential(credential)
    inflight.set(credential.refresh, pending)
    void pending.then(
      () => {
        // Keep the result briefly after the HTTP request completes. OpenCode
        // persists the returned credential immediately afterward, so this
        // closes the gap where another resolver still holds the rotated token.
        const timer = setTimeout(() => {
          if (inflight.get(credential.refresh) === pending) {
            inflight.delete(credential.refresh)
          }
        }, 30_000)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      },
      () => {
        if (inflight.get(credential.refresh) === pending) {
          inflight.delete(credential.refresh)
        }
      },
    )
    return pending
  }
}

/** Build the fetch implementation installed into the Anthropic AI SDK. */
export function createOAuthFetch(
  accessToken: string,
  upstream: FetchLike = fetch,
): FetchLike {
  return async (input, init) => {
    const requestHeaders = mergeHeaders(input, init)
    setOAuthHeaders(requestHeaders, accessToken)

    let body = init?.body
    if (body && typeof body === 'string') {
      body = rewriteRequestBody(body)
    }

    const rewritten = rewriteUrl(input)
    const requestInit: RequestInit & {
      tls?: { rejectUnauthorized: boolean }
    } = {
      ...init,
      body,
      headers: requestHeaders,
    }
    if (isInsecure()) requestInit.tls = { rejectUnauthorized: false }

    const response = await upstream(rewritten.input, requestInit)
    return createStrippedStream(response)
  }
}

async function exchangeMaxCredential(
  code: string,
  authorization: Awaited<ReturnType<typeof authorize>>,
): Promise<OAuthCredential> {
  const result = await exchange(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )
  if (result.type === 'failed')
    throw new Error('Authorization code exchange failed')
  return oauthCredential(MAX_METHOD_ID, result, 'oauth')
}

async function exchangeAPIKeyCredential(
  code: string,
  authorization: Awaited<ReturnType<typeof authorize>>,
): Promise<OAuthCredential> {
  const result = await exchange(
    code,
    authorization.verifier,
    authorization.redirectUri,
    authorization.state,
  )
  if (result.type === 'failed')
    throw new Error('Authorization code exchange failed')

  const response = await fetch(
    'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${result.access}`,
      },
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`API key creation failed: ${response.status} — ${body}`)
  }

  const value = (await response.json()) as { raw_key?: string }
  if (!value.raw_key)
    throw new Error('API key creation failed: invalid response')

  // V2 OAuth methods currently persist OAuth-shaped credentials only. Store the
  // generated long-lived key in that envelope and mark it as key auth metadata;
  // no refresh implementation is registered for this method.
  return oauthCredential(
    API_KEY_METHOD_ID,
    { refresh: '', access: value.raw_key, expires: Number.MAX_SAFE_INTEGER },
    'key',
  )
}

export const AnthropicAuthPlugin = Plugin.define({
  id: 'ex-machina.anthropic-auth',
  setup: async (ctx) => {
    const refresh = createCredentialRefresher()

    await ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = 'Anthropic'
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: MAX_METHOD_ID,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const authorization = await authorize('max')
          return {
            url: authorization.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code' as const,
            callback: (code: string) =>
              exchangeMaxCredential(code, authorization),
          }
        },
        refresh,
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: API_KEY_METHOD_ID,
          type: 'oauth',
          label: 'Create an API Key',
        },
        authorize: async () => {
          const authorization = await authorize('console')
          return {
            url: authorization.url,
            instructions: 'Paste the authorization code here:',
            mode: 'code' as const,
            callback: (code: string) =>
              exchangeAPIKeyCredential(code, authorization),
          }
        },
      })
    })

    let usingSubscription = false
    const subscriptionActive = async () => {
      try {
        const connection =
          await ctx.integration.connection.active(INTEGRATION_ID)
        const credential = connection
          ? await ctx.integration.connection.resolve(connection)
          : undefined
        return isSubscriptionCredential(credential)
      } catch {
        // An invalid or stale saved connection should not prevent plugin loading.
        return false
      }
    }
    usingSubscription = await subscriptionActive()

    await ctx.catalog.transform((catalog) => {
      catalog.provider.update(INTEGRATION_ID, (provider) => {
        provider.package = ANTHROPIC_AUTH_PACKAGE
      })

      const record = catalog.provider.get(INTEGRATION_ID)
      for (const modelID of record?.models.keys() ?? []) {
        catalog.model.update(INTEGRATION_ID, modelID, (draft) => {
          draft.package = ANTHROPIC_AUTH_PACKAGE
          if (!usingSubscription) return
          draft.cost = draft.cost.map((cost) => ({
            ...cost,
            input: Model.Cost.fields.input.zero,
            output: Model.Cost.fields.output.zero,
            cache: {
              read: Model.Cost.fields.cache.fields.read.zero,
              write: Model.Cost.fields.cache.fields.write.zero,
            },
          }))
        })
      }
    })

    await ctx.aisdk.hook('sdk', async (event) => {
      if (event.package !== ANTHROPIC_AUTH_SDK_PACKAGE) return

      const oauth = event.options[AUTH_TYPE_METADATA] === 'oauth'
      if (usingSubscription !== oauth) {
        usingSubscription = oauth
        await ctx.catalog.reload()
      }

      const { [AUTH_TYPE_METADATA]: _authType, ...options } = event.options
      if (!oauth) {
        event.sdk = createAnthropic(options)
        return
      }

      const accessToken = options.apiKey
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new Error('Anthropic OAuth credential has no access token')
      }
      const upstream =
        typeof options.fetch === 'function'
          ? (options.fetch as FetchLike)
          : undefined
      event.sdk = createAnthropic({
        ...options,
        fetch: createOAuthFetch(accessToken, upstream) as typeof fetch,
      })
    })

    const events = ctx.event.subscribe()[Symbol.asyncIterator]()
    let stopped = false
    const watcher = (async () => {
      while (!stopped) {
        const next = await events.next()
        if (next.done) return
        if (
          next.value.type !== 'integration.connection.updated' ||
          next.value.data.integrationID !== INTEGRATION_ID
        ) {
          continue
        }
        const active = await subscriptionActive()
        if (usingSubscription === active) continue
        usingSubscription = active
        await ctx.catalog.reload()
      }
    })().catch(() => {
      // Losing the event stream should not disable authentication or requests.
    })

    return async () => {
      stopped = true
      await events.return?.()
      await watcher
    }
  },
})

export default AnthropicAuthPlugin
