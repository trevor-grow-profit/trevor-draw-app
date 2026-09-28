import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { build } from 'esbuild'
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { DRAWIO_SHARE_DIRS, DRAWIO_SHARE_FILES } from '../desktop/src/main/drawio/assets.ts'
import { viewerPage } from '../share/viewer/page.js'
import { DRAWIO_TAG } from './packDrawio.mjs'
import { diagramFontCss } from './buildShareViewer.mjs'

/**
 * A SHARED DIAGRAM'S PAGE, DRAWN OFFLINE (🔒 YAZ-1802 D11): the Worker's real page with its scripts
 * run in page order in jsdom — our config, the pinned draw.io viewer, our `diagram.js`, and any
 * script it adds — against a stand-in origin that answers `/scene/<id>` and every `/assets/…`
 * path from exactly the files share setup publishes there: our config, and `DRAWIO_SHARE_FILES` /
 * `DRAWIO_SHARE_DIRS` from the pruned pack (🔒 YAZ-1802 D5). Nothing leaves the process. jsdom has no layout, so this
 * pins what is drawn and fetched, not how it looks; that is a look at a live link.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url))
const PACK = path.join(REPO, 'desktop', '.cache', 'drawio', DRAWIO_TAG)
const ORIGIN = 'https://share.test'
const ID = 'AbCdEfGhIjKlMnOpQrStUvWx'
const VIEWER = path.join(PACK, 'js', 'viewer-static.min.js')
const page = (cells) => `<mxfile host="yaz-1802"><diagram id="p1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
${cells}
</root></mxGraphModel></diagram></mxfile>`
const LABEL = '<mxCell id="2" value="Checkout service" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="140" height="60" as="geometry"/></mxCell>'
/** A label, and an AWS library icon whose shape lives in a stencil set (`aws4.xml`). */
const XML = page(`${LABEL}
<mxCell id="3" value="" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;" vertex="1" parent="1"><mxGeometry x="200" y="10" width="60" height="60" as="geometry"/></mxCell>`)

/** The bytes share setup publishes at `/assets/<rel>`; null when it publishes nothing there. */
function published(rel) {
  const drawio = rel.startsWith('drawio/') ? rel.slice('drawio/'.length) : null
  const fromPack = DRAWIO_SHARE_FILES.includes(drawio) || DRAWIO_SHARE_DIRS.some((dir) => drawio?.startsWith(`${dir}/`))
  const file = drawio === 'config.js' ? path.join(REPO, 'share', 'viewer', 'drawioConfig.js') : fromPack ? path.join(PACK, drawio) : null
  return file !== null && existsSync(file) ? readFileSync(file) : null
}

/** draw.io loads stencils with SYNCHRONOUS XMLHttpRequests (`mxUtils.load`); this one answers from `published`. */
const fakeXhr = (requested) =>
  class {
    open(method, url) {
      this.url = new URL(url, ORIGIN)
    }
    setRequestHeader() {}
    send() {
      requested.push(this.url.href)
      const bytes = this.url.origin === ORIGIN && this.url.pathname.startsWith('/assets/') ? published(this.url.pathname.slice('/assets/'.length)) : null
      this.readyState = 4
      this.status = bytes === null ? 404 : 200
      this.responseText = bytes === null ? '' : bytes.toString('utf8')
      this.responseXML = null
    }
  }

async function openSharedDiagram(xml) {
  // A silent console: jsdom reports every canvas call it does not implement.
  const { window } = new JSDOM(viewerPage({ id: ID, kind: 'diagram', allowDownload: true, name: 'Checkout', updatedAt: 1 }), { url: `${ORIGIN}/b/${ID}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() })
  const requested = []
  window.XMLHttpRequest = fakeXhr(requested)
  window.fetch = async (url) => {
    requested.push(new URL(url, ORIGIN).href)
    return new Response(xml)
  }
  const run = (src) => {
    requested.push(`${ORIGIN}${src}`)
    const bytes = published(src.slice('/assets/'.length))
    if (bytes !== null) window.eval(bytes.toString('utf8'))
    return bytes !== null
  }
  // A script the page adds later (the stencils) runs the way a browser would, then reports load or error.
  new window.MutationObserver((changes) => {
    for (const script of changes.flatMap((c) => [...c.addedNodes]).filter((n) => n.nodeName === 'SCRIPT')) script.dispatchEvent(new window.Event(run(script.getAttribute('src')) ? 'load' : 'error'))
  }).observe(window.document.head, { childList: true })
  const bundled = async (entry) => (await build({ entryPoints: [entry], bundle: true, format: 'iife', write: false })).outputFiles[0].text
  for (const script of [...window.document.querySelectorAll('script[src]')]) {
    const src = script.getAttribute('src')
    if (src === '/assets/diagram.js') window.eval(await bundled(path.join(REPO, 'share', 'viewer', 'diagram.js')))
    else expect(run(src), src).toBe(true)
    // jsdom lays nothing out, so every element reads as hidden and the viewer would wait for it to show.
    if (src === '/assets/drawio/js/viewer-static.min.js') window.GraphViewer.prototype.checkVisibleState = false
  }
  await expect.poll(() => window.document.querySelector('#canvas svg')).not.toBeNull()
  return { window, requested }
}

describe.skipIf(!existsSync(VIEWER))("a shared diagram's page, drawn offline by draw.io's pinned viewer (🔒 YAZ-1802 D11)", () => {
  it('draws the diagram, loads every stencil set in one file for its library icon, and fetches nothing from anywhere else', async () => {
    const { window, requested } = await openSharedDiagram(XML)
    try {
      expect(window.document.querySelector('#canvas').textContent).toContain('Checkout service')
      expect(requested).toContain(`${ORIGIN}/scene/${ID}`)
      expect(requested).toContain(`${ORIGIN}/assets/drawio/js/stencils.min.js`)
      expect(window.mxStencilRegistry.getStencil('mxgraph.aws4.lambda')).not.toBeNull()
      // The set came out of stencils.min.js: no per-set file is asked for, and none is published.
      expect(requested.filter((url) => url.includes('/stencils/'))).toEqual([])
      expect(requested.filter((url) => !url.startsWith(`${ORIGIN}/`))).toEqual([])
      expect(window.document.getElementById('note')).toBeNull()
      expect(typeof window.document.getElementById('dl-drawio').onclick).toBe('function')
      // The viewer loads MathJax on every page: unpublished, a math label would show raw TeX.
      const mathJax = new URL(window.document.querySelector('script[src$="/startup.js"]').src)
      expect(published(mathJax.pathname.slice('/assets/'.length)), mathJax.href).not.toBeNull()
    } finally {
      window.close()
    }
  })

  it('a diagram with no library shape — a compressed page looked inside too — never loads the stencils', async () => {
    const plain = await openSharedDiagram(page(LABEL))
    const compressed = await openSharedDiagram(`<mxfile><diagram id="p1" name="Page-1">${deflateRawSync(encodeURIComponent(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${LABEL}</root></mxGraphModel>`)).toString('base64')}</diagram></mxfile>`)
    try {
      for (const { window, requested } of [plain, compressed]) {
        expect(window.document.querySelector('#canvas').textContent).toContain('Checkout service')
        expect(requested.filter((url) => url.includes('stencils'))).toEqual([])
      }
    } finally {
      plain.window.close()
      compressed.window.close()
    }
  })

  it("the diagram fonts sheet points at the Excalidraw fonts share setup publishes under /assets/fonts/, never the app's own origin", () => {
    const fontsDir = [path.join(REPO, 'client', 'node_modules'), path.join(REPO, 'node_modules')].map((base) => path.join(base, '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts')).find(existsSync)
    const urls = [...diagramFontCss().matchAll(/url\('([^']+)'\)/g)].map((m) => m[1])
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.startsWith('/assets/fonts/') && existsSync(path.join(fontsDir, url.slice('/assets/fonts/'.length))), url).toBe(true)
  })
})
