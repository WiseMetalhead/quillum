import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { ActionDialog } from '../shared/ActionDialog'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { PrivateImage } from '../shared/PrivateImage'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { GlossaryArticleMediaGallery } from './GlossaryArticleMediaGallery'
import type {
  GlossaryArticle,
  GlossaryArticleAlias,
  GlossaryArticleSummary,
  GlossaryCategory,
} from './GlossaryTypes'
import './GlossaryArticleSidebar.css'

type Props = {
  article: GlossaryArticle
  manuscriptId: string
  categories: GlossaryCategory[]
  categoryLabel: (category: GlossaryCategory) => string
  onArticleChange: (article: GlossaryArticle) => void
  onOpenArticle: (articleId: string) => void
  onError: (error: string) => void
}

type SectionKey = 'aliases' | 'links'

type AccordionProps = {
  sectionKey: SectionKey
  icon: 'users-group-two-rounded-light' | 'link-minimalistic-light'
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}

function SidebarAccordion({ sectionKey, icon, title, count, open, onToggle, children }: AccordionProps) {
  const panelId = useId()
  return (
    <section className={`glossaryDetailsSection glossaryDetailsSection-${sectionKey}`}>
      <button type="button" className="glossaryDetailsSectionToggle spaceButton" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <Icon name={icon} />
        <span>{title}</span>
        <small>{count}</small>
        <Icon name={open ? 'arrow-up-2' : 'arrow-down-2'} />
      </button>
      {open && <div id={panelId} className="glossaryDetailsSectionBody">{children}</div>}
    </section>
  )
}

type AliasDialogProps = {
  alias: GlossaryArticleAlias | null
  initialFocusRef: RefObject<HTMLInputElement | null>
  name: string
  busy: boolean
  online: boolean
  onNameChange: (name: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>, close: () => void) => void
  onClose: () => void
}

type AliasFormProps = Omit<AliasDialogProps, 'alias' | 'onClose'> & {
  close: () => void
  mobile?: boolean
  closing?: boolean
}

function AliasForm({ initialFocusRef, name, busy, online, onNameChange, onSubmit, close, mobile = false, closing = false }: AliasFormProps) {
  const { t } = useTranslation()
  return (
    <form className={`glossaryAliasForm ${mobile ? 'glossaryAliasMobileForm' : ''}`.trim()} onSubmit={(event) => onSubmit(event, close)}>
      <label className="dialogField">
        <span>{t('glossary.aliasName')}</span>
        <input ref={initialFocusRef} required maxLength={240} value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <footer className="standardDialogFooter">
        <button type="button" className="dialogCancel spaceButton" disabled={busy || closing} onClick={close}>{t('common.cancel')}</button>
        <button type="submit" className="dialogSubmit spaceButton" disabled={busy || closing || !online || !name.trim()}>{t(busy ? 'common.saving' : 'common.save')}</button>
      </footer>
    </form>
  )
}

function DesktopAliasDialog({ alias, initialFocusRef, name, busy, online, onNameChange, onSubmit, onClose }: AliasDialogProps) {
  const { t } = useTranslation()
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose, initialFocusRef })

  useEffect(() => {
    const previousFocus = previousFocusRef.current
    return () => previousFocus?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    function trapDialogKeyboard(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy && !closing) {
        event.preventDefault()
        event.stopImmediatePropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = document.querySelector<HTMLElement>('.glossaryAliasDialog')
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ))
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable.at(-1) ?? first
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', trapDialogKeyboard, true)
    return () => document.removeEventListener('keydown', trapDialogKeyboard, true)
  }, [busy, close, closing])

  return (
    <ActionDialog
      variant="structured"
      title={t(alias ? 'glossary.editAlias' : 'glossary.addAlias')}
      description={t('glossary.aliasDialogLead')}
      closeLabel={t('common.close')}
      busy={busy || closing}
      className="glossaryAliasDialog"
      backdropClassName={`glossaryAliasBackdrop ${backdropStateClass}`}
      onClose={close}
    >
      <AliasForm initialFocusRef={initialFocusRef} name={name} busy={busy} online={online} onNameChange={onNameChange} onSubmit={onSubmit} close={close} closing={closing} />
    </ActionDialog>
  )
}

function MobileAliasDialog({ alias, initialFocusRef, name, busy, online, onNameChange, onSubmit, onClose }: AliasDialogProps) {
  const { t } = useTranslation()
  return (
    <MobileSettingsSheet title={t(alias ? 'glossary.editAlias' : 'glossary.addAlias')} busy={busy} onClose={onClose}>
      {(close) => <AliasForm mobile initialFocusRef={initialFocusRef} name={name} busy={busy} online={online} onNameChange={onNameChange} onSubmit={onSubmit} close={close} />}
    </MobileSettingsSheet>
  )
}

function AliasDialog(props: AliasDialogProps) {
  const mobile = useMobileViewport()
  return mobile ? <MobileAliasDialog {...props} /> : <DesktopAliasDialog {...props} />
}

export function GlossaryArticleSidebar({
  article,
  manuscriptId,
  categories,
  categoryLabel,
  onArticleChange,
  onOpenArticle,
  onError,
}: Props) {
  const { t } = useTranslation()
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({ aliases: false, links: false })
  const [aliasDialogOpen, setAliasDialogOpen] = useState(false)
  const [editingAlias, setEditingAlias] = useState<GlossaryArticleAlias | null>(null)
  const [aliasName, setAliasName] = useState('')
  const [aliasBusyId, setAliasBusyId] = useState<string | null>(null)
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const aliasInputRef = useRef<HTMLInputElement>(null)
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const linksByCategory = useMemo(() => article.links.reduce<Map<string, GlossaryArticleSummary[]>>(
    (groups, link) => {
      const group = groups.get(link.categoryId) ?? []
      group.push(link)
      groups.set(link.categoryId, group)
      return groups
    },
    new Map(),
  ), [article.links])

  useEffect(() => {
    function updateOnlineState() {
      setOnline(navigator.onLine)
    }
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  function toggleSection(section: SectionKey) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }))
  }

  function openAliasDialog(alias: GlossaryArticleAlias | null) {
    setEditingAlias(alias)
    setAliasName(alias?.name ?? '')
    setAliasDialogOpen(true)
  }

  async function saveAlias(event: FormEvent<HTMLFormElement>, close: () => void) {
    event.preventDefault()
    if (!online || !navigator.onLine || aliasBusyId) return
    setAliasBusyId(editingAlias?.id ?? 'new')
    try {
      const endpoint = editingAlias
        ? `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/aliases/${editingAlias.id}/`
        : `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/aliases/`
      const payload = await apiRequest<{ alias: GlossaryArticleAlias }>(endpoint, {
        method: editingAlias ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: aliasName }),
      })
      const aliases = editingAlias
        ? article.aliases.map((alias) => alias.id === payload.alias.id ? payload.alias : alias)
        : [...article.aliases, payload.alias]
      onArticleChange({ ...article, aliases })
      close()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'alias_invalid')
    } finally {
      setAliasBusyId(null)
    }
  }

  async function deleteAlias(alias: GlossaryArticleAlias) {
    if (!online || !navigator.onLine || aliasBusyId) return
    setAliasBusyId(alias.id)
    try {
      await apiRequest(
        `/api/manuscripts/${manuscriptId}/glossary/articles/${article.id}/aliases/${alias.id}/`,
        { method: 'DELETE' },
      )
      onArticleChange({ ...article, aliases: article.aliases.filter((item) => item.id !== alias.id) })
    } catch (error) {
      onError(error instanceof Error ? error.message : 'alias_not_found')
    } finally {
      setAliasBusyId(null)
    }
  }

  return <>
    <section className="glossaryArticleInfoPanel">
      {article.coverUrl ? (
        <PrivateImage src={`${API_BASE}${article.coverUrl}`} alt="" decoding="async" />
      ) : (
        <div className="glossaryArticleCoverPlaceholder"><Icon name="gallery-light" /></div>
      )}
      <div className="glossaryArticleSynopsisPanel">
        <h2>{t('glossary.description')}</h2>
        <p>{article.synopsis || t('glossary.noSynopsis')}</p>
      </div>
    </section>
    <button
      type="button"
      className="glossaryMediaOpenButton spaceButton"
      disabled={article.mediaCount === 0}
      aria-label={t(article.mediaCount > 0 ? 'glossary.openMediaGallery' : 'glossary.noMedia')}
      title={t(article.mediaCount > 0 ? 'glossary.openMediaGallery' : 'glossary.noMedia')}
      onClick={() => setMediaGalleryOpen(true)}
    >
      <Icon name="gallery-light" />
      <span>{t('glossary.media')}</span>
      <small>{article.mediaCount}</small>
      <Icon name="arrow-right-2" />
    </button>
    <div className="glossaryDetailsSections">
      <SidebarAccordion sectionKey="aliases" icon="users-group-two-rounded-light" title={t('glossary.aliases')} count={article.aliases.length} open={openSections.aliases} onToggle={() => toggleSection('aliases')}>
        {!online && <p className="glossaryDetailsOfflineNotice">{t('glossary.aliasesOffline')}</p>}
        {article.aliases.length > 0 && (
          <div className="glossaryAliasList">
            {article.aliases.map((alias) => (
              <div key={alias.id} className="glossaryAliasRow">
                <button type="button" className="glossaryAliasEdit spaceButton" disabled={!online || aliasBusyId !== null} onClick={() => openAliasDialog(alias)}>{alias.name}</button>
                <button type="button" className="glossaryAliasDelete spaceButton" disabled={!online || aliasBusyId !== null} aria-label={t('glossary.deleteAlias', { name: alias.name })} onClick={() => void deleteAlias(alias)}><Icon name="trash-bin-trash-light" /></button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="glossaryAliasAddButton spaceButton" disabled={!online || aliasBusyId !== null} onClick={() => openAliasDialog(null)}><Icon name="add-square-light" />{t('common.add')}</button>
      </SidebarAccordion>

      <SidebarAccordion sectionKey="links" icon="link-minimalistic-light" title={t('glossary.linkedArticles')} count={article.links.length} open={openSections.links} onToggle={() => toggleSection('links')}>
        {linksByCategory.size === 0 ? <p className="glossaryDetailsEmpty">{t('glossary.noLinkedArticles')}</p> : Array.from(linksByCategory.entries()).map(([categoryId, links]) => {
          const category = categoryById.get(categoryId)
          return (
            <section className="glossaryDetailsLinkedGroup" key={categoryId}>
              <h3>{category ? categoryLabel(category) : t('glossary.unknownCategory')}</h3>
              {links.map((link) => (
                <button key={link.id} type="button" className="glossaryDetailsLinkedArticle spaceButton" onClick={() => onOpenArticle(link.id)}>
                  {link.thumbnailUrl ? <PrivateImage src={`${API_BASE}${link.thumbnailUrl}`} alt="" loading="lazy" decoding="async" /> : <span className="glossaryLinkedThumbnailPlaceholder"><Icon name="notebook-light" /></span>}
                  <span><strong>{link.title}</strong><small>{link.synopsis}</small></span>
                </button>
              ))}
            </section>
          )
        })}
      </SidebarAccordion>
    </div>

    {aliasDialogOpen && <AliasDialog
      alias={editingAlias}
      initialFocusRef={aliasInputRef}
      name={aliasName}
      busy={aliasBusyId !== null}
      online={online}
      onNameChange={setAliasName}
      onSubmit={saveAlias}
      onClose={() => setAliasDialogOpen(false)}
    />}
    {mediaGalleryOpen && <GlossaryArticleMediaGallery manuscriptId={manuscriptId} articleId={article.id} onClose={() => setMediaGalleryOpen(false)} />}
  </>
}
