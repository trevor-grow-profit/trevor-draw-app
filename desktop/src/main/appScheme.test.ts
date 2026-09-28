import { describe, expect, it } from 'vitest'
import { APP_SCHEME } from './appScheme'

describe('APP_SCHEME', () => {
  it('is the standard, secure, fetchable `app` scheme with the V8 code cache on (YAZ-2073 D13)', () => {
    expect(APP_SCHEME).toEqual({ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } })
  })
})
