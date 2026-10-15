/**
 * Browser calls to the aseldev skills-manager host plugin. Same-origin JSON
 * over `/aseldev-skills/api`; every request carries the `x-aseldev-skills`
 * header the host requires. A non-2xx answer rejects with the host's message.
 */

/** One skill row in the list. */
export interface SkillSummary {
  /** Folder name, which is also the skill's `name`. */
  name: string
  /** Frontmatter description, empty when missing. */
  description: string
  /** Whether the folder holds a SKILL.md at all. */
  hasSkillFile: boolean
  /** Whether the frontmatter `name` equals the folder name. */
  nameMatches: boolean
  /** Whether the skill shows in the `/` menu. */
  userInvocable: boolean
  /** Whether the agent may load it on its own. */
  modelInvocable: boolean
  /** Last SKILL.md change, epoch milliseconds. */
  updatedAt: number | null
}

/** One skill opened in the editor. */
export interface SkillDetail {
  name: string
  /** Full SKILL.md text. */
  content: string
  /** Every file in the skill folder, folder-relative. */
  files: string[]
}

/** Where the skills folder points. */
export interface SkillsFolder {
  /** Folder in use now. */
  path: string
  /** Folder from the profile, used when nothing else is chosen. */
  defaultPath: string
  /** Whether a folder other than the default is chosen in Settings. */
  overridden: boolean
  /** Whether this profile can save a folder choice. */
  configurable: boolean
}

/** The calls the Skills page makes. */
export interface SkillsApi {
  list(): Promise<{ root: string; skills: SkillSummary[] }>
  /** Read the folder setting. */
  folder(): Promise<SkillsFolder>
  /** Point the page and the agent at another folder; "" returns to the default. */
  setFolder(path: string): Promise<SkillsFolder>
  read(name: string): Promise<SkillDetail>
  create(name: string, content: string): Promise<void>
  save(name: string, content: string): Promise<void>
  remove(name: string): Promise<{ movedTo: string }>
}

const BASE = '/aseldev-skills/api'

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-aseldev-skills': '1',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    // A non-JSON answer (the route is not mounted) falls through to the status check below.
  }
  if (!response.ok) {
    const message = parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : `skills manager answered ${String(response.status)}`
    throw new Error(message)
  }
  return parsed as T
}

/**
 * Build the Skills page's call face.
 * @returns the skill and folder operations.
 */
export function createSkillsApi(): SkillsApi {
  return {
    list: () => call('GET', '/list'),
    folder: () => call('GET', '/config'),
    setFolder: path => call('PUT', '/config', { path }),
    read: name => call('GET', `/skill?name=${encodeURIComponent(name)}`),
    create: async (name, content) => { await call('POST', '/skill', { name, content }) },
    save: async (name, content) => { await call('PUT', '/skill', { name, content }) },
    remove: name => call('DELETE', `/skill?name=${encodeURIComponent(name)}`),
  }
}
