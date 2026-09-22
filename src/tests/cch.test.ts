import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from '../cch'
import { CLAUDE_CODE_VERSION } from '../constants'

describe('billing header helpers', () => {
  test('extracts text from the first user message', () => {
    expect(
      extractFirstUserMessageText([
        { role: 'assistant', content: 'ignore me' },
        {
          role: 'user',
          content: [
            { type: 'image', text: 'ignored' },
            { type: 'text', text: 'hello world test message' },
          ],
        },
      ]),
    ).toBe('hello world test message')
  })

  test('computes the 5-character cch hash', () => {
    expect(computeCCH('hello world test message')).toBe('4ffc3')
  })

  test('computes the 3-character version suffix', () => {
    expect(computeVersionSuffix('hello world test message', '2.1.87')).toBe(
      '6ff',
    )
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.87',
        'sdk-cli',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.87.6ff; cc_entrypoint=sdk-cli; cch=4ffc3;',
    )
  })

  test('uses a Claude Code version that supports Opus 5.5 by default', () => {
    expect(CLAUDE_CODE_VERSION).toBe('2.1.280')
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        undefined,
        'sdk-cli',
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.280.f0d; cc_entrypoint=sdk-cli; cch=4ffc3;',
    )
  })
})
