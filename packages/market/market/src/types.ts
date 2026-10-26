/** Payload types of the plugin-market capability seam and its `market` Remote. */

/**
 * One DSH plugin offered by the configured registry, as the index reports it.
 */
export interface MarketPluginEntry {
  /** The published package name, exactly as npm knows it. */
  readonly name: string
  /** The version the index currently offers. */
  readonly version: string
  /** The package's one-line published description, or `null` when it has none. */
  readonly description: string | null
  /** The registry's publish timestamp (ISO 8601), or `null` when it reports none. */
  readonly updatedAt: string | null
}

/** One index query. */
export interface MarketSearchRequest {
  /** Words matched against the registry's package index. */
  readonly query: string
  /** Requested number of entries; the provider clamps it to the configured bound. */
  readonly limit?: number
}

/** Installed-affecting result of one index query; never longer than the configured bound. */
export interface MarketSearchResult {
  /** Confirmed DSH plugins, in index relevance order. */
  readonly entries: readonly MarketPluginEntry[]
}

/** One install request. */
export interface MarketInstallRequest {
  /** The published package name to install. */
  readonly package: string
  /** An exact published version; the latest version when absent. */
  readonly version?: string
}

/** What one install changed. */
export interface MarketInstallResult {
  /** The installed package name. */
  readonly package: string
  /** The exact version that now sits in the profile. */
  readonly version: string
  /** Absolute directory of the profile the package was installed into. */
  readonly profileDir: string
  /** True when the plugin mounts only after the running process restarts. */
  readonly restartRequired: boolean
}
