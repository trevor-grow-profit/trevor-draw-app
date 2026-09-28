#!/usr/bin/env node
/**
 * USAGE: node tools/seedLaserDemoVault.mjs --vault <dir> [--profile <dir>] [--force]
 *
 * The vault the LASER POINTER is hand-tested against (YAZ-1989): its `00 READ ME` board is the
 * 🔒 FINAL scenario list, and every other board name says the case it is for — a diagram to mark
 * up, a big canvas to pan and zoom under sticky marks, a linked shape, a dark canvas, slides for
 * presentation mode, images, an empty board, a second board to switch to, a save check and a busy
 * board. Boards only — nothing here is about any other feature.
 *
 * `--vault` IS REQUIRED AND THE PATH IS WIPED (the `seedDemoVault.mjs` rule). `--profile` also
 * writes an isolated Electron profile (`yaseendraw.json`) whose one window is already on the vault
 * (LAUNCH.md "Behaviour checks"), so no dialog is needed and the real profile is never read.
 */
import fs from 'node:fs'
import { asset as assetIn, cli, elementKit, gradientPNG, refuseExisting, scene, stripesPNG, wipe, write as writeIn, writeProfile } from './lib/seedKit.mjs'

const USAGE = 'usage: node tools/seedLaserDemoVault.mjs --vault <dir> [--profile <dir>] [--force]'
const args = cli(USAGE, { '--vault': 'dir', '--profile': 'dir' }, ['--vault'])
const VAULT = args.vault
const PROFILE = args.profile
for (const dir of [VAULT, PROFILE].filter(Boolean)) refuseExisting(dir, USAGE, { force: args.force })
wipe(VAULT)
fs.mkdirSync(VAULT, { recursive: true })

// ---------------------------------------------------------------- elements and writers
const { rect, ellipse, diamond, arrow, text, image, frame } = elementKit('l')
const board = (rel, elements, opts) => writeIn(VAULT, `${rel}.excalidraw`, scene('yaz-1989-demo', elements, opts))
const asset = (bytes) => assetIn(VAULT, bytes)
const label = (title, sub) => [text(0, -110, title, 32), ...(sub ? [text(0, -60, sub, 18, { strokeColor: '#868e96' })] : [])]

// ---------------------------------------------------------------- 00 — the scenario list
board('00 READ ME — what to try', [text(0, 0, [
  'YAZ-1989 Laser Pointer Changes — demo vault',
  '',
  'Press K for the laser. The bar: Fade | Hold | Sticky · colours · S M L · ↶ ↷ · Keep · Make permanent · Clear',
  '',
  ' 1. Fade → a short comet, gone in about 2 s',
  ' 2. Hold → 3 strokes with short pauses all stay; 5 s after the last, all fade together',
  ' 3. Hold → one long scribble stays whole (no tail eaten)',
  ' 4. Sticky → stays until you clear it',
  ' 5. Red, then yellow → the red marks stay red; mix S / M / L too',
  ' 6. Fade + ↵ right after drawing → the mark sticks (Keep)',
  ' 7. Hold + the Keep button within 5 s → it sticks',
  ' 8. Clear → gone · ⌘Z → back · ⇧⌘Z → gone again',
  ' 9. Esc with marks → gone and the tool is V · K · ⌘Z → back',
  '10. V (or any tool) with sticky marks → they stay; shapes under them still click',
  '11. Fade / Hold marks, then V → they still fade',
  '12. Clear → V → K → ↶ → back',
  '13. Move a shape, K, ⌘Z → only laser marks undo; on V, ⌘Z undoes the shape',
  '14. The footer ↶ ↷ and the bar ↶ ↷ do what ⌘Z / ⇧⌘Z do while the laser is out',
  '15. ⇧↵ / Make permanent → grouped, selected pen strokes, same colours, draggable; one ⌘Z (on V) removes them',
  '16. Sticky marks, then pan and zoom → pinned to the drawing, same thickness on screen',
  '17. Sticky on 01, another tab and back → still there; open 08 in that tab (or close it) → gone',
  '18. Marks never make a board "unsaved"; reopen → no marks; the board file has no laser keys',
  '19. Sticky + blue + L, ⌘Q, relaunch → still Sticky / blue / L, on every board',
  '20. Presentation: play 05, press K and mark',
  '21. Laser over the linked box in 03 → the link still opens',
  '22. Dark theme and 04 → every colour is easy to see',
  '23. Sticky marks left alone → Activity Monitor shows no constant CPU',
  '24. 10 (400 shapes) → marking stays smooth',
  '',
  'Also: with the laser out, click Edit › Undo in the menu bar and say what happens.',
].join('\n'), 22)])

// ---------------------------------------------------------------- boards, each named for its case
board('01 Simple diagram — mark it up', [
  ...label('Explain this flow', 'circle, underline, point'),
  rect(0, 0, 220, 110), text(40, 40, 'Sign up', 24), arrow(220, 55, 120, 0),
  diamond(340, -10, 180, 130), text(385, 40, 'Paid?', 24), arrow(520, 55, 120, 0),
  rect(640, 0, 220, 110, '#b2f2bb'), text(680, 40, 'Welcome', 24),
  arrow(430, 120, 0, 140), ellipse(340, 260, 180, 110, '#ffc9c9'), text(375, 300, 'Trial', 24),
])
board('02 Big canvas — pan and zoom with sticky marks', [
  ...label('Far-apart islands', 'mark one, pan to the next, zoom out'),
  ...[[0, 0], [2400, 0], [0, 1800], [2400, 1800], [5000, 900]].flatMap(([x, y], i) => [rect(x, y, 400, 260, ['#a5d8ff', '#ffec99', '#d0bfff', '#b2f2bb', '#ffc9c9'][i]), text(x + 40, y + 110, `Island ${i + 1}`, 36)]),
])
board('03 Links — the laser must still open them', [
  ...label('Hover the link icon with the laser'),
  rect(0, 0, 320, 140, '#a5d8ff', { link: 'https://example.com' }), text(30, 55, 'linked box', 28),
])
board('04 Dark canvas — colour visibility', [
  ...label('Try every swatch here'), rect(0, 0, 300, 160, '#343a40'), ellipse(380, 0, 200, 160, '#495057'), text(0, 220, 'dark background', 28, { strokeColor: '#f1f3f5' }),
], { bg: '#1e1e1e' })
board('05 Slides — presentation mode', [
  frame(0, 0, 960, 540, 'Slide 1'), text(60, 60, 'Slide 1 — point at things', 40), rect(80, 200, 300, 180), ellipse(520, 200, 300, 180),
  frame(1100, 0, 960, 540, 'Slide 2'), text(1160, 60, 'Slide 2 — keep a mark', 40), diamond(1300, 200, 260, 200),
])
const gradient = asset(gradientPNG(800, 500, [255, 120, 80], [60, 90, 255], { toCorner: true }))
const stripes = asset(stripesPNG(600, 400))
board('06 Images — marks over pictures', [...label('Circle something in the pictures'), image(0, 0, 800, 500, gradient), image(860, 50, 600, 400, stripes)])
board('07 Empty board', [])
board('08 Board B — switch here from 01', [...label('Board B', 'sticky marks from 01 must not follow you'), rect(0, 0, 260, 140, '#ffec99')])
board('09 Save check — marks never saved', [...label('Watch the save indicator', 'laser marks must never make this dirty'), rect(0, 0, 240, 120)])
board('10 Busy board — 400 shapes', Array.from({ length: 400 }, (_, i) => rect((i % 20) * 90, Math.floor(i / 20) * 70, 80, 55, `hsl(${(i * 11) % 360} 70% 80%)`)))

console.log(`seeded ${VAULT}`)

// ---------------------------------------------------------------- isolated profile (LAUNCH.md recipe)
if (PROFILE) {
  wipe(PROFILE)
  writeProfile(PROFILE, VAULT, { file: '00 READ ME — what to try.excalidraw', tabs: ['00 READ ME — what to try.excalidraw', '01 Simple diagram — mark it up.excalidraw'] })
  console.log(`profile ${PROFILE}`)
}
