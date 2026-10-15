/**
 * The brain card's staged form over the `brain` settings namespace: one path
 * field naming the local knowledge vault.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the brain provider. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const BRAIN_NS = 'brain'

/** The section field this card edits. */
export interface BrainSettings {
  /** Absolute path of the Markdown vault; blank disables. */
  path?: string
}

/** What the brain card renders. */
export interface BrainCardState extends CardShell {
  /** The vault path. */
  path: CardFieldState
}

/** The registration-side face the brain card's slot entry injects. */
export interface BrainCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useBrainCard. */
    brainCard: SnapshotStore<BrainCardState>
  }
}

/** Bridges the `brain` scope onto the card. */
export class BrainCardController {
  private readonly form: CardForm<BrainSettings>
  private readonly store: SnapshotStore<BrainCardState>

  /** @param scope - the bound settings scope for the `brain` namespace. */
  constructor(scope: SettingsScope<BrainSettings>) {
    this.form = new CardForm(scope, [textField('path')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): BrainCardState {
    return { ...this.form.shell(), path: this.form.field('path') }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): BrainCardFace {
    return { hooks: { brainCard: this.store }, ...this.form.actions() }
  }
}
