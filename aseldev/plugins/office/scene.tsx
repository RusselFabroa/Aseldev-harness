/**
 * ASELDEV AI HQ office scene.
 *
 * The isometric renderer from `reference/office-reference.html` as one React
 * component: the same 30-degree projection, palette, geometry, camera, and
 * pixel sprites. Every drawing helper returns React elements and takes no
 * parent argument, so a draw function reads as the geometry it produces.
 *
 * Stations are `<g role="button" tabindex="0">` elements carrying
 * `data-station`; the panel delegates click and Enter/Space from the SVG root,
 * which is how the reference drives them too. That is the accessible SVG
 * stand-in for a `<button>`: SVG content models cannot nest HTML buttons.
 *
 * A specialist sits with their back to the camera facing their monitor, and a
 * working one lights its desk: a floor pool, a desk wash, and a monitor halo in
 * {@link GLOW}, all pulsing only while the panel's Motion toggle is on. Each
 * station's nameplate floats above its desk in the last-painted label layer.
 *
 * The pure helpers (`STATUS`, `statusMeta`, `calculateLayout`, `stationSlots`,
 * `isEmptyOffice`) are exported so the test harness can check the shipped
 * bundle without the shell.
 */

import * as React from 'react'

// ------------------------------------------------------------------- palette

/** World unit in SVG pixels: one scene grid step. */
const U = 24

/** cos(30°) — the isometric x/y shear shared by every object. */
const COS = Math.cos(Math.PI / 6)

/** Ceiling height of the two room walls, in world units. */
const WALL_HEIGHT = 6.8

/** Station grid metrics; changing these re-flows the whole floor. */
const MAX_ROWS_PER_WING = 4
const COLUMN_SPACING = 5.4
const ROW_SPACING = 4.4

/** Scene viewBox; the camera transform is expressed in these coordinates. */
const VIEW_WIDTH = 1440
const VIEW_HEIGHT = 810

/** Pan limit in viewBox units, matching the reference's drag clamp. */
const PAN_LIMIT = { x: 1100, y: 700 }

/** Active-work light: the pool, desk wash, monitor halo, and dot of a working station. */
export const GLOW = '#9ef0c0'

// --------------------------------------------------------------------- model

/** The lifecycle state of one specialist's workstation. */
export type OfficeStatus = 'working' | 'review' | 'blocked' | 'queued' | 'idle' | 'done' | 'offline'

/** Presentation of one status value. */
export interface StatusMeta {
  readonly label: string
  readonly color: string
}

/** Status colors and fallback labels; the panel may supply localised labels. */
export const STATUS: Record<OfficeStatus, StatusMeta> = {
  working: { label: 'Working', color: '#8fc5a1' },
  review: { label: 'Needs your approval', color: '#ffcb85' },
  blocked: { label: 'Blocked', color: '#f2929c' },
  queued: { label: 'Queued', color: '#b6b4ce' },
  idle: { label: 'Idle', color: '#a4adbb' },
  done: { label: 'Done', color: '#8bbcff' },
  offline: { label: 'Offline', color: '#8994a5' },
}

/**
 * Presentation of a status value from the wire, where a newer host may send a
 * status this build does not know: an unknown value renders as idle instead of
 * failing the whole scene.
 * @param status - raw status value.
 * @returns its label and color.
 */
export function statusMeta(status: string): StatusMeta {
  return (STATUS as Record<string, StatusMeta | undefined>)[status] ?? STATUS.idle
}

/** Job states the detail modal draws. */
export type OfficeJobStatus = 'running' | 'queued' | 'done' | 'failed' | 'blocked'

/** Job chip colors; the shared states reuse the station palette. */
export const JOB_STATUS: Record<OfficeJobStatus, StatusMeta> = {
  running: STATUS.working,
  queued: STATUS.queued,
  done: STATUS.done,
  failed: { label: 'Failed', color: '#f2929c' },
  blocked: STATUS.blocked,
}

/**
 * Fold one job status from the wire into {@link OfficeJobStatus}. The teams
 * store reports task states this build does not name (`starting`, `canceling`,
 * …), so anything active folds to running and anything unreadable folds to
 * queued rather than claiming the job is in flight.
 * @param status - raw job status.
 * @returns the state the modal draws.
 */
export function jobStatusOf(status: unknown): OfficeJobStatus {
  switch (status) {
    case 'done':
    case 'completed':
      return 'done'
    case 'failed':
    case 'error':
    case 'canceled':
    case 'cancelled':
      return 'failed'
    case 'blocked':
    case 'review':
      return 'blocked'
    case 'working':
    case 'starting':
    case 'running':
    case 'canceling':
      return 'running'
    default:
      return 'queued'
  }
}

/** One job of a specialist, as the detail modal lists it. */
export interface OfficeJob {
  readonly id: string
  readonly title: string
  readonly status: OfficeJobStatus
  readonly progress: number
  readonly startedAt: string | null
  readonly updatedAt: string | null
}

/** One teammate exactly as the office draws and describes it: a saved specialist. */
export interface OfficeAgent {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly title: string
  /** Aggregate of this specialist's jobs; the station dot and bar draw it. */
  readonly status: OfficeStatus
  readonly progress: number
  readonly managerId: string
  readonly accent: string
  readonly specialist: string | null
  /** This specialist's jobs in the session, newest first; empty for an idle teammate. */
  readonly jobs: readonly OfficeJob[]
}

/** The part of a team snapshot the scene reads. */
export interface OfficeSceneState {
  readonly boss: { readonly name: string }
  readonly agents: readonly OfficeAgent[]
}

/**
 * Whether the viewport should show the empty-state message instead of stations.
 * @param state - last good snapshot, or null before the first answer.
 * @returns true when a snapshot arrived and carries no specialists.
 */
export function isEmptyOffice(state: { readonly agents: readonly unknown[] } | null): boolean {
  return state !== null && state.agents.length === 0
}

// -------------------------------------------------------------- scene helpers

/** SVG attributes a helper may set; undefined values are dropped by React. */
type Attrs = Record<string, string | number | boolean | React.CSSProperties | undefined>
type El = React.ReactElement
type BoxColors = readonly [string, string, string]
type ScreenKind = 'kanban' | 'terminal' | 'design' | 'web' | 'tests' | 'charts'

/**
 * Element factory for the dynamic tag names the scene uses (`feGaussianBlur`,
 * `polygon`, …), which React's intrinsic-element overloads do not name.
 * @param tag - SVG element name.
 * @param attrs - presentation attributes.
 * @param children - child nodes.
 * @returns the element.
 */
function el(tag: string, attrs?: Attrs | null, ...children: React.ReactNode[]): El {
  return React.createElement(tag, (attrs ?? {}) as never, ...children)
}

/**
 * The one projection every object goes through: a 30-degree isometric camera.
 * @param x - world x in grid units.
 * @param y - world y (depth) in grid units.
 * @param z - world height in grid units.
 * @returns SVG coordinates before the camera transform.
 */
function point(x: number, y: number, z = 0): { x: number; y: number } {
  return { x: (x - y) * U * COS, y: (x + y) * U * 0.5 - z * U }
}

function rectEl(x: number, y: number, width: number, height: number, fill: string, extra: Attrs = {}): El {
  return el('rect', { x, y, width, height, fill, ...extra })
}

function polygonEl(points: readonly { x: number; y: number }[], fill: string, extra: Attrs = {}): El {
  return el('polygon', { points: points.map(q => `${q.x},${q.y}`).join(' '), fill, ...extra })
}

function lineEl(a: { x: number; y: number }, b: { x: number; y: number }, stroke: string, width = 1, extra: Attrs = {}): El {
  return el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke, strokeWidth: width, ...extra })
}

function textEl(x: number, y: number, content: string, size = 11, fill = '#dbe8f4', extra: Attrs = {}): El {
  return el('text', { x, y, fill, fontSize: size, fontFamily: 'Consolas, monospace', ...extra }, content)
}

/** One horizontal world plane (a floor patch, a desktop, a rug). */
function plane(x: number, y: number, w: number, d: number, z: number, fill: string, extra: Attrs = {}): El {
  return polygonEl([point(x, y, z), point(x + w, y, z), point(x + w, y + d, z), point(x, y + d, z)], fill, extra)
}

/** A solid box: front and side faces plus its top plane. */
function boxShape(
  x: number, y: number, w: number, d: number, height: number, z = 0,
  colors: BoxColors = ['#303947', '#1b2430', '#242e3b'],
): El {
  const [top, front, side] = colors
  return el('g', null,
    polygonEl([point(x, y + d, z), point(x + w, y + d, z), point(x + w, y + d, z + height), point(x, y + d, z + height)], front),
    polygonEl([point(x + w, y, z), point(x + w, y + d, z), point(x + w, y + d, z + height), point(x + w, y, z + height)], side),
    plane(x, y, w, d, z + height, top),
  )
}

/**
 * A wall-aligned drawing surface: children are laid out in flat pixels on the
 * world x/z plane at (x, y, z).
 * @param x - world x of the surface origin.
 * @param y - world y of the surface origin.
 * @param z - world height of the surface origin.
 * @param left - true for the left wall (mirrored shear).
 * @param children - content drawn on the surface.
 * @returns the transformed group.
 */
function surface(x: number, y: number, z: number, left: boolean, ...children: React.ReactNode[]): El {
  const q = point(x, y, z)
  return el('g', { transform: `matrix(${COS} ${left ? -0.5 : 0.5} 0 1 ${q.x} ${q.y})` }, ...children)
}

/** A floor-aligned drawing surface (text painted on the floor). */
function floorSurface(x: number, y: number, z = 0.02, ...children: React.ReactNode[]): El {
  const q = point(x, y, z)
  return el('g', { transform: `matrix(${COS} 0.5 ${-COS} 0.5 ${q.x} ${q.y})` }, ...children)
}

function short(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

interface RoleMeta {
  readonly title: string
  readonly short: string
  readonly accent: string
  readonly screen: ScreenKind
  readonly suit: string
}

const GENERAL_ROLE: RoleMeta = {
  title: 'AI Specialist', short: 'AI', accent: '#9eb2cb', screen: 'terminal', suit: '#3a485d',
}

/** Sprite/screen identity per specialist role; unknown roles draw as general. */
const ROLES: Record<string, RoleMeta> = {
  pm: { title: 'Project Manager', short: 'PM', accent: '#73b9ec', screen: 'kanban', suit: '#34465f' },
  backend: { title: 'Backend Developer', short: 'BE', accent: '#83c7b3', screen: 'terminal', suit: '#304941' },
  design: { title: 'UI/UX Designer', short: 'UX', accent: '#c3a5df', screen: 'design', suit: '#51415e' },
  frontend: { title: 'Frontend Developer', short: 'FE', accent: '#94baff', screen: 'web', suit: '#344b6b' },
  qa: { title: 'QA Tester', short: 'QA', accent: '#e6c18a', screen: 'tests', suit: '#554b36' },
  devops: { title: 'DevOps Engineer', short: 'OPS', accent: '#91b995', screen: 'charts', suit: '#354c42' },
  data: { title: 'Data Analyst', short: 'DA', accent: '#a7bde5', screen: 'charts', suit: '#3c4860' },
  security: { title: 'Security Engineer', short: 'SEC', accent: '#dba0a9', screen: 'terminal', suit: '#55404c' },
  writer: { title: 'Technical Writer', short: 'DOC', accent: '#c1c6ae', screen: 'web', suit: '#464c42' },
  research: { title: 'Research Agent', short: 'R&D', accent: '#9ccbd2', screen: 'kanban', suit: '#36535b' },
  general: GENERAL_ROLE,
}

/**
 * Sprite identity for a role key from the host.
 * @param role - raw role key.
 * @returns its role metadata, or the general specialist.
 */
export function roleMeta(role: string): RoleMeta {
  return ROLES[role] ?? GENERAL_ROLE
}

/** A host-supplied accent is used only when it is a plain six-digit hex color. */
function accentOf(agent: { readonly accent: string; readonly role: string }): string {
  return /^#[0-9a-f]{6}$/i.test(agent.accent) ? agent.accent : roleMeta(agent.role).accent
}

// --------------------------------------------------------------------- layout

/** Where one station stands on the floor. */
export interface StationPosition {
  readonly x: number
  readonly y: number
  readonly wing: 'Left wing' | 'Right wing'
}

/** The floor plan derived from the number of teammates. */
export interface OfficeLayout {
  readonly columns: number
  readonly rows: number
  readonly centerX: number
  readonly rightX: number
  readonly width: number
  readonly depth: number
  readonly boss: { readonly x: number; readonly y: number }
  readonly positions: ReadonlyMap<string, StationPosition>
}

/**
 * Two wings of stations around the command desk: left wing fills first, then
 * the right, each wing growing a column per `MAX_ROWS_PER_WING` stations.
 * @param ids - teammate ids in team order; order decides the station slot.
 * @returns the floor plan.
 */
export function calculateLayout(ids: readonly string[]): OfficeLayout {
  const wingCount = Math.ceil(ids.length / 2)
  const columns = Math.max(1, Math.ceil(wingCount / MAX_ROWS_PER_WING))
  const rows = Math.max(1, Math.ceil(wingCount / columns))
  const centerX = 3.2 + columns * COLUMN_SPACING + 1.9
  const rightX = centerX + 4.8
  const width = rightX + columns * COLUMN_SPACING + 2.2
  const depth = Math.max(18, 8.6 + rows * ROW_SPACING)
  const boss = { x: centerX - 1.7, y: 5.5 + ((rows - 1) * ROW_SPACING) / 2 }
  const positions = new Map<string, StationPosition>()

  ids.forEach((id, index) => {
    const right = index >= wingCount
    const local = right ? index - wingCount : index
    positions.set(id, {
      x: (right ? rightX : 3.2) + Math.floor(local / rows) * COLUMN_SPACING,
      y: 5.5 + (local % rows) * ROW_SPACING,
      wing: right ? 'Right wing' : 'Left wing',
    })
  })

  return { columns, rows, centerX, rightX, width, depth, boss, positions }
}

/** One station in painter's order: back rows first. */
export interface StationSlot {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly wing: StationPosition['wing']
  /** Row within its wing; alternate rows offset their nameplate. */
  readonly row: number
  /** Draw order key; the scene draws smaller values first. */
  readonly depth: number
}

/**
 * Station positions sorted back to front, so overlapping stations paint
 * correctly without the caller knowing the projection.
 * @param ids - teammate ids in team order.
 * @returns the stations in draw order.
 */
export function stationSlots(ids: readonly string[]): StationSlot[] {
  const layout = calculateLayout(ids)
  const wingCount = Math.ceil(ids.length / 2)
  const rows = Math.max(1, Math.ceil(wingCount / layout.columns))
  return ids
    .map((id, index) => {
      const position = layout.positions.get(id) ?? { x: 3.2, y: 5.5, wing: 'Left wing' as const }
      const local = index >= wingCount ? index - wingCount : index
      return {
        id,
        x: position.x,
        y: position.y,
        wing: position.wing,
        row: local % rows,
        depth: position.x + position.y + 3,
      }
    })
    .sort((a, b) => a.depth - b.depth)
}

// --------------------------------------------------------------------- sprites

const TEXT_GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '11011', '11011', '11111', '11011', '11011', '11011'],
  S: ['01111', '11000', '11000', '01110', '00011', '00011', '11110'],
  E: ['11111', '11000', '11000', '11110', '11000', '11000', '11111'],
  L: ['11000', '11000', '11000', '11000', '11000', '11000', '11111'],
  D: ['11110', '11011', '11011', '11011', '11011', '11011', '11110'],
  V: ['11011', '11011', '11011', '11011', '11011', '01110', '00100'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  H: ['11011', '11011', '11011', '11111', '11011', '11011', '11011'],
  Q: ['01110', '11011', '11011', '11011', '11111', '01110', '00011'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

const BLANK_GLYPH: readonly string[] = TEXT_GLYPHS[' '] ?? []

function pixelText(value: string, x: number, y: number, size: number, color: string): El {
  const bits: El[] = []
  for (const [index, character] of [...value].entries()) {
    const glyph = TEXT_GLYPHS[character] ?? BLANK_GLYPH
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((bit, column) => {
        if (bit === '1') bits.push(rectEl(x + (index * 6 + column) * size, y + rowIndex * size, size, size, color))
      })
    })
  }
  return el('g', { shapeRendering: 'crispEdges' }, ...bits)
}

function chair(x: number, y: number, color = '#344252'): El {
  return el('g', null,
    boxShape(x + 0.28, y + 0.28, 0.12, 0.12, 0.55, 0, ['#68788b', '#242e3c', '#334053']),
    boxShape(x + 0.04, y + 0.04, 0.64, 0.64, 0.12, 0.52, [color, '#1d2836', '#263647']),
    boxShape(x + 0.02, y + 0.6, 0.69, 0.11, 0.72, 0.63, [color, '#263647', '#465469']),
    lineEl(point(x - 0.07, y + 0.35, 0.06), point(x + 0.8, y + 0.35, 0.06), '#263343', 2),
    lineEl(point(x + 0.35, y - 0.07, 0.06), point(x + 0.35, y + 0.8, 0.06), '#263343', 2),
  )
}

function plant(x: number, y: number, size = 1): El {
  const q = point(x + 0.32 * size, y + 0.32 * size, 0.6 * size)
  const leaves: El[] = [rectEl(-1, -24, 2, 26, '#6a8057')]
  const fronds: readonly (readonly [number, number, number, number, string])[] = [
    [-11, -29, 8, 5, '#658f6c'], [-7, -25, 7, 6, '#7aa582'],
    [2, -36, 7, 7, '#759e77'], [0, -29, 5, 10, '#608f67'],
    [4, -20, 11, 5, '#7fa481'], [3, -15, 7, 6, '#567d5e'],
    [-13, -17, 9, 5, '#517f5b'], [-6, -13, 6, 8, '#709b75'],
    [-3, -40, 6, 9, '#8aad84'],
  ]
  for (const [lx, ly, w, h, color] of fronds) leaves.push(rectEl(lx, ly, w, h, color))

  return el('g', null,
    boxShape(x, y, 0.65 * size, 0.65 * size, 0.56 * size, 0, ['#b4a18a', '#6e6255', '#897968']),
    boxShape(x + 0.06 * size, y + 0.06 * size, 0.53 * size, 0.53 * size, 0.05, 0.56 * size, ['#3b3a2b', '#3b3a2b', '#3b3a2b']),
    el('g', { transform: `translate(${q.x} ${q.y}) scale(${size})`, className: 'office-pixels' }, ...leaves),
  )
}

function keyboard(x: number, y: number, z: number, w = 1.2): El {
  const keys: El[] = [plane(x, y, w, 0.38, z, '#667181')]
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 8; column++) {
      keys.push(plane(x + 0.06 + column * (w - 0.12) / 8, y + 0.035 + row * 0.105, (w - 0.18) / 9, 0.055, z + 0.01, '#b2bdc8', { opacity: 0.6 }))
    }
  }
  return el('g', null, ...keys)
}

function mug(x: number, y: number, z: number, color = '#c7b49b'): El {
  const q = point(x + 0.24, y + 0.12, z + 0.13)
  return el('g', null,
    boxShape(x, y, 0.22, 0.22, 0.3, z, [color, '#8c8276', '#a59a8b']),
    plane(x + 0.035, y + 0.035, 0.15, 0.15, z + 0.305, '#493a2d'),
    rectEl(q.x, q.y - 2, 3, 4, 'none', { stroke: color, strokeWidth: 1.3 }),
  )
}

/**
 * One screen standing on a desk. A `working` screen reads as active: the panel
 * gets a bright wash, the shell a pulsing halo, and the corner status dot the
 * glow colour.
 * @param x - world x of the screen base.
 * @param y - world y of the screen base.
 * @param z - world height of the screen's top edge.
 * @param kind - which content the panel shows.
 * @param accent - the station's accent colour.
 * @param status - the status whose colour the corner dot takes.
 * @param width - panel width in screen pixels.
 * @param height - panel height in screen pixels.
 * @param glow - light the panel up. Only a working specialist's own monitor
 *   passes true; the owner's command desk and the room's scenery never glow.
 * @returns the screen group.
 */
function screen(
  x: number, y: number, z: number, kind: ScreenKind, accent: string, status: OfficeStatus,
  width = 47, height = 30, glow = false,
): El {
  const q = point(x, y, z)
  const content: El[] = []

  if (kind === 'kanban') {
    for (let column = 0; column < 3; column++) {
      content.push(rectEl(3 + column * (width - 6) / 3, 7, (width - 10) / 3, 2, accent, { opacity: 0.7 }))
      for (let row = 0; row < (column === 1 ? 3 : 2); row++) {
        content.push(rectEl(3 + column * (width - 6) / 3, 12 + row * 5, (width - 10) / 3, 3, row === 0 ? accent : '#35506a', { opacity: 0.75 }))
      }
    }
  } else if (kind === 'terminal') {
    const lengths = [0.68, 0.43, 0.77, 0.54, 0.32]
    lengths.forEach((length, index) => {
      content.push(rectEl(4, 8 + index * 4, 2, 1.2, '#d9bb86'))
      content.push(rectEl(8, 8 + index * 4, (width - 12) * length, 1.2, accent, { opacity: index % 2 ? 0.5 : 0.9 }))
    })
    content.push(rectEl(8, 26, 3, 1.5, accent, { className: status === 'working' ? 'office-signal' : '' }))
  } else if (kind === 'design') {
    content.push(rectEl(3, 7, width * 0.57, height - 10, '#c2c8d1'))
    content.push(rectEl(6, 10, width * 0.43, 5, '#6f80b3'))
    content.push(rectEl(6, 18, width * 0.19, 7, '#8baaaa'))
    content.push(rectEl(8 + width * 0.2, 18, width * 0.19, 7, '#a58d9c'))
    for (const [index, color] of ['#c3a5df', '#ffcb85', '#83c7b3', '#94baff'].entries()) {
      content.push(rectEl(width - 11, 8 + index * 5, 7, 3, color))
    }
  } else if (kind === 'web') {
    content.push(rectEl(3, 7, width - 6, height - 10, '#afbdc9'))
    content.push(rectEl(3, 7, width - 6, 4, '#344e69'))
    content.push(rectEl(6, 14, width * 0.47, 5, '#678daf'))
    content.push(rectEl(width * 0.65, 14, width * 0.2, 10, '#6e9b9e'))
    for (let index = 0; index < 3; index++) content.push(rectEl(6, 22 + index * 2, width * 0.44, 1, '#637588'))
  } else if (kind === 'tests') {
    for (let index = 0; index < 4; index++) {
      content.push(rectEl(4, 8 + index * 5, 3, 3, index === 3 ? '#dfbd82' : '#8fc5a1'))
      content.push(rectEl(11, 9 + index * 5, width - 16 - (index % 2) * 7, 1.4, '#698499'))
    }
  } else {
    for (let index = 0; index < 7; index++) {
      const barHeight = 5 + (index * 7 % 15)
      content.push(rectEl(4 + index * (width - 7) / 7, height - 3 - barHeight, 3, barHeight, accent, { opacity: 0.5 + index * 0.06 }))
    }
    content.push(lineEl({ x: 3, y: 9 }, { x: width - 4, y: 9 }, '#35526a', 0.7))
  }

  const dots: El[] = []
  for (let index = 0; index < 3; index++) dots.push(rectEl(3 + index * 4, 1.2, 1.5, 1.5, index === 0 ? accent : '#688197'))

  const active = glow

  return el('g', { transform: `matrix(${COS} 0.5 0 1 ${q.x} ${q.y})` },
    rectEl(width * 0.46, height, 4, 7, '#506075'),
    rectEl(width * 0.29, height + 6, width * 0.42, 2, '#26384a'),
    rectEl(-2, -2, width + 4, height + 4, '#151d28', { stroke: '#506176', strokeWidth: 0.7 }),
    rectEl(0, 0, width, height, '#0c1926'),
    rectEl(0, 0, width, 4, '#22374b'),
    ...dots,
    el('g', { opacity: status === 'offline' ? 0.18 : 1 }, ...content),
    active ? rectEl(0, 0, width, height, '#bff2ff', { opacity: 0.12 }) : null,
    rectEl(width - 3, height - 1, 1.5, 1, active ? GLOW : statusMeta(status).color),
    active ? rectEl(-3, -3, width + 6, height + 6, 'none', {
      className: 'office-glow',
      stroke: GLOW,
      strokeWidth: 1.6,
      opacity: 0.55,
      filter: 'url(#office-glow)',
    }) : null,
  )
}

/**
 * One teammate sprite in three-quarter view, turned toward the upper right the
 * way the room's 30-degree projection runs: the desk sits up-right of the seat,
 * so the shoulders are angled, the head sits up-right of the torso, a sliver of
 * the right jaw and ear shows, and the near (right) arm is drawn larger than the
 * far one. Drawn from pixels, not by rotating the group, so the grid stays crisp
 * and the feet stay planted on the chair. The typing sway hook stays; there is
 * no face, so no eye blink.
 * @param x - sprite anchor x in SVG coordinates.
 * @param y - sprite anchor y (feet line, unchanged by the turn).
 * @param scale - sprite pixel scale.
 * @param agent - the teammate to draw, or null for the owner.
 * @param human - draw the owner's suit, skin, and amber trim.
 * @returns the sprite group.
 */
function character(x: number, y: number, scale: number, agent: OfficeAgent | null, human = false): El {
  const meta = roleMeta(agent?.role ?? 'general')
  const suit = human ? '#3d4e65' : meta.suit
  const accent = human ? '#ffcb85' : (agent === null ? meta.accent : accentOf(agent))
  const skin = human ? '#d6aa87' : '#94a5b4'
  const skinShade = human ? '#b98f72' : '#7d8ea0'
  const hair = human ? '#302b29' : '#2b3644'
  const hairLight = human ? '#413a35' : '#37455a'
  const hairRim = human ? '#3d3632' : '#55697d'
  const collar = human ? '#7f8ea0' : '#7c8b9c'
  const body: El[] = []
  const add = (a: number, b: number, c: number, d: number, color: string, extra: Attrs = {}): void => {
    body.push(rectEl(a, b, c, d, color, extra))
  }

  // Feet and legs are unchanged: the seat contact is the sprite's base, so the
  // turn never lifts the figure off the chair.
  add(-5, -3, 4, 3, '#101824'); add(2, -3, 4, 3, '#101824')
  add(-4, -8, 3, 5, '#243343')
  add(2, -8, 4, 5, '#1f2c3a')

  // Back of the uniform, turned: the near shoulder reaches right and forward,
  // the far shoulder falls into shadow, and the centre seam steps along the
  // 30-degree axis instead of running straight down.
  add(-5, -15, 11, 8, suit)
  add(4, -14, 3, 7, suit)
  add(-5, -15, 1, 5, '#1d2a38')
  add(-3, -15, 8, 1, collar)
  add(-2, -15, 5, 1, '#a9b8c6')
  add(-4, -9, 10, 1, '#273949')
  add(-3, -14, 1, 3, '#22303f')
  add(-2, -11, 1, 3, '#22303f')
  add(-1, -8, 1, 2, '#22303f')

  // Antenna above the skull, carried with the head's offset; it keeps the
  // signal hook that marks a working teammate.
  if (!human) {
    add(1, -29, 2, 4, '#64798d')
    add(0, -30, 4, 2, accent, { className: agent?.status === 'working' ? 'office-signal' : '' })
  }

  // Head, carried up-right of the shoulders: the skull from behind, with the
  // right jaw, cheek edge, and an ear showing above the collar.
  add(-3, -25, 12, 10, '#728394')
  add(-3, -25, 10, 9, hair)
  add(-3, -24, 1, 7, hairRim)
  add(0, -25, 6, 2, hairLight)
  add(7, -23, 2, 6, skin)
  add(6, -22, 1, 2, skinShade)
  add(-3, -17, 10, 1, '#5c6f83')
  add(1, -16, 3, 2, skinShade)
  add(1, -15, 3, 1, agent?.status === 'review' && !human ? '#ffcb85' : '#87a3b8')

  if (human) {
    add(0, -14, 3, 3, '#ffcb85')
  } else {
    add(1, -13, 2, 2, accent)
    if (agent?.role === 'devops') {
      add(-6, -23, 2, 7, '#202c3d'); add(9, -23, 2, 7, '#202c3d')
      add(-4, -27, 13, 2, '#4f657b')
    }
    if (agent?.role === 'backend') {
      add(-5, -25, 2, 9, suit); add(9, -25, 2, 9, suit)
    }
    if (agent?.role === 'design') {
      add(-4, -27, 13, 2, '#9f82b1'); add(5, -28, 5, 1, '#b69bc6')
    }
    if (agent?.role === 'qa') {
      add(-3, -22, 10, 1, '#dac18e')
    }
  }

  // Arms reach up-right to the keyboard. The near arm is a full forearm and a
  // four-pixel hand; the far one is a sliver and a small hand behind the torso.
  const hands: El[] = [
    rectEl(-6, -12, 1, 4, suit),
    rectEl(-7, -15, 2, 2, skin),
    rectEl(6, -18, 3, 6, suit),
    rectEl(7, -19, 4, 3, skin),
  ]

  return el('g', { transform: `translate(${x} ${y}) scale(${scale})` },
    el('g', { className: 'office-pixels' },
      ...body,
      el('g', { className: !human && agent?.status === 'working' ? 'office-typing' : '' }, ...hands),
    ),
  )
}

/** A large pixel portrait of one teammate (or the owner) for the detail modal. */
export function TeammatePortrait(props: { agent: OfficeAgent | null }): El {
  return el('svg', { viewBox: '0 0 68 76', className: 'office-portrait', 'aria-hidden': 'true', focusable: 'false' },
    character(34, 70, 2.05, props.agent, props.agent === null),
  )
}

// ------------------------------------------------------------------ scenery

function Defs(): El {
  return el('defs', null,
    el('filter', { id: 'office-glow', x: '-70%', y: '-70%', width: '240%', height: '240%' },
      el('feGaussianBlur', { stdDeviation: 2.5, result: 'blur' }),
      el('feMerge', null, el('feMergeNode', { in: 'blur' }), el('feMergeNode', { in: 'SourceGraphic' })),
    ),
    el('filter', { id: 'office-ground-shade', x: '-30%', y: '-50%', width: '160%', height: '200%' },
      el('feGaussianBlur', { stdDeviation: 15 }),
    ),
    el('pattern', { id: 'office-carpet', width: 5, height: 5, patternUnits: 'userSpaceOnUse' },
      rectEl(0, 0, 5, 5, '#303947'),
      rectEl(1, 1, 1, 1, '#3a4553'),
      rectEl(3, 3, 1, 1, '#26313e'),
    ),
  )
}

const WOOD: readonly string[] = ['#a17d59', '#997451', '#a7825d', '#96714f', '#a5805a', '#9e7855']

function Floor(props: { layout: OfficeLayout }): El {
  const { layout } = props
  const W = layout.width
  const D = layout.depth
  const parts: React.ReactNode[] = [
    plane(-0.4, -0.4, W + 0.8, D + 0.8, -0.95, '#000', { opacity: 0.45, filter: 'url(#office-ground-shade)' }),
    boxShape(-0.16, -0.16, W + 0.32, D + 0.32, 0.65, -0.65, ['#8a6a4d', '#242d3b', '#1a2431']),
  ]

  for (let row = 0, y = 0; y < D; row++, y += 0.62) {
    const offset = row % 2 ? 1.6 : 0
    for (let x = -offset, column = 0; x < W; x += 3.2, column++) {
      const start = Math.max(0, x)
      const end = Math.min(W, x + 3.2)
      if (end <= start) continue
      parts.push(plane(start, y, end - start, Math.min(0.62, D - y), 0.005, WOOD[(row * 7 + column * 3) % WOOD.length] ?? WOOD[0] ?? '#a17d59', { stroke: '#654c36', strokeWidth: 0.45 }))
      if (end - start > 0.9) {
        parts.push(lineEl(point(start + 0.18, y + 0.2, 0.01), point(end - 0.2, y + 0.2, 0.01), '#c59d70', 0.45, { opacity: 0.36 }))
        parts.push(lineEl(point(start + 0.35, y + 0.43, 0.01), point(end - 0.3, y + 0.43, 0.01), '#6e523a', 0.45, { opacity: 0.3 }))
      }
    }
  }

  const rugWidth = layout.columns * COLUMN_SPACING - 0.6
  const rugDepth = layout.rows * ROW_SPACING - 0.25
  for (const x of [2.7, layout.rightX - 0.5]) {
    parts.push(plane(x, 5.03, rugWidth, rugDepth, 0.025, 'url(#office-carpet)', { stroke: '#58606a', strokeWidth: 0.6 }))
    parts.push(plane(x + 0.16, 5.19, rugWidth - 0.32, rugDepth - 0.32, 0.03, 'none', { stroke: '#73808a', strokeWidth: 0.45, opacity: 0.35 }))
  }

  const b = layout.boss
  parts.push(plane(b.x - 0.6, b.y - 0.5, 5.8, 4.2, 0.035, '#243748', { stroke: '#4d6b80', strokeWidth: 0.7 }))
  parts.push(plane(b.x - 0.38, b.y - 0.28, 5.36, 3.76, 0.04, 'none', { stroke: '#37bfff', strokeWidth: 0.65, opacity: 0.4 }))

  for (const x of [layout.centerX - 1.2, layout.centerX + 2.6]) {
    for (let y = 2.5; y < D - 1; y += 2) {
      if (y > b.y - 1 && y < b.y + 4) continue
      parts.push(plane(x, y, 0.08, 0.5, 0.04, '#f4d3a3', { opacity: 0.4 }))
    }
  }

  parts.push(lineEl(point(0, D, -0.25), point(W, D, -0.25), '#45566a', 1.5))
  parts.push(lineEl(point(W, 0, -0.25), point(W, D, -0.25), '#394b60', 1.5))
  for (let x = 1; x < W; x += 3.5) {
    parts.push(lineEl(point(x, D, -0.3), point(x + 0.7, D, -0.3), '#37bfff', 1.4, { opacity: 0.5 }))
  }

  parts.push(boxShape(layout.centerX - 0.5, D, 3.6, 0.55, 0.22, -0.65, ['#526071', '#242f40', '#354253']))
  parts.push(boxShape(layout.centerX - 0.5, D + 0.55, 3.6, 0.5, 0.12, -0.65, ['#3a495c', '#202a37', '#2a3646']))
  parts.push(floorSurface(layout.centerX - 0.1, D - 1.2, 0.02, textEl(0, 0, 'ASELDEV / HQ', 9, '#dac5ab', { letterSpacing: 2 })))

  return el('g', null, ...parts)
}

function Walls(props: { layout: OfficeLayout }): El {
  const { layout } = props
  const W = layout.width
  const D = layout.depth
  const H = WALL_HEIGHT
  const parts: React.ReactNode[] = []

  parts.push(polygonEl([point(0, 0), point(W, 0), point(W, 0, H), point(0, 0, H)], '#171c26'))
  for (let x = 0; x < W; x += 1.65) {
    parts.push(lineEl(point(x, 0, 0.1), point(x, 0, H - 0.1), '#303947', 0.8))
    if (x + 1.4 < W) parts.push(plane(x, 0, 1.4, 0.08, H - 0.2, '#394655'))
  }
  parts.push(lineEl(point(0, 0, H), point(W, 0, H), '#566477', 3))
  parts.push(lineEl(point(0, 0, 0.15), point(W, 0, 0.15), '#303f51', 4))

  parts.push(polygonEl([point(0, 0), point(0, D), point(0, D, H), point(0, 0, H)], '#142333'))

  let index = 0
  for (let y = 0.35; y < D - 0.35; y += 2.8, index++) {
    const span = Math.min(2.55, D - y - 0.25)
    parts.push(polygonEl([point(0, y, 0.55), point(0, y + span, 0.55), point(0, y + span, H - 0.35), point(0, y, H - 0.35)], '#1f3548'))
    const width = span * U

    const pane: React.ReactNode[] = [
      rectEl(2, 0, width - 4, 127, '#223b51'),
      rectEl(2, 0, width - 4, 65, '#294b63', { opacity: 0.48 }),
    ]
    for (let k = 0; k < 4; k++) {
      const buildingHeight = 23 + ((index * 11 + k * 17) % 39)
      pane.push(rectEl(4 + k * (width - 9) / 4, 128 - buildingHeight, (width - 12) / 4, buildingHeight, '#162b3d', { opacity: 0.85 }))
      for (let r = 0; r < 3; r++) {
        pane.push(rectEl(7 + k * (width - 9) / 4, 133 - buildingHeight + r * 9, 2, 3, k % 2 ? '#6a889c' : '#c1ae87', { opacity: 0.45 }))
      }
    }
    pane.push(polygonEl([{ x: 3, y: 4 }, { x: 12, y: 4 }, { x: width - 5, y: 93 }, { x: width - 5, y: 116 }], '#a4d9f3', { opacity: 0.06 }))
    parts.push(surface(0, y + span, H - 0.55, true, ...pane))

    parts.push(lineEl(point(0, y, 0.5), point(0, y, H - 0.3), '#63788d', 1.7))
    parts.push(lineEl(point(0, y + span, 0.5), point(0, y + span, H - 0.3), '#3d5369', 2))
    parts.push(lineEl(point(0, y, 2.6), point(0, y + span, 2.6), '#3d5369', 1))
    parts.push(lineEl(point(0, y, 0.5), point(0, y + span, 0.5), '#738697', 2))

    if (index % 2 === 0) {
      parts.push(polygonEl([point(0.1, y, 0.03), point(4, y + 1, 0.03), point(4, y + 2, 0.03), point(0.1, y + span, 0.03)], '#97c9e7', { opacity: 0.055 }))
    }
  }

  parts.push(lineEl(point(0, 0, H), point(0, D, H), '#5b6e80', 3))
  parts.push(lineEl(point(0, 0, H - 0.24), point(0, D, H - 0.24), '#ffcb85', 1.4, { opacity: 0.7 }))
  parts.push(lineEl(point(0, 0, 0.1), point(0, D, 0.1), '#35495e', 4))

  for (let x = 1; x < W - 1; x += 5) {
    parts.push(lineEl(point(x, 0.04, H - 0.55), point(x + 1.8, 0.04, H - 0.55), '#ffdcaa', 3, { filter: 'url(#office-glow)', opacity: 0.65 }))
    parts.push(polygonEl([point(x, 0, H - 0.65), point(x + 1.8, 0, H - 0.65), point(x + 2.2, 0, 2.8), point(x - 0.4, 0, 2.8)], '#ffcb85', { opacity: 0.025 }))
  }

  return el('g', null, ...parts)
}

function Brand(props: { layout: OfficeLayout; agents: readonly OfficeAgent[] }): El {
  const { layout, agents } = props
  const average = agents.length
    ? Math.round(agents.reduce((sum, agent) => sum + agent.progress, 0) / agents.length)
    : 0

  const logo: El[] = [
    polygonEl([{ x: 16, y: 43 }, { x: 30, y: 12 }, { x: 39, y: 12 }, { x: 52, y: 43 }, { x: 43, y: 43 }, { x: 34, y: 23 }, { x: 25, y: 43 }], '#37bfff'),
    rectEl(27, 34, 17, 5, '#9dddff'),
  ]

  const bars: El[] = []
  for (let index = 0; index < 3; index++) {
    bars.push(rectEl(8, 17 + index * 8, 94, 3, '#263546'))
    bars.push(rectEl(8, 17 + index * 8, 94 * Math.min(1, (average + index * 8) / 100), 3, index === 0 ? '#37bfff' : '#527d99'))
  }
  const dots: El[] = agents.slice(0, 12).map((agent, index) =>
    rectEl(129 + (index % 6) * 14, 19 + Math.floor(index / 6) * 9, 8, 4, statusMeta(agent.status).color))
  const dashboards: El[] = [
    rectEl(0, 0, 111, 47, '#0b141f', { stroke: '#3a4d62', strokeWidth: 1 }),
    rectEl(121, 0, 111, 47, '#0b141f', { stroke: '#3a4d62', strokeWidth: 1 }),
    textEl(8, 11, `PROJECT / ${String(average)}%`, 6.5, '#a6bdcf'),
    ...bars,
    textEl(129, 11, 'AGENT ACTIVITY', 6.5, '#a6bdcf'),
    ...dots,
    textEl(129, 42, `${String(agents.length)} AGENTS`, 5.7, '#859bb0'),
  ]

  return el('g', null,
    surface(layout.centerX - 4.4, 0.04, 6.12, false,
      rectEl(0, 0, 232, 63, '#101924', { stroke: '#324d63', strokeWidth: 1 }),
      rectEl(0, 62, 232, 2, '#37bfff', { opacity: 0.55 }),
      el('g', { filter: 'url(#office-glow)' }, ...logo),
      pixelText('ASELDEV', 66, 13, 3, '#73d0ff'),
      pixelText('AI HQ', 67, 43, 1.4, '#c7dfec'),
    ),
    surface(layout.centerX - 4.4, 0.06, 3.05, false, ...dashboards),
  )
}

function Meeting(): El {
  const x = 2.4
  const y = 1.5
  const columns: El[] = []
  for (let column = 0; column < 3; column++) {
    columns.push(rectEl(6 + column * 22, 14, 17, 2, '#5f809b'))
    for (let row = 0; row < 3; row++) {
      columns.push(rectEl(6 + column * 22, 20 + row * 7, 15, 4, ['#7ca9c6', '#c4af83', '#89a893'][column] ?? '#7ca9c6', { opacity: 0.8 }))
    }
  }

  return el('g', null,
    plane(x - 0.75, y - 0.55, 5, 3.5, 0.02, '#41454a', { opacity: 0.7 }),
    chair(x + 0.15, y - 0.55),
    chair(x + 1.7, y - 0.55),
    boxShape(x + 0.2, y + 0.2, 0.12, 0.12, 1.1, 0),
    boxShape(x + 2.7, y + 1.3, 0.12, 0.12, 1.1, 0),
    boxShape(x, y, 3, 1.75, 0.14, 1.1, ['#bb9369', '#8c694a', '#a47d55']),
    plane(x + 0.2, y + 0.2, 2.6, 1.35, 1.25, 'none', { stroke: '#d2ab7b', strokeWidth: 0.6 }),
    screen(x + 1.2, y + 0.6, 1.85, 'kanban', '#8ab9d8', 'working', 24, 15),
    mug(x + 0.4, y + 1.1, 1.25),
    plane(x + 2.2, y + 0.8, 0.45, 0.6, 1.26, '#c2c9ca'),
    chair(x + 0.15, y + 2),
    chair(x + 1.7, y + 2),
    plant(x + 3.6, y + 0.45, 0.9),
    surface(0.03, 4.8, 4.9, true,
      rectEl(0, 0, 72, 46, '#18293a', { stroke: '#5f778d', strokeWidth: 1.5 }),
      textEl(6, 9, 'SPRINT PLANNING', 5.7, '#c1d6e5'),
      ...columns,
    ),
  )
}

function Servers(props: { layout: OfficeLayout }): El {
  const x = props.layout.width - 6.1
  const y = 1.05
  const racks: React.ReactNode[] = [
    plane(x - 0.4, y - 0.25, 4.9, 2.7, 0.03, '#25313e', { stroke: '#415364', strokeWidth: 0.5 }),
  ]

  for (let index = 0; index < 3; index++) {
    const rx = x + index * 1.35
    const face: React.ReactNode[] = [
      rectEl(0, 0, 21, 73, '#0c1825', { stroke: '#4e6277', strokeWidth: 0.65 }),
    ]
    for (let rack = 0; rack < 7; rack++) {
      face.push(rectEl(2, 4 + rack * 9, 17, 6, '#26394c'))
      face.push(rectEl(3, 6 + rack * 9, 2, 1.5, rack % 4 === 0 ? '#8fc5a1' : '#37bfff', {
        className: 'office-signal',
        style: { animationDelay: `-${(index + rack) * 0.3}s` },
      }))
      for (let vent = 0; vent < 4; vent++) face.push(rectEl(8 + vent * 2.4, 6 + rack * 9, 1, 2, '#101e2d'))
    }
    face.push(textEl(3, 70, `0${String(index + 1)}`, 5, '#8ca5bb'))
    racks.push(
      boxShape(rx, y, 1.07, 1.35, 3.6, 0, ['#435163', '#172331', '#293a4b']),
      surface(rx + 0.08, y + 1.355, 3.36, false, ...face),
    )
  }

  return el('g', null,
    ...racks,
    surface(x, 0.02, 4.5, false, textEl(0, 0, 'INFRASTRUCTURE', 9, '#a2b5c7', { letterSpacing: 1 })),
    lineEl(point(x, y + 1.75, 0.05), point(x + 3.85, y + 1.75, 0.05), '#37bfff', 1, { opacity: 0.4 }),
  )
}

function Lounge(props: { layout: OfficeLayout }): El {
  const x = 2.6
  const y = props.layout.depth - 3.55
  const cushions: El[] = []
  for (let index = 0; index < 3; index++) {
    cushions.push(boxShape(x + 0.38 + index * 1.13, y + 0.32, 1.04, 0.82, 0.13, 0.65, ['#637080', '#455260', '#536171']))
  }
  const warm = point(x - 0.25, y + 1.5, 3.2)

  return el('g', null,
    plane(x - 0.55, y - 0.5, 5.8, 3.3, 0.02, '#6c665e', { opacity: 0.6 }),
    boxShape(x, y, 4.1, 1.3, 0.55, 0.12, ['#45515e', '#2d3947', '#374351']),
    boxShape(x, y, 4.1, 0.24, 0.9, 0.62, ['#536171', '#374554', '#425162']),
    boxShape(x, y, 0.28, 1.3, 0.75, 0.45, ['#526071', '#334150', '#435161']),
    boxShape(x + 3.82, y, 0.28, 1.3, 0.75, 0.45, ['#526071', '#334150', '#435161']),
    ...cushions,
    boxShape(x + 0.55, y + 0.2, 0.62, 0.27, 0.48, 0.83, ['#b3a58f', '#938673', '#a99b83']),
    boxShape(x + 2.7, y + 0.2, 0.62, 0.27, 0.48, 0.83, ['#65818a', '#435e6a', '#54717e']),
    boxShape(x + 1.05, y + 1.8, 1.8, 0.9, 0.12, 0.5, ['#b28b61', '#806245', '#96734f']),
    boxShape(x + 1.35, y + 2, 0.15, 0.4, 0.5, 0),
    boxShape(x + 2.35, y + 2, 0.15, 0.4, 0.5, 0),
    mug(x + 1.3, y + 2.1, 0.63, '#d7b58c'),
    plane(x + 2, y + 1.98, 0.55, 0.4, 0.63, '#627c8e'),
    plant(x + 4.6, y + 0.75, 1.1),
    lineEl(point(x - 0.25, y + 1.5), point(x - 0.25, y + 1.5, 3.4), '#596372', 2),
    plane(x - 0.5, y + 1.25, 0.5, 0.5, 0.05, '#35404d'),
    boxShape(x - 0.65, y + 1.1, 0.8, 0.8, 0.45, 3.2, ['#e4c49a', '#a59178', '#c9ad88']),
    el('ellipse', { cx: warm.x, cy: warm.y + 12, rx: 18, ry: 8, fill: '#ffcb85', opacity: 0.08, filter: 'url(#office-glow)' }),
  )
}

function Coffee(props: { layout: OfficeLayout }): El {
  const x = props.layout.width - 5.1
  const y = props.layout.depth - 3.3
  const seams: El[] = []
  for (let index = 0; index < 3; index++) {
    seams.push(lineEl(point(x + 0.9 * index, y + 1.055, 0.15), point(x + 0.9 * index, y + 1.055, 1.16), '#4b5a6c', 0.7))
    seams.push(lineEl(point(x + 0.2 + 0.9 * index, y + 1.07, 1), point(x + 0.5 + 0.9 * index, y + 1.07, 1), '#a3a9ad', 1.2))
  }
  const display = surface(x + 0.37, y + 0.83, 2.03, false,
    rectEl(0, 0, 13, 10, '#101e2a'),
    rectEl(3, 2, 7, 2, '#70b6cb'),
    rectEl(4, 9, 5, 7, '#10171f'),
  )

  return el('g', null,
    boxShape(x, y, 2.8, 1.05, 1.25, 0, ['#48515d', '#283442', '#364452']),
    boxShape(x - 0.06, y - 0.04, 2.92, 1.13, 0.12, 1.25, ['#b69775', '#85694e', '#a1815e']),
    ...seams,
    boxShape(x + 0.3, y + 0.2, 0.75, 0.62, 0.8, 1.37, ['#5b6674', '#1b2b3b', '#3f4d5e']),
    display,
    mug(x + 0.5, y + 0.82, 1.38, '#d6c4ad'),
    mug(x + 1.5, y + 0.5, 1.38, '#c2cdd5'),
    mug(x + 1.9, y + 0.5, 1.38, '#95a7b8'),
    plant(x + 3.3, y + 0.15, 0.9),
  )
}

function Connections(props: { layout: OfficeLayout; agents: readonly OfficeAgent[] }): El | null {
  const { layout, agents } = props
  if (agents.length === 0) return null
  const positions = new Map<string, { x: number; y: number }>(layout.positions)
  positions.set('boss', layout.boss)
  const paths: El[] = []

  for (const agent of agents) {
    const target = positions.get(agent.id)
    const manager = positions.get(agent.managerId)
    if (target === undefined || manager === undefined) continue
    const from = point(manager.x + (agent.managerId === 'boss' ? 2.3 : 1.8), manager.y + 2.65, 0.1)
    const to = point(target.x + 1.8, target.y + 2.65, 0.1)
    const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 + 20 }
    paths.push(el('path', {
      d: `M ${from.x} ${from.y} Q ${middle.x} ${middle.y} ${to.x} ${to.y}`,
      fill: 'none',
      stroke: agent.managerId === 'boss' ? '#ffcb85' : '#8ac5e9',
      strokeWidth: 1.2,
      opacity: 0.55,
      className: 'office-route',
      pointerEvents: 'none',
    }))
  }

  return el('g', null, ...paths)
}

// ------------------------------------------------------------------- stations

/** Monitor top of a specialist desk: the base z its `screen()` is drawn from. */
export const MONITOR_TOP_Z = 2.75

/** Head top of a seated specialist sprite: 30 sprite pixels up from the seat. */
export const HEAD_TOP_Z = 0.43 + 30 * 1.45 / U

interface StationProps {
  readonly agent: OfficeAgent | null
  readonly position: { readonly x: number; readonly y: number }
  readonly bossName: string
  readonly selected: boolean
  readonly statusLabel: (status: string) => string
}

/**
 * One specialist's desk, or the owner's command desk. The station is the
 * specialist, not a job: its dot, nameplate bar, and accessible name come from
 * that specialist's aggregate status and progress.
 * @param props - the specialist or null for the owner, its slot, and the selection.
 * @returns the station group.
 */
function Station(props: StationProps): El {
  const { agent, position, bossName, selected, statusLabel } = props
  const human = agent === null
  const { x, y } = position
  const width = human ? 4.6 : 3.55
  const depth = human ? 1.85 : 1.6
  const accent = human ? '#37bfff' : accentOf(agent)
  const id = human ? 'boss' : agent.id
  const meta = roleMeta(agent?.role ?? 'general')
  const status = agent?.status ?? 'idle'
  /** Active work: only a specialist whose aggregate status is working lights up. */
  const active = !human && status === 'working'
  const equipment: React.ReactNode[] = []

  if (active) {
    // Floor pool under the desk: the station's footprint reads as lit.
    const pool = point(x + width / 2, y + depth + 0.6, 0.09)
    equipment.push(el('ellipse', {
      className: 'office-glow',
      cx: pool.x,
      cy: pool.y,
      rx: width * U * 0.62,
      ry: width * U * 0.3,
      fill: GLOW,
      fillOpacity: 0.16,
      filter: 'url(#office-glow)',
    }))
  }

  for (const dx of [0.15, width - 0.28]) {
    for (const dy of [0.13, depth - 0.25]) {
      equipment.push(boxShape(x + dx, y + dy, 0.13, 0.13, 1.32, 0, ['#465264', '#152131', '#202d40']))
    }
  }
  equipment.push(boxShape(x + 0.1, y + depth - 0.24, width - 0.2, 0.12, 0.75, 0.5, ['#273849', '#192635', '#243447']))
  equipment.push(boxShape(x, y, width, depth, 0.14, 1.32, ['#323e4d', '#151e2c', '#202d3c']))
  equipment.push(lineEl(point(x, y + depth, 1.37), point(x + width, y + depth, 1.37), accent, human ? 2 : 1.15, { opacity: human ? 0.9 : 0.55 }))
  if (active) {
    // Desk-top wash, over the surface and under the monitor.
    equipment.push(plane(x + 0.06, y + 0.06, width - 0.12, depth - 0.12, 1.47, GLOW, {
      className: 'office-glow',
      fillOpacity: 0.14,
      filter: 'url(#office-glow)',
    }))
  }

  if (human) {
    equipment.push(
      screen(x + 0.15, y + 0.25, 2.8, 'kanban', '#6cc7f3', 'working', 32, 25, false),
      screen(x + 1.55, y + 0.25, 2.95, 'charts', '#7fcab8', 'working', 36, 28, false),
      screen(x + 3.12, y + 0.25, 2.8, 'terminal', '#83c7b3', 'working', 31, 25, false),
      keyboard(x + 1.65, y + 1.2, 1.48, 1.4),
      mug(x + 0.38, y + 1.17, 1.47, '#ffcb85'),
      surface(x + 1.65, y + depth + 0.01, 1.16, false,
        pixelText('A', 0, 0, 1.4, '#37bfff'),
        textEl(13, 8, 'ASELDEV', 5.5, '#78aecb'),
      ),
    )
  } else {
    equipment.push(
      screen(x + 0.4, y + 0.3, MONITOR_TOP_Z, meta.screen, accent, status, 47, 30, active),
      keyboard(x + 1.05, y + 1.11, 1.48),
      plane(x + 2.43, y + 1.12, 0.33, 0.28, 1.48, '#667789'),
      mug(x + 2.94, y + 0.9, 1.48, accent),
    )

    if (agent.role === 'pm') {
      equipment.push(plane(x + 0.15, y + 0.94, 0.55, 0.47, 1.49, '#d1be92'))
      for (let index = 0; index < 3; index++) {
        equipment.push(plane(x + 0.23, y + 1.02 + index * 0.1, 0.31, 0.025, 1.5, '#7f847d'))
      }
    } else if (agent.role === 'design') {
      equipment.push(plane(x + 0.09, y + 0.95, 0.65, 0.5, 1.49, '#172535'))
      const swatches = ['#c3a5df', '#ffcb85', '#83c7b3']
      for (let index = 0; index < 3; index++) {
        equipment.push(plane(x + 0.16 + index * 0.17, y + 1.1, 0.1, 0.15, 1.5, swatches[index] ?? '#c3a5df'))
      }
    } else if (agent.role === 'backend' || agent.role === 'devops') {
      equipment.push(boxShape(x + width - 0.5, y + 0.15, 0.38, 0.48, 0.9, 0.1, ['#33465a', '#172636', '#24384c']))
    }
  }

  const cx = x + width * 0.58
  const cy = y + 2.08
  const seat = point(cx, cy + 0.1, 0.43)

  // `title` is the role label the host draws from the roster; `specialist` is
  // its id there, so it is only the fallback.
  const roleLabel = agent === null ? '' : (agent.title !== '' ? agent.title : agent.specialist ?? 'AI specialist')
  // One station means one specialist, so its name says how much work it carries.
  const jobCount = agent === null ? 0 : agent.jobs.length
  const runningJobs = agent === null ? 0 : agent.jobs.filter(job => job.status === 'running').length
  const jobNote = jobCount === 0 ? '' : `, ${String(jobCount)} ${jobCount === 1 ? 'job' : 'jobs'}, ${String(runningJobs)} running`
  const label = human
    ? `${bossName}, command desk`
    : `${agent.name}, ${roleLabel}, ${statusLabel(agent.status)}${jobNote}`

  return el('g', {
    className: `office-station${selected ? ' office-selected' : ''}${active ? ' office-working' : ''}`,
    'data-station': id,
    'data-status': human ? 'owner' : status,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
    'aria-label': label,
  },
    // Hover tooltip, as in the reference; the aria-label owns the AT name.
    el('title', null, human ? 'Your command desk' : `${agent.name} · ${roleLabel}`),
    plane(x - 0.35, y - 0.25, width + 0.7, 3.55, 0.07, '#37bfff', {
      className: 'office-selection', fillOpacity: 0.07, stroke: '#64ceff', strokeWidth: 1.5,
    }),
    plane(x + 0.1, y + 0.15, width + 0.15, 2.6, 0.07, '#0a1422', { opacity: 0.18 }),
    el('g', { className: 'office-equipment' }, ...equipment),
    chair(cx - 0.33, cy - 0.28, human ? '#52657c' : '#394a5b'),
    character(seat.x, seat.y, 1.45, human ? null : agent, human),
  )
}

// ------------------------------------------------------------------- labels

/** One nameplate width for every station, so the plates line up over the desks. */
const PLATE_WIDTH = 132

/**
 * Plate anchors, in world units: over the desk (its depth is 1.6-1.85) and high
 * above it, so a plate floats above the monitor and the seated sprite instead of
 * covering the floor in front of the desk.
 */
export const PLATE_ANCHOR_Y = 0.8
export const PLATE_ANCHOR_Z = 4.5

/** Plate box: the plate hangs this far below its anchor and is this tall. */
const PLATE_TOP_PAD = 4
export const PLATE_HEIGHT = 29

/** World z of the plate's bottom edge, which must clear the desk's monitor. */
export const PLATE_BOTTOM_Z = PLATE_ANCHOR_Z - (PLATE_TOP_PAD + PLATE_HEIGHT) / U

/** Alternate rows offset their plate so neighbouring labels do not stack. */
const PLATE_ROW_NUDGE_X = 0.55

/** One station's label target: the body it names plus its plate anchor. */
interface LabelSlot {
  readonly depth: number
  readonly agent: OfficeAgent | null
  readonly slot: StationSlot
}

/**
 * One nameplate: the reference's dark plate with a status dot, name, role, and
 * a progress bar, floating above the desk it names. It carries `data-station`
 * for the scene's click/Enter delegation but is deliberately not focusable —
 * the station body owns the accessible name.
 * @param props - the teammate or null for the owner, its slot, and the owner's name.
 * @returns the plate group.
 */
function Nameplate(props: { readonly agent: OfficeAgent | null; readonly slot: StationSlot; readonly bossName: string }): El {
  const { agent, slot, bossName } = props
  const human = agent === null
  const statusInfo = statusMeta(agent?.status ?? 'idle')
  const deskWidth = human ? 4.6 : 3.55
  // Above the middle of the desk, high enough that the plate's bottom edge
  // clears the monitor and the seated sprite, with alternate rows shifted so
  // plates never stack on the same pixels.
  const anchor = point(
    slot.x + deskWidth / 2 + (slot.row % 2 === 1 ? PLATE_ROW_NUDGE_X : 0),
    slot.y + PLATE_ANCHOR_Y,
    PLATE_ANCHOR_Z,
  )
  const left = anchor.x - PLATE_WIDTH / 2
  const top = anchor.y - PLATE_TOP_PAD
  const plate: React.ReactNode[] = [
    rectEl(left, top, PLATE_WIDTH, PLATE_HEIGHT, '#101b28', {
      className: 'office-nameplate',
      rx: 4,
      stroke: human ? '#4e91b6' : '#4a5c70',
      strokeWidth: 0.7,
    }),
    rectEl(left + 8, top + 8, 4, 4, human ? '#ffcb85' : (agent?.status === 'working' ? GLOW : statusInfo.color)),
    textEl(left + 19, top + 12, human ? short(bossName.toUpperCase(), 18) : short(agent.name, 18), 9.5, '#e1edf8'),
    textEl(left + 8, top + 23, human ? 'HUMAN / COMMAND' : short(agent.title, 23), 6.8, '#a1b4c9'),
  ]
  if (agent !== null) {
    plate.push(rectEl(left + 1, top + 28, (PLATE_WIDTH - 2) * agent.progress / 100, 1.3, statusInfo.color))
  }

  return el('g', { className: 'office-label', 'data-station': agent === null ? 'boss' : agent.id }, ...plate)
}

/**
 * Every nameplate in one layer painted after the scenery, reporting lines, and
 * station bodies, so nothing occludes a label. The layer keeps the stations'
 * back-to-front order for the same reason.
 * @param props - the label targets in draw order, the owner's name, and the label toggle.
 * @returns the label layer.
 */
function LabelLayer(props: { readonly labels: readonly LabelSlot[]; readonly showLabels: boolean; readonly bossName: string }): El {
  return el('g', { className: 'office-labels', display: props.showLabels ? 'inline' : 'none', 'aria-hidden': 'true' },
    ...props.labels.map(label => <Nameplate agent={label.agent} slot={label.slot} bossName={props.bossName} />),
  )
}

// --------------------------------------------------------------------- panel

/** Props delivered by the office panel. */
export interface OfficeSceneProps {
  readonly state: OfficeSceneState
  readonly zoom: number
  readonly pan: { readonly x: number; readonly y: number }
  readonly showLabels: boolean
  readonly showLinks: boolean
  readonly selectedId: string | null
  readonly statusLabel: (status: string) => string
  readonly onSelect: (id: string) => void
  readonly onPan: (pan: { x: number; y: number }) => void
}

interface DragState {
  readonly pointerId: number
  readonly start: { x: number; y: number }
  readonly initial: { x: number; y: number }
  moved: boolean
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value))

/**
 * The office viewport: every teammate's station, the command desk, and the
 * scenery around them, in the reference's isometric projection. Drag pans the
 * camera; stations are selection targets.
 * @param props - snapshot, camera, toggles, and selection callbacks.
 * @returns the scene SVG.
 */
export function OfficeScene(props: OfficeSceneProps): El {
  const { state, zoom, pan, showLabels, showLinks, selectedId, statusLabel, onSelect, onPan } = props
  const svgRef = React.useRef<SVGSVGElement>(null)
  const dragRef = React.useRef<DragState | null>(null)
  const suppressClick = React.useRef(false)
  const [dragging, setDragging] = React.useState(false)

  const layout = React.useMemo(() => calculateLayout(state.agents.map(agent => agent.id)), [state.agents])

  const worldWidth = (layout.width + layout.depth) * U * COS
  const worldHeight = (layout.width + layout.depth) * U * 0.5 + WALL_HEIGHT * U + 34
  const worldScale = Math.min(1290 / worldWidth, 720 / worldHeight)
  const ox = (VIEW_WIDTH - worldWidth * worldScale) / 2 + layout.depth * U * COS * worldScale
  const oy = (VIEW_HEIGHT - worldHeight * worldScale) / 2 + WALL_HEIGHT * U * worldScale

  /** Pointer position in viewBox units; null when the SVG has no layout box. */
  const viewPoint = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const ctm = svgRef.current?.getScreenCTM()
    if (ctm === null || ctm === undefined) return null
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }

  const stationOf = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null
    const node = target.closest('[data-station]')
    return node instanceof Element ? node.getAttribute('data-station') : null
  }

  // One depth-sorted station list feeds both the bodies and the label layer, so
  // the plates keep exactly the draw order the desks have.
  const stations: LabelSlot[] = [
    {
      depth: layout.boss.x + layout.boss.y + 4,
      agent: null,
      slot: { id: 'boss', x: layout.boss.x, y: layout.boss.y, wing: 'Left wing', row: 0, depth: layout.boss.x + layout.boss.y + 4 },
    },
  ]
  const agentOf = new Map(state.agents.map(agent => [agent.id, agent]))
  for (const slot of stationSlots(state.agents.map(agent => agent.id))) {
    const agent = agentOf.get(slot.id)
    if (agent === undefined) continue
    stations.push({ depth: slot.depth, agent, slot })
  }
  stations.sort((a, b) => a.depth - b.depth)

  const objects: { depth: number; node: React.ReactNode }[] = [
    { depth: 7, node: <Meeting /> },
    { depth: layout.width - 2, node: <Servers layout={layout} /> },
    { depth: layout.depth + 4, node: <Lounge layout={layout} /> },
    { depth: layout.width + layout.depth - 5, node: <Coffee layout={layout} /> },
    ...stations.map(station => ({
      depth: station.depth,
      node: <Station agent={station.agent} position={station.slot} bossName={state.boss.name} selected={selectedId === (station.agent === null ? 'boss' : station.agent.id)} statusLabel={statusLabel} />,
    })),
  ]
  objects.sort((a, b) => a.depth - b.depth)

  const scene = (
    <svg
      ref={svgRef}
      className={`office-svg${dragging ? ' office-dragging' : ''}`}
      viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(VIEW_HEIGHT)}`}
      role="group"
      aria-label="Isometric office. Select a station to open the teammate details."
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const start = viewPoint(event)
        if (start === null) return
        dragRef.current = { pointerId: event.pointerId, start, initial: pan, moved: false }
        if (stationOf(event.target) === null) event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        const current = viewPoint(event)
        if (current === null) return
        const dx = current.x - drag.start.x
        const dy = current.y - drag.start.y
        if (Math.hypot(dx, dy) > 6) {
          drag.moved = true
          setDragging(true)
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
        }
        if (drag.moved) onPan({ x: clamp(drag.initial.x + dx, PAN_LIMIT.x), y: clamp(drag.initial.y + dy, PAN_LIMIT.y) })
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current
        if (drag === null || drag.pointerId !== event.pointerId) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        // A drag must not also select the station it started on.
        suppressClick.current = drag.moved
        dragRef.current = null
        setDragging(false)
        window.setTimeout(() => { suppressClick.current = false }, 0)
      }}
      onPointerCancel={() => {
        dragRef.current = null
        setDragging(false)
      }}
      onClick={(event) => {
        if (suppressClick.current) return
        const id = stationOf(event.target)
        if (id !== null) onSelect(id)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        const id = stationOf(event.target)
        if (id === null) return
        event.preventDefault()
        onSelect(id)
      }}
    >
      <title>ASELDEV AI headquarters</title>
      <desc>{`${String(state.agents.length)} AI teammates report through their managers to ${state.boss.name}, the human owner.`}</desc>
      <Defs />
      <g transform={`translate(${String(720 + pan.x)} ${String(405 + pan.y)}) scale(${String(zoom)}) translate(-720 -405)`}>
        <g transform={`translate(${String(ox)} ${String(oy)}) scale(${String(worldScale)})`}>
          <Floor layout={layout} />
          <Walls layout={layout} />
          <Brand layout={layout} agents={state.agents} />
          {showLinks ? <Connections layout={layout} agents={state.agents} /> : null}
          {objects.map((object, index) => (
            <React.Fragment key={index}>{object.node}</React.Fragment>
          ))}
          {/* Last, so no desk, chair, or sprite can cover a nameplate. */}
          <LabelLayer labels={stations} showLabels={showLabels} bossName={state.boss.name} />
        </g>
      </g>
    </svg>
  )

  return scene
}
