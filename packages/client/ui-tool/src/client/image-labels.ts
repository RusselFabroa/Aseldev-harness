/** Image labels for tool results, using the conversation locale seat. */
import type { MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Resolve thumbnail and lightbox labels for durable tool-result images.
 * @param t - the conversation locale translator.
 * @returns the localized image labels.
 */
export function imageGalleryLabels(t: TranslateNS<'conversation'>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: { dialog: t('image.preview'), close: t('image.closePreview') },
  }
}
