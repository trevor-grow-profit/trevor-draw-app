import { isExternalLinkProtocol } from './fs/openLink'

/** An external-link intent from the canvas; the opener re-validates the protocol before any OS side effect. */
export type LinkOpener = (req: { href: string }) => Promise<void>

/** Defense in depth: safe `_blank` URLs leave through the OS; no popup becomes a child window. */
export function createWindowOpenHandler(open: LinkOpener) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    try {
      if (isExternalLinkProtocol(new URL(url).protocol)) void open({ href: url }).catch(() => undefined)
    } catch {
      // Malformed and relative popup URLs are denied without an OS side effect.
    }
    return { action: 'deny' }
  }
}
