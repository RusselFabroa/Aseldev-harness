/** Small pure helpers shared by the card, the library and the viewer. */

import type { ArtifactType } from './api.ts'
import type { ArtifactsKey } from './locales.ts'

/** Translate function shape every component receives. */
export type Translate = (key: ArtifactsKey) => string

/** Locale key of a type's badge. */
export function typeKey(type: ArtifactType): ArtifactsKey {
  switch (type) {
    case 'html': return 'type.html'
    case 'markdown': return 'type.markdown'
    case 'svg': return 'type.svg'
    case 'mermaid': return 'type.mermaid'
  }
}

/** Whether a string names a known artifact type. */
export function isArtifactType(value: unknown): value is ArtifactType {
  return value === 'html' || value === 'markdown' || value === 'svg' || value === 'mermaid'
}

/** Fill `{name}` holes in a translated string. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** Human size: bytes, KB or MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Short relative time against now. */
export function relativeTime(at: number, now: number, t: Translate): string {
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return fill(t('time.minutes'), { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return fill(t('time.hours'), { n: hours })
  return fill(t('time.days'), { n: Math.floor(hours / 24) })
}
