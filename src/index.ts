import { createAnthropic } from '@ai-sdk/anthropic'
import {
  Credential,
  Integration,
  Model,
  Plugin,
} from '@opencode-ai/plugin/effect'
import { Data, Duration, Effect, Schedule, Semaphore, Stream } from 'effect'
import { authorize, exchange } from './auth.ts'
import {
  AUTH_TYPE_METADATA,
  CLIENT_ID,
  OUTPUT_STYLE_METADATA,
  TOKEN_URL,
} from './constants.ts'
import { createOAuthFetch, type FetchLike } from './oauth-fetch.ts'

export { AUTH_TYPE_METADATA } from './constants.ts'
export {
  createOAuthFetch,
  type OAuthFetchOptions,
} from './oauth-fetch.ts'
export type { ClaudeOutputStyle } from './transform.ts'

const INTEGRATION_ID = 'anthropic'
const MAX_METHOD_ID = 'claude-max'
const API_KEY_METHOD_ID = 'create-api-key'

function resolveOutputStyle(value: unknown): 'Default' | 'Concise' {
  if (value === undefined || value === 'Concise') return 'Concise'
  if (value === 'Default') return 'Default'
  throw new Error('Invalid outputStyle option: expected "Concise" or "Default"')
}

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
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      ('code' in error &&
        (error.code === 'ECONNRESET' ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'UND_ERR_CONNECT_TIMEOUT')))
  )
}

const REFRESH_ATTEMPT_TIMEOUT_MS = 15_000
const REFRESH_MAX_RETRIES = 2
const REFRESH_RETRY_BASE_DELAY_MS = 500
const SUBSCRIPTION_CHECK_TIMEOUT_MS = 10_000

class RefreshRequestError extends Data.TaggedError('RefreshRequestError')<{
  message: string
  cause: unknown
}> {}

class RefreshHttpError extends Data.TaggedError('RefreshHttpError')<{
  message: string
  status: number
}> {}

class RefreshTimeoutError extends Data.TaggedError('RefreshTimeoutError')<{
  message: string
}> {}

class RefreshInvalidResponseError extends Data.TaggedError(
  'RefreshInvalidResponseError',
)<{ message: string }> {}

type RefreshError =
  | RefreshRequestError
  | RefreshHttpError
  | RefreshTimeoutError
  | RefreshInvalidResponseError

function isRetryableRefreshError(error: RefreshError): boolean {
  switch (error._tag) {
    case 'RefreshTimeoutError':
      return true
    case 'RefreshHttpError':
      // Effect's HttpClient transient set, matching OpenCode's own HTTP retries.
      return error.status === 408 || error.status === 429 || error.status >= 500
    case 'RefreshRequestError':
      return isNetworkError(error.cause)
    case 'RefreshInvalidResponseError':
      return false
  }
}

type RefreshOptions = {
  fetch?: FetchLike
  attemptTimeoutMs?: number
  retryBaseDelayMs?: number
}

const refreshRequest = Effect.fn('refreshRequest')(function* (
  credential: OAuthCredential,
  upstream: FetchLike,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      upstream(TOKEN_URL, {
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
        signal,
      }),
    catch: (cause) =>
      new RefreshRequestError({
        cause,
        message:
          cause instanceof Error
            ? `Token refresh request failed: ${cause.message}`
            : 'Token refresh request failed',
      }),
  })

  if (!response.ok) {
    const body = yield* Effect.promise(() => response.text().catch(() => ''))
    return yield* Effect.fail(
      new RefreshHttpError({
        status: response.status,
        message: `Token refresh failed: ${response.status} — ${body}`,
      }),
    )
  }

  const json = yield* Effect.tryPromise({
    try: () =>
      response.json() as Promise<{
        refresh_token?: string
        access_token?: string
        expires_in?: number
      }>,
    catch: () =>
      new RefreshInvalidResponseError({
        message: 'Token refresh failed: invalid token response',
      }),
  })
  if (!json.access_token || typeof json.expires_in !== 'number') {
    return yield* Effect.fail(
      new RefreshInvalidResponseError({
        message: 'Token refresh failed: invalid token response',
      }),
    )
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
})

/**
 * Refreshes an OAuth credential with a hard per-attempt deadline. Every attempt
 * aborts its fetch and fails with `RefreshTimeoutError` once the deadline
 * passes, so the returned promise always settles — a stalled connection can
 * never wedge a caller (or the daemon boot path that awaits it).
 */
async function refreshCredential(
  credential: OAuthCredential,
  options: RefreshOptions = {},
): Promise<OAuthCredential> {
  if (!credential.refresh) {
    throw new Error('Token refresh failed: credential has no refresh token')
  }

  const upstream = options.fetch ?? fetch
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? REFRESH_ATTEMPT_TIMEOUT_MS
  const retryBaseDelayMs =
    options.retryBaseDelayMs ?? REFRESH_RETRY_BASE_DELAY_MS

  return Effect.runPromise(
    refreshRequest(credential, upstream).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(attemptTimeoutMs),
        orElse: () =>
          Effect.fail(
            new RefreshTimeoutError({
              message: `Token refresh timed out after ${attemptTimeoutMs}ms`,
            }),
          ),
      }),
      Effect.retry({
        times: REFRESH_MAX_RETRIES,
        schedule: Schedule.exponential(Duration.millis(retryBaseDelayMs)).pipe(
          Schedule.jittered,
        ),
        while: isRetryableRefreshError,
      }),
    ),
  )
}

/** Deduplicates concurrent refreshes for the same rotating refresh token. */
const sharedRefreshes = new Map<string, Promise<OAuthCredential>>()

export function createCredentialRefresher(
  inflight = sharedRefreshes,
  options: RefreshOptions = {},
) {
  return (credential: OAuthCredential): Promise<OAuthCredential> => {
    const existing = inflight.get(credential.refresh)
    if (existing) return existing

    // refreshCredential always settles within its bounded attempt deadlines,
    // so a cached in-flight promise can never poison later callers.
    const pending = refreshCredential(credential, options)
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
  effect: Effect.fn(function* (ctx) {
    const outputStyle = resolveOutputStyle(ctx.options.outputStyle)
    const refresh = createCredentialRefresher()
    const loading = Semaphore.makeUnsafe(1)

    yield* ctx.integration.transform((draft) => {
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
        authorize: () =>
          Effect.promise(() => authorize('max')).pipe(
            Effect.map((authorization) => ({
              url: authorization.url,
              instructions: 'Paste the authorization code here:',
              mode: 'code' as const,
              callback: (code: string) =>
                Effect.promise(() =>
                  exchangeMaxCredential(code, authorization),
                ),
            })),
          ),
        refresh: (credential) => Effect.promise(() => refresh(credential)),
      })

      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: API_KEY_METHOD_ID,
          type: 'oauth',
          label: 'Create an API Key',
        },
        authorize: () =>
          Effect.promise(() => authorize('console')).pipe(
            Effect.map((authorization) => ({
              url: authorization.url,
              instructions: 'Paste the authorization code here:',
              mode: 'code' as const,
              callback: (code: string) =>
                Effect.promise(() =>
                  exchangeAPIKeyCredential(code, authorization),
                ),
            })),
          ),
      })
    })

    let usingSubscription = false
    const subscriptionActive = Effect.fn('AnthropicAuth.subscriptionActive')(
      function* () {
        const connection =
          yield* ctx.integration.connection.active(INTEGRATION_ID)
        const credential = connection
          ? yield* ctx.integration.connection
              .resolve(connection)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
        return isSubscriptionCredential(credential)
      },
    )
    // Bound plugin setup: a hung connection resolve must not wedge daemon
    // boot. On timeout fall back to key-auth pricing; the connection watcher
    // below corrects `usingSubscription` once resolution succeeds.
    usingSubscription = yield* subscriptionActive().pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(SUBSCRIPTION_CHECK_TIMEOUT_MS),
        orElse: () => Effect.succeed(false),
      }),
    )

    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update(INTEGRATION_ID, (provider) => {
        provider.package = ANTHROPIC_AUTH_PACKAGE
        provider.settings = {
          ...provider.settings,
          [OUTPUT_STYLE_METADATA]: outputStyle,
        }
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

    yield* ctx.aisdk.hook('sdk', (event) =>
      Effect.gen(function* () {
        if (event.package !== ANTHROPIC_AUTH_SDK_PACKAGE) return

        const oauth = event.options[AUTH_TYPE_METADATA] === 'oauth'
        if (usingSubscription !== oauth) {
          usingSubscription = oauth
          yield* ctx.catalog.reload()
        }

        const {
          [AUTH_TYPE_METADATA]: _authType,
          [OUTPUT_STYLE_METADATA]: _outputStyle,
          ...options
        } = event.options
        if (!oauth) {
          event.sdk = createAnthropic(options)
          return
        }

        const accessToken = options.apiKey
        if (typeof accessToken !== 'string' || !accessToken) {
          return yield* Effect.die(
            new Error('Anthropic OAuth credential has no access token'),
          )
        }
        const upstream =
          typeof options.fetch === 'function'
            ? (options.fetch as FetchLike)
            : undefined
        event.sdk = createAnthropic({
          ...options,
          fetch: createOAuthFetch(accessToken, upstream, {
            outputStyle,
          }) as typeof fetch,
        })
      }),
    )

    const refreshSubscription = () =>
      loading.withPermit(
        Effect.gen(function* () {
          const active = yield* subscriptionActive()
          if (usingSubscription === active) return
          usingSubscription = active
          yield* ctx.catalog.reload()
        }),
      )

    // Match the native OpenAI/Codex provider: the watcher is a child of the
    // plugin scope, so every reload interrupts its pending stream read before
    // the next generation starts. No async iterator or cleanup promise escapes.
    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event) =>
          event.type === 'integration.connection.updated' &&
          event.data.integrationID === INTEGRATION_ID,
      ),
      Stream.runForEach(refreshSubscription),
      Effect.catch(() => Effect.void),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

export default AnthropicAuthPlugin
