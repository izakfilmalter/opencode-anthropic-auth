import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Integration } from '@opencode-ai/plugin'
import AnthropicAuthPlugin, {
  ANTHROPIC_AUTH_PACKAGE,
  createCredentialRefresher,
  createOAuthFetch,
} from '../index'
import { createAnthropicAuth } from '../sdk-provider'

type Callback = (input: any) => Promise<void> | void
type Authorization = {
  url: string
  callback: (code: string) => Promise<any>
}

function createMockContext(credential?: unknown) {
  const captured: {
    integration?: Callback
    catalog?: Callback
    sdk?: Callback
  } = {}
  const registration = { dispose: mock(() => Promise.resolve()) }
  const reload = mock(() => Promise.resolve())

  return {
    captured,
    reload,
    context: {
      integration: {
        transform: mock(async (callback: Callback) => {
          captured.integration = callback
          return registration
        }),
        connection: {
          active: mock(() =>
            Promise.resolve(
              credential
                ? { type: 'credential', id: 'credential-1' }
                : undefined,
            ),
          ),
          resolve: mock(() => Promise.resolve(credential)),
        },
      },
      catalog: {
        transform: mock(async (callback: Callback) => {
          captured.catalog = callback
          return registration
        }),
        reload,
      },
      aisdk: {
        hook: mock(async (_name: string, callback: Callback) => {
          captured.sdk = callback
          return registration
        }),
      },
      event: {
        subscribe: () =>
          (async function* () {
            yield* []
          })(),
      },
    },
  }
}

function applyIntegrationTransform(callback: Callback) {
  const integration = { id: 'anthropic', name: 'anthropic' }
  const methods: any[] = []
  callback({
    list: () => [integration],
    get: () => integration,
    update: (_id: string, update: (value: typeof integration) => void) =>
      update(integration),
    remove: () => {},
    method: {
      list: () => methods.map((entry) => entry.method),
      update: (entry: any) => methods.push(entry),
      remove: () => {},
    },
  })
  return { integration, methods }
}

function applyCatalogTransform(callback: Callback) {
  const provider = {
    id: 'anthropic',
    name: 'Anthropic',
    package: 'aisdk:@ai-sdk/anthropic',
  }
  const model = {
    id: 'claude-sonnet',
    package: undefined as string | undefined,
    cost: [
      {
        tier: { type: 'context', size: 200_000 },
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    ],
  }
  const models = new Map([[model.id, model]])
  callback({
    provider: {
      list: () => [{ provider, models }],
      get: () => ({ provider, models }),
      update: (_id: string, update: (value: typeof provider) => void) =>
        update(provider),
      remove: () => {},
    },
    model: {
      get: () => model,
      update: (_providerID: string, _modelID: string, update: Callback) =>
        update(model),
      remove: () => {},
      default: { get: () => undefined, set: () => {} },
    },
  })
  return { provider, model }
}

async function setup(credential?: unknown) {
  const mockContext = createMockContext(credential)
  await AnthropicAuthPlugin.setup(mockContext.context as never)
  return mockContext
}

describe('V2 plugin definition', () => {
  test('exports a V2 plugin with a stable ID and setup function', () => {
    expect(AnthropicAuthPlugin.id).toBe('ex-machina.anthropic-auth')
    expect(AnthropicAuthPlugin.setup).toBeFunction()
  })

  test('registers both OAuth methods on the Anthropic integration', async () => {
    const { captured } = await setup()
    const { integration, methods } = applyIntegrationTransform(
      captured.integration!,
    )

    expect(integration.name).toBe('Anthropic')
    expect(methods.map((entry) => entry.method)).toEqual([
      { id: 'claude-max', type: 'oauth', label: 'Claude Pro/Max' },
      { id: 'create-api-key', type: 'oauth', label: 'Create an API Key' },
    ])
    expect(methods[0].authorize).toBeFunction()
    expect(methods[0].refresh).toBeFunction()
    expect(methods[1].authorize).toBeFunction()
    expect(methods[1].refresh).toBeUndefined()
  })

  test('routes Anthropic models through the synthetic AI SDK package', async () => {
    const { captured } = await setup()
    const { provider, model } = applyCatalogTransform(captured.catalog!)

    expect(provider.package).toBe(ANTHROPIC_AUTH_PACKAGE)
    expect(model.package).toBe(ANTHROPIC_AUTH_PACKAGE)
    expect(model.cost[0]!.input).toBe(3)
  })

  test('uses an importable local shim for the synthetic AI SDK package', () => {
    expect(ANTHROPIC_AUTH_PACKAGE).toStartWith('aisdk:file:')
    expect(ANTHROPIC_AUTH_PACKAGE).toEndWith('/sdk-provider.js')
    expect(createAnthropicAuth).toBeFunction()
  })

  test('preserves cost tiers while zeroing subscription costs', async () => {
    const credential = {
      type: 'oauth',
      methodID: 'claude-max',
      refresh: 'refresh',
      access: 'access',
      expires: Date.now() + 60_000,
      metadata: { opencodeAnthropicAuthType: 'oauth' },
    }
    const { captured } = await setup(credential)
    const { model } = applyCatalogTransform(captured.catalog!)

    expect(model.cost).toEqual([
      {
        tier: { type: 'context', size: 200_000 },
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
    ])
  })

  test('constructs an Anthropic SDK for key credentials', async () => {
    const { captured, reload } = await setup()
    const event = {
      package: ANTHROPIC_AUTH_PACKAGE.slice('aisdk:'.length),
      model: { providerID: 'anthropic' },
      options: { apiKey: 'sk-test' },
      sdk: undefined,
    }
    await captured.sdk!(event)

    expect(event.sdk).toBeDefined()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('OAuth authorization adapters', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('returns a V2 OAuth credential for Claude Pro/Max', async () => {
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input.toString()
      if (!url.includes('/v1/oauth/token')) {
        throw new Error(`Unexpected URL: ${url}`)
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'refresh',
            access_token: 'access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const { captured } = await setup()
    const { methods } = applyIntegrationTransform(captured.integration!)
    const authorization = (await methods[0].authorize({})) as Authorization
    const url = new URL(authorization.url)
    const state = url.searchParams.get('state')!
    const credential = await authorization.callback(`code#${state}`)

    expect(credential).toMatchObject({
      type: 'oauth',
      methodID: 'claude-max',
      refresh: 'refresh',
      access: 'access',
      metadata: { opencodeAnthropicAuthType: 'oauth' },
    })
  })

  test('stores a generated API key in a non-refreshing V2 credential', async () => {
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/v1/oauth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refresh_token: 'refresh',
              access_token: 'access',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/create_api_key')) {
        return Promise.resolve(
          new Response(JSON.stringify({ raw_key: 'sk-generated' }), {
            status: 200,
          }),
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const { captured } = await setup()
    const { methods } = applyIntegrationTransform(captured.integration!)
    const authorization = (await methods[1].authorize({})) as Authorization
    const state = new URL(authorization.url).searchParams.get('state')!
    const credential = await authorization.callback(`code#${state}`)

    expect(credential).toMatchObject({
      type: 'oauth',
      methodID: 'create-api-key',
      refresh: '',
      access: 'sk-generated',
      expires: Number.MAX_SAFE_INTEGER,
      metadata: { opencodeAnthropicAuthType: 'key' },
    })
  })
})

describe('credential refresh', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const tokenResponse = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    )

  const expired = {
    type: 'oauth' as const,
    methodID: Integration.MethodID.make('claude-max'),
    refresh: 'old-refresh',
    access: 'expired',
    expires: Date.now() - 1,
    metadata: { opencodeAnthropicAuthType: 'oauth' },
  }

  test('deduplicates concurrent refreshes and preserves the method ID', async () => {
    let refreshCalls = 0
    globalThis.fetch = mock(() => {
      refreshCalls++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'new-refresh',
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const refresh = createCredentialRefresher()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refresh(expired)),
    )

    expect(refreshCalls).toBe(1)
    expect(results.every((value) => value.methodID === 'claude-max')).toBe(true)
    expect(results[0]).toMatchObject({
      refresh: 'new-refresh',
      access: 'new-access',
      metadata: { opencodeAnthropicAuthType: 'oauth' },
    })
  })

  test('retries transient server failures', async () => {
    let refreshCalls = 0
    const upstream = mock(() => {
      refreshCalls++
      if (refreshCalls === 1) {
        return Promise.resolve(new Response('temporary', { status: 500 }))
      }
      return tokenResponse()
    })

    await createCredentialRefresher(new Map(), {
      fetch: upstream,
      retryBaseDelayMs: 1,
    })({
      ...expired,
      refresh: 'retry-refresh',
    })
    expect(refreshCalls).toBe(2)
  })

  test('a stalled refresh rejects within the attempt deadline', async () => {
    let refreshCalls = 0
    const stalled = mock(() => {
      refreshCalls++
      return new Promise<Response>(() => {})
    })
    const inflight = new Map<string, Promise<any>>()
    const refresh = createCredentialRefresher(inflight, {
      fetch: stalled,
      attemptTimeoutMs: 20,
      retryBaseDelayMs: 1,
    })

    const started = Date.now()
    await expect(
      refresh({ ...expired, refresh: 'stalled-refresh' }),
    ).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(refreshCalls).toBe(3)
    expect(inflight.size).toBe(0)
  })

  test('a timed-out refresh is evicted so the next caller starts fresh', async () => {
    let refreshCalls = 0
    const upstream = mock(() => {
      refreshCalls++
      if (refreshCalls <= 3) return new Promise<Response>(() => {})
      return tokenResponse()
    })
    const inflight = new Map<string, Promise<any>>()
    const refresh = createCredentialRefresher(inflight, {
      fetch: upstream,
      attemptTimeoutMs: 20,
      retryBaseDelayMs: 1,
    })
    const credential = { ...expired, refresh: 'evicted-refresh' }

    await expect(refresh(credential)).rejects.toThrow(/timed out/)
    expect(inflight.size).toBe(0)

    const result = await refresh(credential)
    expect(refreshCalls).toBe(4)
    expect(result).toMatchObject({ access: 'new-access' })
  })

  test('retries a timed-out attempt like a network error', async () => {
    let refreshCalls = 0
    const upstream = mock(() => {
      refreshCalls++
      if (refreshCalls === 1) return new Promise<Response>(() => {})
      return tokenResponse()
    })
    const refresh = createCredentialRefresher(new Map(), {
      fetch: upstream,
      attemptTimeoutMs: 20,
      retryBaseDelayMs: 1,
    })

    const result = await refresh({ ...expired, refresh: 'timeout-retry' })
    expect(refreshCalls).toBe(2)
    expect(result).toMatchObject({ access: 'new-access' })
  })

  test('does not retry non-retryable HTTP failures', async () => {
    let refreshCalls = 0
    const upstream = mock(() => {
      refreshCalls++
      return Promise.resolve(new Response('bad token', { status: 401 }))
    })
    const refresh = createCredentialRefresher(new Map(), {
      fetch: upstream,
      retryBaseDelayMs: 1,
    })

    await expect(
      refresh({ ...expired, refresh: 'denied-refresh' }),
    ).rejects.toThrow(/401/)
    expect(refreshCalls).toBe(1)
  })
})

describe('OAuth fetch adapter', () => {
  test('rewrites OAuth headers, body, URL, and streamed tool names', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const upstream = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = input.toString()
        capturedInit = init
        return Promise.resolve(
          new Response(
            'data: {"content_block":{"type":"tool_use","name":"mcp_Bash"}}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        )
      },
    )
    const oauthFetch = createOAuthFetch('oauth-access', upstream)
    const body = JSON.stringify({
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are helpful.',
    })

    const response = await oauthFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'removed' },
      body,
    })

    expect(capturedUrl).toContain('beta=true')
    const headers = capturedInit!.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer oauth-access')
    expect(headers.get('x-api-key')).toBeNull()
    const rewrittenBody = JSON.parse(capturedInit!.body as string)
    expect(rewrittenBody.tools[0].name).toBe('mcp_Bash')
    expect(await response.text()).toContain('"name": "bash"')
  })
})
