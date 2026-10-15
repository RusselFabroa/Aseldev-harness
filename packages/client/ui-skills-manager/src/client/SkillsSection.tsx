/**
 * Settings → Skills: the skills folder setting on top, the skills in that
 * folder on the left, the selected skill's SKILL.md in an editor on the right. Create, save, revert,
 * and delete (moves the folder to .trash) all go through the injected
 * skills-manager calls; the page re-lists after every write.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconPlusOutline16, IconRefreshOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillDetail, SkillsApi, SkillsFolder, SkillSummary } from './api.ts'
import type { en } from './locales.ts'
import css from './SkillsSection.module.css'

/** Injected dependencies of {@link SkillsSection} (slot `inject`). */
export interface SkillsSectionInjected {
  /** Skills-manager calls. */
  api: SkillsApi
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet: the inject face spread flat. */
export type SkillsSectionProps = Partial<SkillsSectionInjected>

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Message text for a rejected call. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Starter SKILL.md for a new skill. */
function template(name: string, description: string): string {
  const title = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${title}\n\n1. First step.\n2. Second step.\n`
}

/**
 * Render the Skills settings section.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null until the shell has injected.
 */
export function SkillsSection(props: SkillsSectionProps): ReactNode {
  const { api, t } = props
  if (api === undefined || t === undefined) return null
  return <Loaded api={api} t={t} />
}

function Loaded({ api, t }: SkillsSectionInjected): ReactNode {
  const [folder, setFolder] = useState<SkillsFolder | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [folderNotice, setFolderNotice] = useState<string | null>(null)
  const [skills, setSkills] = useState<readonly SkillSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await api.list()
      setSkills(result.skills)
      setListError(null)
    } catch (error) {
      setListError(messageOf(error))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let live = true
    void api.folder().then((loaded) => {
      if (!live) return
      setFolder(loaded)
      setFolderDraft(loaded.path)
    }).catch((error: unknown) => {
      if (live) setFolderError(messageOf(error))
    })
    return () => { live = false }
  }, [api])

  const changeFolder = (path: string): void => {
    setFolderBusy(true)
    setFolderError(null)
    setFolderNotice(null)
    void api.setFolder(path).then(async (next) => {
      setFolder(next)
      setFolderDraft(next.path)
      setFolderNotice(t('folderSaved'))
      setSelected(null)
      setDetail(null)
      setSkills(null)
      await load()
    }).catch((error: unknown) => {
      setFolderError(messageOf(error))
    }).finally(() => {
      setFolderBusy(false)
    })
  }

  const open = async (name: string): Promise<void> => {
    setSelected(name)
    setFailure(null)
    setNotice(null)
    setDetail(null)
    try {
      const loaded = await api.read(name)
      setDetail(loaded)
      setDraft(loaded.content)
    } catch (error) {
      setFailure(messageOf(error))
    }
  }

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setFailure(null)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (detail === null) return
    void run(async () => {
      await api.save(detail.name, draft)
      setDetail({ ...detail, content: draft.endsWith('\n') ? draft : `${draft}\n` })
      setNotice(t('saved'))
      await load()
    })
  }

  const create = (): void => {
    const name = newName.trim()
    void run(async () => {
      await api.create(name, template(name, t('templateDescription')))
      setCreating(false)
      setNewName('')
      await load()
      await open(name)
    })
  }

  const remove = (): void => {
    if (detail === null) return
    void run(async () => {
      await api.remove(detail.name)
      setConfirmDelete(false)
      setSelected(null)
      setDetail(null)
      await load()
    })
  }

  const dirty = detail !== null && draft !== detail.content
  const folderDirty = folder !== null && folderDraft.trim() !== folder.path
  const nameValid = NAME.test(newName.trim())

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>

      <div className={css.folderBox}>
        <label className={css.folderField}>
          <span className={css.fieldLabel}>{t('folderLabel')}</span>
          <input
            className={css.input}
            type="text"
            value={folderDraft}
            spellCheck={false}
            disabled={folder === null || !folder.configurable || folderBusy}
            onChange={(event) => { setFolderDraft(event.target.value); setFolderNotice(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter' && folderDirty && !folderBusy) changeFolder(folderDraft) }}
          />
        </label>
        <div className={css.folderActions}>
          <button type="button" className={css.primary} disabled={!folderDirty || folderBusy} onClick={() => { changeFolder(folderDraft) }}>
            {t('folderSave')}
          </button>
          <button
            type="button"
            className={css.secondary}
            disabled={folder === null || !folder.overridden || !folder.configurable || folderBusy}
            onClick={() => { changeFolder('') }}
          >
            {t('folderReset')}
          </button>
          {folderNotice !== null && !folderDirty && <span className={css.notice} role="status">{folderNotice}</span>}
        </div>
        {folder !== null && (
          <span className={css.folderHint}>
            {folder.configurable ? t('folderHint') : t('folderLocked')}
            {' '}
            {t('folderDefault').replace('{path}', () => folder.defaultPath)}
          </span>
        )}
        {folderError !== null && <p className={css.error}>{folderError}</p>}
      </div>

      <div className={css.toolbar}>
        {creating
          ? (
            <div className={css.createRow}>
              <label className={css.createLabel}>
                <span className={css.fieldLabel}>{t('newName')}</span>
                <input
                  className={css.input}
                  type="text"
                  value={newName}
                  placeholder={t('newNamePlaceholder')}
                  autoFocus
                  spellCheck={false}
                  onChange={(event) => { setNewName(event.target.value) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' && nameValid && !busy) create() }}
                />
              </label>
              <button type="button" className={css.primary} disabled={!nameValid || busy} onClick={create}>{t('create')}</button>
              <button type="button" className={css.secondary} disabled={busy} onClick={() => { setCreating(false); setNewName('') }}>{t('cancel')}</button>
            </div>
          )
          : (
            <>
              <button type="button" className={css.secondary} onClick={() => { setCreating(true) }}>
                <IconPlusOutline16 size={14} />
                {t('newSkill')}
              </button>
              <button type="button" className={css.secondary} onClick={() => { void load() }}>
                <IconRefreshOutline16 size={14} />
                {t('reload')}
              </button>
            </>
          )}
      </div>

      {listError !== null && <p className={css.error}>{`${t('loadFailed')} (${listError})`}</p>}

      <div className={css.body}>
        <ul className={css.list} aria-label={t('title')}>
          {skills === null && listError === null && <li className={css.status}>{t('loading')}</li>}
          {skills !== null && skills.length === 0 && <li className={css.status}>{t('empty')}</li>}
          {skills?.map(skill => (
            <li key={skill.name}>
              <button
                type="button"
                className={clsx(css.item, selected === skill.name && css.itemSelected)}
                aria-current={selected === skill.name ? 'true' : undefined}
                onClick={() => { void open(skill.name) }}
              >
                <span className={css.itemName}>{skill.name}</span>
                <span className={css.badges}>
                  {skill.userInvocable && <span className={css.badge}>{t('badgeCommand')}</span>}
                  {!skill.modelInvocable && <span className={css.badge}>{t('badgeCommandOnly')}</span>}
                  {!skill.userInvocable && <span className={css.badge}>{t('badgeAgentOnly')}</span>}
                </span>
                {skill.description !== '' && <span className={css.itemDescription}>{skill.description}</span>}
                {!skill.hasSkillFile && <span className={css.warning}>{t('warnNoFile')}</span>}
                {skill.hasSkillFile && !skill.nameMatches && <span className={css.warning}>{t('warnName')}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className={css.editor}>
          {selected === null
            ? <p className={css.placeholder}>{t('pick')}</p>
            : (
              <>
                <div className={css.editorHeader}>
                  <span className={css.editorName}>{selected}</span>
                  {dirty && <span className={css.unsaved}>{t('unsaved')}</span>}
                  {notice !== null && !dirty && <span className={css.notice} role="status">{notice}</span>}
                </div>
                {detail !== null && detail.files.length > 0 && (
                  <p className={css.files}>{`${t('files')}: ${detail.files.join(', ')}`}</p>
                )}
                <textarea
                  className={css.textarea}
                  value={draft}
                  spellCheck={false}
                  disabled={detail === null || busy}
                  aria-label={`${selected}/SKILL.md`}
                  onChange={(event) => { setDraft(event.target.value) }}
                />
                {failure !== null && <p className={css.error}>{failure}</p>}
                <div className={css.actions}>
                  <button type="button" className={css.danger} disabled={detail === null || busy} onClick={() => { setConfirmDelete(true) }}>
                    {t('delete')}
                  </button>
                  <span className={css.spacer} />
                  <button type="button" className={css.secondary} disabled={!dirty || busy} onClick={() => { if (detail !== null) setDraft(detail.content) }}>
                    {t('revert')}
                  </button>
                  <button type="button" className={css.primary} disabled={!dirty || busy} onClick={save}>
                    {busy ? t('saving') : t('save')}
                  </button>
                </div>
              </>
            )}
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => { if (!busy) setConfirmDelete(false) }}
        title={t('deleteTitle').replace('{name}', () => selected ?? '')}
        closeLabel={t('close')}
        description={t('deleteBody')}
        footer={(
          <div className={css.modalActions}>
            <button type="button" className={css.secondary} disabled={busy} onClick={() => { setConfirmDelete(false) }}>{t('cancel')}</button>
            <button type="button" className={css.danger} disabled={busy} onClick={remove}>
              {t('deleteConfirm').replace('{name}', () => selected ?? '')}
            </button>
          </div>
        )}
      />
    </div>
  )
}
