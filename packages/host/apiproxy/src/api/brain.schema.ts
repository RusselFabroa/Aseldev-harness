/**
 * brain domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { BrainSearchMatch, BrainStatus, BrainTreeNode } from './brain.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** brain.list request payload (empty object literal). */
export const brainListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'brain.list'>>>

/** One tree node; folders nest a node array, notes are leaves. */
export const brainTreeNodeSchema: z.ZodType<Wire<BrainTreeNode>> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('folder'),
    name: z.string(),
    path: z.string(),
    children: z.array(brainTreeNodeSchema),
  }),
  z.object({
    kind: z.literal('note'),
    name: z.string(),
    path: z.string(),
  }),
]))

/** Vault status carried inside brain.list's value. */
export const brainStatusSchema = z.object({
  configured: z.boolean(),
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<BrainStatus>>

/** brain.list response value. */
export const brainListValueSchema = z.object({
  status: brainStatusSchema,
  tree: z.array(brainTreeNodeSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'brain.list'>>>

/** brain.search request payload. */
export const brainSearchRequestSchema = z.object({
  query: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'brain.search'>>>

/** brain.search response value. */
export const brainSearchValueSchema = z.object({
  items: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      snippet: z.string(),
    }) satisfies z.ZodType<Wire<BrainSearchMatch>>,
  ),
}) satisfies z.ZodType<Wire<ResponseValue<'brain.search'>>>

/** brain.read request payload; a non-empty vault-relative path. */
export const brainReadRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'brain.read'>>>

/** brain.read response value. */
export const brainReadValueSchema = z.object({
  path: z.string(),
  title: z.string(),
  content: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'brain.read'>>>
