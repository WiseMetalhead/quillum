import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import { Icon, type IconName } from '../../icons/Icon'
import type {
  AdminServicePage,
  AdminServicePagesPayload,
  ServicePageSlug,
} from '../../types'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { useMobileDialogTransition } from '../shared/useMobileDialogTransition'
import { useMobileViewport } from '../shared/useMobileViewport'
import { servicePageLabelKey } from '../service-pages/servicePages'

const MAX_MARKDOWN_BYTES = 1024 * 1024

type Props = {
  onSensitiveAction: <T>(action: () => Promise<T>) => Promise<T>
  onMessage: (message: string) => void
  onError: (message: string) => void
  onPublishedChange: () => Promise<void>
}

type CardProps = Props & {
  page: AdminServicePage
  onChange: (page: AdminServicePage) => void
  mobile?: boolean
  onBack?: () => void
}

const SERVICE_PAGE_ICONS: Record<ServicePageSlug, IconName> = {
  privacy: 'eye-light',
  terms: 'danger-square-light',
  contact: 'call-chat-rounded-light',
}

function ServicePageCard({
  page,
  onChange,
  onSensitiveAction,
  onMessage,
  onError,
  onPublishedChange,
  mobile = false,
  onBack,
}: CardProps) {
  const { t, i18n } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [markdown, setMarkdown] = useState(page.draftMarkdown)
  const [desiredPublished, setDesiredPublished] = useState(page.published)
  const [busy, setBusy] = useState<'save' | 'publish' | 'unpublish' | null>(
    null,
  )
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const {
    backdropStateClass,
    close: closeMobileEditor,
    closing: mobileEditorClosing,
    setDialogRef,
  } = useMobileDialogTransition({
    onClose: onBack ?? (() => undefined),
    focusOnDesktop: false,
  })

  const contentChanged = markdown !== page.draftMarkdown
  const canPublishChanges =
    desiredPublished &&
    page.published &&
    Boolean(markdown.trim()) &&
    (contentChanged || page.hasUnpublishedChanges)
  const publishedDate = page.publishedAt
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(page.publishedAt))
    : null

  async function saveDraft() {
    setBusy('save')
    onError('')
    try {
      const payload = await apiRequest<{ page: AdminServicePage }>(
        `/api/admin/service-pages/${page.slug}/draft/`,
        { method: 'PATCH', body: JSON.stringify({ markdown }) },
      )
      onChange(payload.page)
      if (desiredPublished && !payload.page.published && markdown.trim()) {
        await applyPublication('publish')
        return
      }
      onMessage(t('adminServicePages.draftSaved'))
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : t('adminServicePages.saveFailed'),
      )
    } finally {
      setBusy(null)
    }
  }

  async function applyPublication(action: 'publish' | 'unpublish') {
    setBusy(action)
    onError('')
    try {
      const payload = await onSensitiveAction(() =>
        apiRequest<{ page: AdminServicePage }>(
          `/api/admin/service-pages/${page.slug}/${action}/`,
          {
            method: 'POST',
            body: JSON.stringify({ markdown }),
          },
        ),
      )
      onChange(payload.page)
      setDesiredPublished(payload.page.published)
      try {
        await onPublishedChange()
      } catch {
        // The publication succeeded; the public manifest will refresh on the next bootstrap.
      }
      onMessage(
        t(
          action === 'publish'
            ? 'adminServicePages.publishedMessage'
            : 'adminServicePages.unpublishedMessage',
        ),
      )
    } catch (error) {
      setDesiredPublished(page.published)
      onError(
        error instanceof Error
          ? error.message
          : t('adminServicePages.publishFailed'),
      )
    } finally {
      setBusy(null)
    }
  }

  async function togglePublication() {
    const nextPublished = !desiredPublished
    setDesiredPublished(nextPublished)
    onError('')
    if (!nextPublished) {
      if (page.published) await applyPublication('unpublish')
      return
    }
    if (!markdown.trim()) {
      onError(t('adminServicePages.enableRequiresContent'))
      return
    }
    await applyPublication('publish')
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.md')) {
      onError(t('adminServicePages.importTypeInvalid'))
      return
    }
    if (file.size > MAX_MARKDOWN_BYTES) {
      onError(t('adminServicePages.importTooLarge'))
      return
    }
    try {
      let imported = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      )
      if (imported.startsWith('\uFEFF')) imported = imported.slice(1)
      if (imported.includes('\0')) throw new Error('binary')
      if (
        markdown.trim() &&
        imported !== markdown &&
        !window.confirm(t('adminServicePages.confirmImportReplace'))
      )
        return
      setMarkdown(imported)
      onError('')
    } catch {
      onError(t('adminServicePages.importInvalid'))
    }
  }

  const fileInput = (
    <input
      ref={fileInputRef}
      hidden
      type="file"
      accept=".md,text/markdown,text/x-markdown"
      disabled={busy !== null}
      onChange={(event) => void importFile(event)}
    />
  )

  if (mobile) {
    return (
      <div
        className={`dialogBackdrop mobileFullViewBackdrop adminServicePageMobileBackdrop ${backdropStateClass}`}
        role="presentation"
      >
        <section
          className="mobileFullView adminServicePageMobileEditor"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`service-page-mobile-title-${page.slug}`}
          ref={setDialogRef}
        >
          <header className="adminServicePageMobileHeader">
            <button
              type="button"
              className="adminServicePageMobileHeaderAction spaceButton"
              aria-label={t('common.back')}
              disabled={busy !== null || mobileEditorClosing}
              onClick={closeMobileEditor}
            >
              <Icon name="arrow-left-1" />
            </button>
            <h2 id={`service-page-mobile-title-${page.slug}`}>
              <span>{t(servicePageLabelKey(page.slug))}</span>
            </h2>
            <button
              type="button"
              className="adminServicePageMobileHeaderAction spaceButton"
              title={t('adminServicePages.actionsTitle')}
              aria-label={t('adminServicePages.actionsTitle')}
              aria-haspopup="dialog"
              aria-expanded={mobileActionsOpen}
              disabled={busy !== null || mobileEditorClosing}
              onClick={() => setMobileActionsOpen(true)}
            >
              <Icon name="menu-dots-light" />
            </button>
          </header>

          <label className="adminServicePageMobileEditorField">
            <textarea
              value={markdown}
              maxLength={MAX_MARKDOWN_BYTES}
              disabled={busy !== null}
              aria-label={t('adminServicePages.markdownLabel')}
              placeholder={t('adminServicePages.markdownPlaceholder')}
              onChange={(event) => setMarkdown(event.currentTarget.value)}
            />
          </label>

          <footer className="adminServicePageMobileActions">
            {fileInput}
            <button
              type="button"
              className="secondaryAction"
              disabled={!contentChanged || busy !== null}
              onClick={() => void saveDraft()}
            >
              <Icon name="diskette-light" />
              {busy === 'save'
                ? t('common.saving')
                : t('adminServicePages.saveDraft')}
            </button>
            <button
              type="button"
              className="secondaryAction"
              disabled={busy !== null}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="file-add-light" />
              {t('adminServicePages.importMarkdown')}
            </button>
          </footer>

          <MobileLibraryActionSheet
            open={mobileActionsOpen}
            title={t('adminServicePages.actionsTitle')}
            dismissOnSelect
            onClose={() => setMobileActionsOpen(false)}
            topContent={
              <div className="adminServicePageMobilePublicationSettings">
                <div className="adminServicePageMobileVisibility">
                <span>{t('adminServicePages.publicVisibility')}</span>
                <div className="adminServicePageSwitch">
                  <button
                      type="button"
                      role="switch"
                      aria-checked={desiredPublished}
                      aria-label={t('adminServicePages.publicVisibility')}
                      disabled={busy !== null}
                      onClick={() => void togglePublication()}
                    >
                      <span />
                    </button>
                  </div>
                </div>
                <div className="adminServicePageMobilePublicationStatus">
                  <span className={page.published ? 'published' : ''}>
                    {t(
                      page.published
                        ? 'adminServicePages.published'
                        : 'adminServicePages.unpublished',
                    )}
                  </span>
                  {page.version !== null && publishedDate && (
                    <small>
                      {t('adminServicePages.lastPublished', {
                        version: page.version,
                        date: publishedDate,
                      })}
                    </small>
                  )}
                </div>
              </div>
            }
            actions={[
              ...(canPublishChanges
                ? [
                    {
                      key: 'publish-changes',
                      label: t(
                        busy === 'publish'
                          ? 'adminServicePages.publishing'
                          : 'adminServicePages.publishChanges',
                      ),
                      icon: <Icon name="diskette-light" />,
                      disabled: busy !== null,
                      onSelect: () => void applyPublication('publish'),
                    },
                  ]
                : []),
              ...(page.published
                ? [
                    {
                      key: 'unpublish',
                      label: t(
                        busy === 'unpublish'
                          ? 'adminServicePages.unpublishing'
                          : 'adminServicePages.unpublish',
                      ),
                      icon: <Icon name="danger-square-light" />,
                      danger: true,
                      disabled: busy !== null,
                      onSelect: () => void applyPublication('unpublish'),
                    },
                  ]
                : []),
            ]}
          />
        </section>
      </div>
    )
  }

  return (
    <section className="panel adminServicePageCard">
      <header className="adminServicePageHeader">
        <div className="adminServicePageTitle">
          <Icon name={SERVICE_PAGE_ICONS[page.slug]} />
          <div>
            <h2>{t(servicePageLabelKey(page.slug))}</h2>
          </div>
        </div>
        <div className="adminServicePageSwitch">
          <span>
            {t(desiredPublished ? 'common.enabled' : 'common.disabled')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={desiredPublished}
            aria-label={t('adminServicePages.publicVisibility')}
            disabled={busy !== null}
            onClick={() => void togglePublication()}
          >
            <span />
          </button>
        </div>
      </header>

      <div className="adminServicePageStatus">
        <span className={page.published ? 'published' : ''}>
          {t(
            page.published
              ? 'adminServicePages.published'
              : 'adminServicePages.unpublished',
          )}
        </span>
        {page.version !== null && publishedDate && (
          <small>
            {t('adminServicePages.lastPublished', {
              version: page.version,
              date: publishedDate,
            })}
          </small>
        )}
      </div>

      <label className="adminServicePageEditor">
        <textarea
          rows={16}
          value={markdown}
          maxLength={MAX_MARKDOWN_BYTES}
          disabled={busy !== null}
          placeholder={t('adminServicePages.markdownPlaceholder')}
          onChange={(event) => setMarkdown(event.currentTarget.value)}
        />
        <small>{t('adminServicePages.markdownHint')}</small>
      </label>

      <div className="adminServicePageActions">
        {fileInput}
        <button
          type="button"
          className="adminCompactAction adminCompactActionSecondary spaceButton"
          disabled={busy !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="file-add-light" />
          {t('adminServicePages.importMarkdown')}
        </button>
        <span className="adminServicePageActionSpacer" />
        <button
          type="button"
          className="adminCompactAction adminCompactActionSecondary spaceButton"
          disabled={!contentChanged || busy !== null}
          onClick={() => void saveDraft()}
        >
          {busy === 'save'
            ? t('common.saving')
            : t('adminServicePages.saveDraft')}
        </button>
        {canPublishChanges && (
          <button
            type="button"
            className="adminCompactAction adminCompactActionPrimary spaceButton"
            disabled={busy !== null}
            onClick={() => void applyPublication('publish')}
          >
            {busy === 'publish'
              ? t('adminServicePages.publishing')
              : t('adminServicePages.publishChanges')}
          </button>
        )}
      </div>
    </section>
  )
}

export function ServicePagesTab({
  onSensitiveAction,
  onMessage,
  onError,
  onPublishedChange,
}: Props) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [pages, setPages] = useState<AdminServicePage[] | null>(null)
  const [mobileSlug, setMobileSlug] = useState<ServicePageSlug | null>(null)

  useEffect(() => {
    let active = true
    void apiRequest<AdminServicePagesPayload>('/api/admin/service-pages/')
      .then((payload) => {
        if (active) setPages(payload.pages)
      })
      .catch((error) => {
        if (active)
          onError(
            error instanceof Error
              ? error.message
              : t('adminServicePages.loadFailed'),
          )
      })
    return () => {
      active = false
    }
  }, [onError, t])

  function updatePage(nextPage: AdminServicePage) {
    setPages(
      (current) =>
        current?.map((page) =>
          page.slug === nextPage.slug ? nextPage : page,
        ) ?? null,
    )
  }

  if (!pages) {
    return <TadpoleLoadingState label={t('adminServicePages.loading')} />
  }

  const order: ServicePageSlug[] = ['privacy', 'terms', 'contact']

  if (isMobile) {
    const selectedPage = mobileSlug
      ? pages.find((item) => item.slug === mobileSlug)
      : null
    return (
      <>
        <nav
          className="adminServicePagesMobileMenu"
          aria-label={t('adminServicePages.title')}
        >
          {order.map((slug) => {
            const page = pages.find((item) => item.slug === slug)
            return page ? (
              <button
                key={slug}
                type="button"
                className="adminServicePageMobileRow spaceButton"
                onClick={() => setMobileSlug(slug)}
              >
                <span className="adminServicePageMobileRowIcon">
                  <Icon name={SERVICE_PAGE_ICONS[slug]} />
                </span>
                <span className="adminServicePageMobileRowCopy">
                  <strong>{t(servicePageLabelKey(slug))}</strong>
                  <small>
                    {t(
                      page.published
                        ? 'adminServicePages.published'
                        : 'adminServicePages.unpublished',
                    )}
                  </small>
                </span>
                <Icon name="arrow-right-2" />
              </button>
            ) : null
          })}
        </nav>
        {selectedPage && (
          <ServicePageCard
            page={selectedPage}
            mobile
            onBack={() => setMobileSlug(null)}
            onChange={updatePage}
            onSensitiveAction={onSensitiveAction}
            onMessage={onMessage}
            onError={onError}
            onPublishedChange={onPublishedChange}
          />
        )}
      </>
    )
  }

  return (
    <div className="adminServicePagesContent">
      {order.map((slug) => {
        const page = pages.find((item) => item.slug === slug)
        return page ? (
          <ServicePageCard
            key={slug}
            page={page}
            onChange={updatePage}
            onSensitiveAction={onSensitiveAction}
            onMessage={onMessage}
            onError={onError}
            onPublishedChange={onPublishedChange}
          />
        ) : null
      })}
    </div>
  )
}
