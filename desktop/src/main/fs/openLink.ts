import { shell } from 'electron'
import { BridgeFailure } from './fsUtils'
import { requireObject } from './validate'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:'])

/** The one protocol allowlist shared by direct clicks and `_blank` popup interception. */
export const isExternalLinkProtocol = (protocol: string): boolean => EXTERNAL_PROTOCOLS.has(protocol)

export interface OpenLinkHost {
  openExternal(url: string): Promise<void>
}

/**
 * The renderer never receives Electron's shell, so a link the canvas opens leaves the app through
 * here — `windowOpenPolicy.ts` is the only caller. This function IS the OS boundary, so it
 * re-validates the protocol its caller already checked and trusts nothing in the request.
 */
export async function openLink(req: unknown, host: OpenLinkHost = shell): Promise<void> {
  const { href } = requireObject(req, 'invalid open-link request')
  if (typeof href !== 'string' || href.trim() === '') throw new BridgeFailure('BAD_REQUEST', "missing 'href'")

  let target: URL
  try {
    target = new URL(href.trim())
  } catch {
    throw new BridgeFailure('BAD_REQUEST', 'link is not an absolute URL')
  }
  if (!isExternalLinkProtocol(target.protocol)) throw new BridgeFailure('BAD_REQUEST', 'unsupported link protocol')

  try {
    // Hand the OS the same canonical URL whose protocol was validated above.
    await host.openExternal(target.href)
  } catch (err) {
    throw new BridgeFailure('IO_ERROR', err instanceof Error ? err.message : String(err))
  }
}
