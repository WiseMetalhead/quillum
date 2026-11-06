import { useEffect, useMemo, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { useTranslation } from 'react-i18next'
import { API_BASE, apiRequest } from '../../api/client'
import { Icon } from '../../icons/Icon'
import { PrivateImage } from '../shared/PrivateImage'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { GlossaryArticleDocument } from './GlossaryArticleDocument'
import type { GlossaryArticle, GlossaryArticleSummary, GlossaryCategory, GlossaryScope } from './GlossaryTypes'
import type { Manuscript } from './ManuscriptTypes'
import './GlossaryInspectorPanel.css'

type Props = {
  userId: number
  manuscript: Manuscript
  selectedItemId: string | null
  onError: (error: string) => void
}

export function GlossaryInspectorPanel({
  userId,
  manuscript,
  selectedItemId,
  onError,
}: Props) {
  const { t, i18n } = useTranslation()
  const [scope, setScope] = useState<GlossaryScope | null>(null)
  const [articles, setArticles] = useState<GlossaryArticleSummary[]>([])
  const [linkedIds, setLinkedIds] = useState<Set<string>>(() => new Set())
  const [segment, setSegment] = useState<'linked' | 'all'>('linked')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [activeArticle, setActiveArticle] = useState<GlossaryArticle | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    async function loadInspector() {
      const params = new URLSearchParams({ pageSize: '100', sort: 'az' })
      const associationParams = new URLSearchParams()
      if (selectedItemId) associationParams.set('documentItemId', selectedItemId)
      try {
        const [scopePayload, firstArticlePayload, associationPayload] = await Promise.all([
          apiRequest<{ glossary: GlossaryScope }>(
            `/api/manuscripts/${manuscript.id}/glossary/`,
          ),
          apiRequest<{ items: GlossaryArticleSummary[]; total: number; pageSize: number }>(
            `/api/manuscripts/${manuscript.id}/glossary/articles/?${params}`,
          ),
          apiRequest<{ articleIds: string[] }>(
            `/api/manuscripts/${manuscript.id}/glossary/associations/?${associationParams}`,
          ),
        ])
        const pageCount = Math.ceil(firstArticlePayload.total / firstArticlePayload.pageSize)
        const remaining = pageCount > 1
          ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => (
            apiRequest<{ items: GlossaryArticleSummary[] }>(
              `/api/manuscripts/${manuscript.id}/glossary/articles/?pageSize=100&sort=az&page=${index + 2}`,
            )
          )))
          : []
        if (!active) return
        setScope(scopePayload.glossary)
        setArticles([firstArticlePayload, ...remaining].flatMap((payload) => payload.items))
        setLinkedIds(new Set(associationPayload.articleIds))
      } catch (error) {
        if (active) {
          onError(error instanceof Error ? error.message : i18n.t('glossaryInspector.loadFailed'))
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadInspector()
    return () => {
      active = false
    }
  }, [i18n, manuscript.id, onError, selectedItemId])

  const categoryById = useMemo(
    () => new Map(scope?.categories.map((category) => [category.id, category]) ?? []),
    [scope],
  )

  function categoryLabel(category?: GlossaryCategory) {
    if (!category) return t('glossary.unknownCategory')
    return category.systemKey
      ? t(`glossary.systemCategories.${category.systemKey}.name`)
      : category.name
  }

  const visible = articles.filter((article) => (
    (segment === 'all' || linkedIds.has(article.id))
    && (segment !== 'all' || !categoryFilter || article.categoryId === categoryFilter)
    && (!search.trim() || article.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
      || article.synopsis.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  ))
  const groupedVisible = (scope?.categories ?? []).map((category) => ({
    category,
    articles: visible.filter((article) => article.categoryId === category.id),
  })).filter((group) => group.articles.length > 0)

  async function openArticle(articleId: string) {
    try {
      const payload = await apiRequest<{ article: GlossaryArticle }>(
        `/api/manuscripts/${manuscript.id}/glossary/articles/${articleId}/`,
      )
      setActiveArticle(payload.article)
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossary.openFailed'))
    }
  }

  async function setLinked(article: GlossaryArticleSummary, linked: boolean) {
    try {
      const body = JSON.stringify({
        articleId: article.id,
        documentItemId: selectedItemId,
      })
      await apiRequest(
        `/api/manuscripts/${manuscript.id}/glossary/associations/`,
        { method: linked ? 'POST' : 'DELETE', body },
      )
      setLinkedIds((current) => {
        const next = new Set(current)
        if (linked) next.add(article.id)
        else next.delete(article.id)
        return next
      })
    } catch (error) {
      onError(error instanceof Error ? error.message : t('glossaryInspector.updateFailed'))
    }
  }

  if (loading) {
    return <TadpoleLoadingState className="inspectorEmptyState glossaryInspectorLoading" label={t('glossaryInspector.loading')} />
  }

  if (activeArticle) {
    const headings = (activeArticle.content.content ?? [])
      .filter((node) => node.type === 'heading')
      .map((node) => ({
        level: Number(node.attrs?.level ?? 1),
        text: (node.content ?? []).map((child) => child.text ?? '').join(''),
      }))
    return (
      <div className="glossaryInspectorReader">
        <button type="button" className="glossaryInspectorBack spaceButton" onClick={() => setActiveArticle(null)}>
          <Icon name="arrow-left-1" /> {t('glossaryInspector.back')}
        </button>
        <header>
          {activeArticle.thumbnailUrl ? (
            <PrivateImage src={`${API_BASE}${activeArticle.thumbnailUrl}`} alt="" decoding="async" />
          ) : <span className="glossaryInspectorReaderPlaceholder"><Icon name="notebook-light" /></span>}
          <div>
            <h3>{activeArticle.title}</h3>
            {activeArticle.synopsis && <p>{activeArticle.synopsis}</p>}
          </div>
        </header>
        {headings.length > 0 && (
          <nav className="glossaryInspectorToc" aria-label={t('glossary.tableOfContents')}>
            <strong>{t('glossary.tableOfContents')}</strong>
            {headings.map((heading, index) => (
              <button
                key={`${heading.text}:${index}`}
                type="button"
                className="spaceButton"
                style={{ paddingLeft: `${(heading.level - 1) * 8}px` }}
                onClick={() => {
                  document.querySelectorAll('.glossaryInspectorReader .glossaryTiptap h1, .glossaryInspectorReader .glossaryTiptap h2, .glossaryInspectorReader .glossaryTiptap h3, .glossaryInspectorReader .glossaryTiptap h4, .glossaryInspectorReader .glossaryTiptap h5')[index]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                }}
              >
                {heading.text}
              </button>
            ))}
          </nav>
        )}
        <GlossaryArticleDocument
          userId={userId}
          manuscriptId={manuscript.id}
          article={activeArticle}
          articleOptions={articles}
          editable={false}
          onChange={setActiveArticle}
          onOpenArticle={(id) => void openArticle(id)}
          onError={onError}
        />
        {activeArticle.links.length > 0 && (
          <section className="glossaryInspectorOutgoing">
            <h4>{t('glossary.linkedArticles')}</h4>
            {activeArticle.links.map((article) => (
              <button key={article.id} type="button" className="spaceButton" onClick={() => void openArticle(article.id)}>
                <strong>{article.title}</strong>
                <small>{categoryLabel(categoryById.get(article.categoryId))}</small>
              </button>
            ))}
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="glossaryInspector">
      <div className="glossaryInspectorSegments" role="group" aria-label={t('glossaryInspector.scope')}>
        <button type="button" className={`spaceButton ${segment === 'linked' ? 'active' : ''}`} onClick={() => setSegment('linked')}>{t('glossaryInspector.linked')}</button>
        <button type="button" className={`spaceButton ${segment === 'all' ? 'active' : ''}`} onClick={() => setSegment('all')}>{t('glossaryInspector.all')}</button>
      </div>
      <div className="glossaryInspectorFilters">
        <label className="glossaryInspectorSearch">
          <Icon name="magnifer-outline" />
          <input value={search} placeholder={t('glossaryInspector.search')} onChange={(event) => setSearch(event.target.value)} />
        </label>
        {segment === 'all' && (
          <CustomSelect value={categoryFilter} aria-label={t('glossaryInspector.categoryFilter')} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="">{t('glossaryInspector.allCategories')}</option>
            {scope?.categories.map((category) => <option key={category.id} value={category.id}>{categoryLabel(category)}</option>)}
          </CustomSelect>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="inspectorEmptyState">
          <span>{t(segment === 'linked' ? 'glossaryInspector.noLinked' : 'glossaryInspector.noArticles')}</span>
          <p>{t(segment === 'linked' ? 'glossaryInspector.noLinkedLead' : 'glossaryInspector.noArticlesLead')}</p>
        </div>
      ) : (
        <div className="glossaryInspectorResults">
          {groupedVisible.map(({ category, articles: categoryArticles }) => (
            <section className="glossaryInspectorGroup" key={category.id}>
              <h3>{categoryLabel(category)} <span>{categoryArticles.length}</span></h3>
              <div className="glossaryInspectorCards">
                {categoryArticles.map((article) => {
                  const linked = linkedIds.has(article.id)
                  return (
                    <article key={article.id}>
                      <button type="button" className="glossaryInspectorOpen spaceButton" onClick={() => void openArticle(article.id)}>
                        {article.thumbnailUrl ? <PrivateImage src={`${API_BASE}${article.thumbnailUrl}`} alt="" loading="lazy" decoding="async" /> : <span className="glossaryInspectorThumbnailPlaceholder"><Icon name="notebook-light" /></span>}
                        <span><strong>{article.title}</strong><small>{categoryLabel(categoryById.get(article.categoryId))}</small></span>
                      </button>
                      <button type="button" className={`spaceButton ${linked ? 'linked' : ''}`} aria-label={t(linked ? 'glossaryInspector.unlink' : 'glossaryInspector.link')} onClick={() => void setLinked(article, !linked)}>
                        <Icon name={linked ? 'check-circle-1-light' : 'link-minimalistic-light'} />
                      </button>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
