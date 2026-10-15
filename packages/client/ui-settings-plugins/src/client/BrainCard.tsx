/**
 * The brain provider's card: the local knowledge-vault path.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { BrainCardFace } from './brain-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the brain card. */
export type BrainCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<BrainCardFace>

/**
 * Render the brain card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function BrainCard(props: BrainCardProps) {
  const { t } = props
  const state = props.useBrainCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="brainTitle"
      descriptionKey="brainDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-brain-path"
        label={t('brainPath')}
        hint={t('brainPathHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.path}
        onEdit={(text) => { props.edit('path', text) }}
        onReset={() => { props.resetField('path') }}
      />
    </PluginCard>
  )
}
