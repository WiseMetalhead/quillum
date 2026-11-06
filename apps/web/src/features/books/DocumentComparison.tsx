import type { JSONContent } from '@tiptap/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { MobileLibraryActionSheet } from '../shared/MobileLibraryActionSheet'
import { PrivateImage } from '../shared/PrivateImage'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import type {
  ComparisonBlock,
  ComparisonMetadataChange,
  ComparisonSegment,
  DocumentComparisonResult,
} from './DocumentComparisonEngine'
import { visibleComparisonItems } from './DocumentComparisonEngine'
import './DocumentComparison.css'

export type DocumentComparisonSide = {
  content: JSONContent
  label: string
  updatedAt?: string | null
}

type DocumentComparisonProps = {
  left: DocumentComparisonSide
  right: DocumentComparisonSide
  ariaLabel: string
  mobileConflictControls?: {
    title: string
    resolving: boolean
    onChoose: (choice: 'left' | 'right') => void
    rightDisabled?: boolean
  }
  mobileVersionControls?: {
    title: string
    onBack: () => void
    backRef: RefObject<HTMLButtonElement | null>
  }
  assetUrl?: (assetId: string) => string
}

type WorkerResponse = {
  id: number
  result?: DocumentComparisonResult
  error?: string
}

type ComparisonState = {
  left: JSONContent
  right: JSONContent
  result: DocumentComparisonResult | null
  failed: boolean
}

export function DocumentComparison({
  left,
  right,
  ariaLabel,
  mobileConflictControls,
  mobileVersionControls,
  assetUrl,
}: DocumentComparisonProps) {
  const { t, i18n } = useTranslation()
  const [comparisonState, setComparisonState] = useState<ComparisonState>(() => ({
    left: left.content,
    right: right.content,
    result: null,
    failed: false,
  }))
  const [attempt, setAttempt] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(() => new Set())
  const [mobileSide, setMobileSide] = useState<'left' | 'right'>('left')
  const [activeGroup, setActiveGroup] = useState(1)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [mobileLegendOpen, setMobileLegendOpen] = useState(false)
  const [mobileChoiceOpen, setMobileChoiceOpen] = useState(false)
  const requestId = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentState = comparisonState.left === left.content && comparisonState.right === right.content
    ? comparisonState
    : null
  const result = currentState?.result ?? null
  const failed = currentState?.failed ?? false

  useEffect(() => {
    const id = requestId.current + 1
    requestId.current = id
    const worker = new Worker(new URL('./DocumentComparison.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return
      setComparisonState({
        left: left.content,
        right: right.content,
        result: event.data.result ?? null,
        failed: !event.data.result,
      })
      setShowAll(false)
      setExpandedGaps(new Set())
      setActiveGroup(1)
      worker.terminate()
    })
    worker.addEventListener('error', () => {
      if (requestId.current !== id) return
      setComparisonState({ left: left.content, right: right.content, result: null, failed: true })
      worker.terminate()
    })
    worker.postMessage({ id, left: left.content, right: right.content })
    return () => worker.terminate()
  }, [attempt, left.content, right.content])

  useEffect(() => {
    if (!mobileVersionControls || mobileActionsOpen || mobileLegendOpen) return
    function closeMobileVersionComparison(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      mobileVersionControls?.onBack()
    }
    document.addEventListener('keydown', closeMobileVersionComparison)
    return () => document.removeEventListener('keydown', closeMobileVersionComparison)
  }, [mobileActionsOpen, mobileLegendOpen, mobileVersionControls])

  const items = useMemo(
    () => result ? visibleComparisonItems(result, expandedGaps, showAll) : [],
    [expandedGaps, result, showAll],
  )

  function moveToGroup(group: number) {
    if (!result || result.groupCount === 0) return
    const next = Math.min(result.groupCount, Math.max(1, group))
    setActiveGroup(next)
    window.requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-comparison-group="${next}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  const locale = i18n.resolvedLanguage ?? 'en'
  const mobileControls = mobileConflictControls ?? mobileVersionControls
  const mobileVersionBackRef = mobileVersionControls?.backRef
  const mobileVersionOnBack = mobileVersionControls?.onBack
  const mobileSideIcons = mobileVersionControls
    ? { left: 'history-light' as const, right: 'file-document-light' as const }
    : { left: 'server-2-light' as const, right: 'database-light' as const }
  return (
    <section className={`documentComparison ${mobileConflictControls ? 'mobileConflict' : ''} ${mobileVersionControls ? 'mobileVersionComparison' : ''}`.trim()} aria-label={ariaLabel}>
      {mobileControls && (
        <header className="documentComparisonMobileHeader">
          {mobileVersionControls ? (
            <button
              ref={mobileVersionBackRef}
              type="button"
              className="documentComparisonMobileBack spaceButton"
              aria-label={t('common.back')}
              onClick={mobileVersionOnBack}
            >
              <Icon name="arrow-left-1" />
            </button>
          ) : <span aria-hidden="true" />}
          <h2>{mobileControls.title}</h2>
          <button
            type="button"
            className={`spaceButton ${mobileActionsOpen ? 'active' : ''}`}
            aria-label={t('documentComparison.comparisonOptions')}
            aria-haspopup="dialog"
            aria-expanded={mobileActionsOpen}
            onClick={() => setMobileActionsOpen(true)}
          >
            <Icon name="menu-dots-light" />
          </button>
        </header>
      )}
      <div className="documentComparisonToolbar">
        <div className="documentComparisonLegend" aria-label={t('documentComparison.legend')}>
          <span className="removed">{t('documentComparison.removed')}</span>
          <span className="added">{t('documentComparison.added')}</span>
          <span className="formatted">{t('documentComparison.formatting')}</span>
        </div>
        {result && result.groupCount > 0 && (
          <div className="documentComparisonNavigation">
            <button
              type="button"
              className="spaceButton"
              aria-label={t('documentComparison.previousChange')}
              disabled={activeGroup <= 1}
              onClick={() => moveToGroup(activeGroup - 1)}
            >
              <Icon name="arrow-left-1" />
            </button>
            <span>{t('documentComparison.changeCount', { current: activeGroup, total: result.groupCount })}</span>
            <button
              type="button"
              className="spaceButton"
              aria-label={t('documentComparison.nextChange')}
              disabled={activeGroup >= result.groupCount}
              onClick={() => moveToGroup(activeGroup + 1)}
            >
              <Icon name="arrow-right-1" />
            </button>
          </div>
        )}
        {result && result.groupCount > 0 && (
          <button
            type="button"
            className="spaceButton documentComparisonShowAll"
            onClick={() => setShowAll((value) => !value)}
          >
            {t(showAll ? 'documentComparison.collapseUnchanged' : 'documentComparison.showAll')}
          </button>
        )}
      </div>

      <div className="documentComparisonMobileTabs" role="group" aria-label={t('documentComparison.versions')}>
        <MobileSideButton side={left} locale={locale} selected={mobileSide === 'left'} onClick={() => setMobileSide('left')} />
        <MobileSideButton side={right} locale={locale} selected={mobileSide === 'right'} onClick={() => setMobileSide('right')} />
      </div>

      <div className="documentComparisonColumns" aria-hidden={failed || !result}>
        <ComparisonHeading side={left} locale={locale} active={mobileSide === 'left'} />
        <ComparisonHeading side={right} locale={locale} active={mobileSide === 'right'} />
      </div>

      <div className="documentComparisonScroll" ref={scrollRef}>
        {!result && !failed && (
          <TadpoleLoadingState className="documentComparisonState" label={t('documentComparison.loading')} />
        )}
        {failed && (
          <div className="documentComparisonState" role="alert">
            <p>{t('documentComparison.failed')}</p>
            <button
              type="button"
              className="spaceButton"
              onClick={() => {
                setComparisonState({ left: left.content, right: right.content, result: null, failed: false })
                setAttempt((value) => value + 1)
              }}
            >
              {t('documentComparison.retry')}
            </button>
          </div>
        )}
        {result && result.groupCount === 0 && (
          <div className="documentComparisonState"><p>{t('documentComparison.noChanges')}</p></div>
        )}
        {result && items.map((item) => item.kind === 'gap' ? (
          <button
            type="button"
            className="documentComparisonGap spaceButton"
            key={item.id}
            onClick={() => setExpandedGaps((current) => new Set(current).add(item.id))}
          >
            {t('documentComparison.showUnchanged', { count: item.count })}
          </button>
        ) : (
          <div
            className={`documentComparisonRow ${item.row.changed ? 'changed' : 'unchanged'}`}
            data-comparison-group={item.row.groupId ?? undefined}
            key={item.row.id}
          >
            <ComparisonCell block={item.row.left} side="left" active={mobileSide === 'left'} assetUrl={assetUrl} />
            <ComparisonCell block={item.row.right} side="right" active={mobileSide === 'right'} assetUrl={assetUrl} />
          </div>
        ))}
      </div>
      {mobileControls && (
        <div className="documentComparisonMobileToolbar" aria-label={t('documentComparison.mobileToolbar')}>
          <div className="documentComparisonMobileToolbarGroup">
            <button
              type="button"
              className={`spaceButton ${mobileSide === 'left' ? 'active' : ''}`}
              aria-label={left.label}
              aria-pressed={mobileSide === 'left'}
              onClick={() => setMobileSide('left')}
            >
              <Icon name={mobileSideIcons.left} />
            </button>
            <button
              type="button"
              className={`spaceButton ${mobileSide === 'right' ? 'active' : ''}`}
              aria-label={right.label}
              aria-pressed={mobileSide === 'right'}
              onClick={() => setMobileSide('right')}
            >
              <Icon name={mobileSideIcons.right} />
            </button>
          </div>
          <span className="documentComparisonMobileToolbarDivider" />
          <div className="documentComparisonMobileToolbarGroup changes">
            <button type="button" className="spaceButton" aria-label={t('documentComparison.previousChange')} disabled={!result || activeGroup <= 1} onClick={() => moveToGroup(activeGroup - 1)}>
              <Icon name="arrow-left-1" />
            </button>
            <span className="documentComparisonMobileCount" aria-live="polite">
              {result && result.groupCount > 0 ? `${activeGroup}/${result.groupCount}` : '0/0'}
            </span>
            <button type="button" className="spaceButton" aria-label={t('documentComparison.nextChange')} disabled={!result || activeGroup >= result.groupCount} onClick={() => moveToGroup(activeGroup + 1)}>
              <Icon name="arrow-right-1" />
            </button>
          </div>
          <span className="documentComparisonMobileToolbarDivider" />
          <div className="documentComparisonMobileToolbarGroup trailing">
            <button type="button" className="spaceButton" aria-label={t('documentComparison.legend')} aria-haspopup="dialog" aria-expanded={mobileLegendOpen} onClick={() => setMobileLegendOpen(true)}>
              <Icon name="information-circle-light" />
            </button>
            {mobileConflictControls && (
              <button type="button" className="spaceButton choose" aria-label={t('documentComparison.chooseVersion')} aria-haspopup="dialog" aria-expanded={mobileChoiceOpen} disabled={mobileConflictControls.resolving} onClick={() => setMobileChoiceOpen(true)}>
                <Icon name="check-square-light" />
              </button>
            )}
          </div>
        </div>
      )}

      {mobileControls && (
        <>
          <MobileLibraryActionSheet
            open={mobileActionsOpen}
            title={t('documentComparison.comparisonOptions')}
            dismissOnSelect
            onClose={() => setMobileActionsOpen(false)}
            actions={[{
              key: 'show-all',
              label: t(showAll ? 'documentComparison.collapseUnchanged' : 'documentComparison.showAll'),
              icon: <Icon name="documents-light" />,
              disabled: !result || result.groupCount === 0,
              onSelect: () => setShowAll((value) => !value),
            }]}
          />
          <MobileLibraryActionSheet
            open={mobileLegendOpen}
            title={t('documentComparison.legend')}
            onClose={() => setMobileLegendOpen(false)}
            actions={[]}
            topContent={(
              <div className="documentComparisonMobileLegend">
                <span className="removed">{t('documentComparison.removed')}</span>
                <span className="added">{t('documentComparison.added')}</span>
                <span className="formatted">{t('documentComparison.formatting')}</span>
              </div>
            )}
          />
          {mobileConflictControls && (
            <MobileLibraryActionSheet
              open={mobileChoiceOpen}
              title={t('documentComparison.chooseVersion')}
              dismissOnSelect
              onClose={() => setMobileChoiceOpen(false)}
              actions={[
                {
                  key: 'left',
                  label: left.label,
                  icon: <Icon name="server-2-light" />,
                  disabled: mobileConflictControls.resolving,
                  onSelect: () => mobileConflictControls.onChoose('left'),
                },
                {
                  key: 'right',
                  label: right.label,
                  icon: <Icon name="database-light" />,
                  disabled: mobileConflictControls.resolving || mobileConflictControls.rightDisabled,
                  onSelect: () => mobileConflictControls.onChoose('right'),
                },
              ]}
            />
          )}
        </>
      )}
    </section>
  )
}

function ComparisonHeading({
  side,
  locale,
  active,
}: {
  side: DocumentComparisonSide
  locale: string
  active: boolean
}) {
  return (
    <header className={active ? 'mobileActive' : ''}>
      <strong>{side.label}</strong>
      {side.updatedAt && (
        <time dateTime={side.updatedAt}>
          {formatComparisonDate(side.updatedAt, locale)}
        </time>
      )}
    </header>
  )
}

function MobileSideButton({
  side,
  locale,
  selected,
  onClick,
}: {
  side: DocumentComparisonSide
  locale: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button type="button" aria-pressed={selected} className={selected ? 'active' : ''} onClick={onClick}>
      <strong>{side.label}</strong>
      {side.updatedAt && <time dateTime={side.updatedAt}>{formatComparisonDate(side.updatedAt, locale)}</time>}
    </button>
  )
}

function ComparisonCell({
  block,
  side,
  active,
  assetUrl,
}: {
  block: ComparisonBlock | null
  side: 'left' | 'right'
  active: boolean
  assetUrl?: (assetId: string) => string
}) {
  const { t } = useTranslation()
  if (!block) {
    return <div className={`documentComparisonCell ${side} empty ${active ? 'mobileActive' : ''}`}><span>{t('documentComparison.emptyBlock')}</span></div>
  }
  const annotationChanged = block.segments.some((segment) => segment.annotationsChanged)
  const formattingChanged = block.segments.some((segment) => segment.formattingChanged)
  return (
    <div
      className={`documentComparisonCell ${side} ${active ? 'mobileActive' : ''}`}
      style={{ textAlign: block.alignment }}
    >
      {(block.metadataChanges.length > 0 || formattingChanged || annotationChanged) && (
        <div className="documentComparisonBadges">
          {block.metadataChanges.map((change) => <span key={change}>{t(metadataLabel(change))}</span>)}
          {formattingChanged && <span>{t('documentComparison.formattingChanged')}</span>}
          {annotationChanged && <span>{t('documentComparison.commentAnchorChanged')}</span>}
        </div>
      )}
      {block.type === 'sceneBreak' ? (
        <div className="documentComparisonSceneBreak" aria-label={t('documentComparison.sceneBreak')}>***</div>
      ) : block.type === 'illustration' && block.illustration ? (
        <ComparisonIllustration illustration={block.illustration} assetUrl={assetUrl} />
      ) : (
        <div className={`documentComparisonText ${block.type === 'heading' ? `heading level-${block.level}` : ''}`}>
          {block.segments.map((segment, index) => <ComparisonTextSegment segment={segment} key={`${index}-${segment.text.length}`} />)}
        </div>
      )}
    </div>
  )
}

function ComparisonTextSegment({ segment }: { segment: ComparisonSegment }) {
  let content: React.ReactNode = segment.text
  if (segment.marks.includes('strike')) content = <s>{content}</s>
  if (segment.marks.includes('italic')) content = <em>{content}</em>
  if (segment.marks.includes('bold')) content = <strong>{content}</strong>
  const classes = [
    segment.change !== 'none' ? segment.change : '',
    segment.formattingChanged ? 'formattingChanged' : '',
    segment.annotationsChanged ? 'annotationsChanged' : '',
  ].filter(Boolean).join(' ')
  return <span className={classes || undefined}>{content}</span>
}

function ComparisonIllustration({ illustration, assetUrl }: {
  illustration: NonNullable<ComparisonBlock['illustration']>
  assetUrl?: (assetId: string) => string
}) {
  const { t } = useTranslation()
  return (
    <figure className="documentComparisonIllustration">
      <div className="documentComparisonIllustrationPreview">
        <PrivateImage
          src={assetUrl?.(illustration.assetId) ?? `${API_BASE}/api/manuscripts/assets/${illustration.assetId}/large/`}
          alt={illustration.alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={(event) => { event.currentTarget.hidden = true }}
        />
        <span>{t('documentComparison.illustration')}</span>
      </div>
      {illustration.caption && <figcaption>{illustration.caption}</figcaption>}
    </figure>
  )
}

function metadataLabel(change: ComparisonMetadataChange) {
  return `documentComparison.metadata.${change}`
}

function formatComparisonDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
