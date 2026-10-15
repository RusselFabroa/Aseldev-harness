/**
 * Browser calls to the aseldev artifacts host plugin. Same-origin JSON over
 * `/aseldev-artifacts/api`; every request carries the `x-aseldev-artifacts`
 * header the host requires. Pages themselves are loaded from `/view/…` into
 * a sandboxed iframe, never fetched into this document.
 */

/** Artifact content kinds the host stores. */
export type ArtifactType = 'html' | 'markdown' | 'svg' | 'mermaid'

/** One saved version. */
export interface ArtifactVersion {
  n: number
  createdAt: number
  bytes: number
}

/** One artifact's metadata (the host's meta.json). */
export interface ArtifactMeta {
  id: string
  title: string
  type: ArtifactType
  sessionId: string | null
  createdAt: number
  updatedAt: number
  versions: ArtifactVersion[]
}

/** One version opened in the viewer. */
export interface ArtifactDetail {
  meta: ArtifactMeta
  version: number
  content: string
  /** Where this version is saved on disk. */
  file: string
}

/** The calls the artifacts UI makes. */
export interface ArtifactsApi {
  list(): Promise<{ dir: string; artifacts: ArtifactMeta[] }>
  read(id: string, version?: number): Promise<ArtifactDetail>
}

const BASE = '/aseldev-artifacts'

async function call<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, { headers: { 'x-aseldev-artifacts': '1' } })
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    // A non-JSON answer (the route is not mounted) falls through to the status check below.
  }
  if (!response.ok) {
    const message = parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : `artifacts answered ${String(response.status)}`
    throw new Error(message)
  }
  return parsed as T
}

/**
 * Build the artifacts call face.
 * @returns the list and read operations.
 */
export function createArtifactsApi(): ArtifactsApi {
  return {
    list: () => call('/list'),
    read: (id, version) => call(`/artifact?id=${encodeURIComponent(id)}${version === undefined ? '' : `&v=${String(version)}`}`),
  }
}

/**
 * URL of one version's sandboxed page.
 * @param id - artifact id.
 * @param version - version number.
 * @returns the same-origin page path.
 */
export function viewUrl(id: string, version: number): string {
  return `${BASE}/view/${encodeURIComponent(id)}/v${String(version)}`
}

/**
 * URL that downloads one version's raw file.
 * @param id - artifact id.
 * @param version - version number.
 * @returns the same-origin download path.
 */
export function downloadUrl(id: string, version: number): string {
  return `${BASE}/download/${encodeURIComponent(id)}/v${String(version)}`
}
