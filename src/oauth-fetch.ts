import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** Build the fetch implementation installed into the Anthropic AI SDK. */
export function createOAuthFetch(
  accessToken: string,
  upstream: FetchLike = fetch,
): FetchLike {
  return async (input, init) => {
    const requestHeaders = mergeHeaders(input, init)
    setOAuthHeaders(requestHeaders, accessToken)

    let body = init?.body
    if (body && typeof body === 'string') body = rewriteRequestBody(body)

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
