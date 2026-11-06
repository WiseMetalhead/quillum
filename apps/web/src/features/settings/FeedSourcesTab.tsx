import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiRequest } from '../../api/client'
import type {
  ContestSource,
  ContestSourcesPayload,
  NewsSource,
  NewsSourcesPayload,
  User,
} from '../../types'
import { Icon, type IconName } from '../../icons/Icon'
import { MobileSettingsSheet } from '../shared/MobileSettingsSheet'
import { TadpoleLoadingState } from '../shared/TadpoleLoadingState'
import { useMobileViewport } from '../shared/useMobileViewport'

type FeedSourcesTabProps = {
  user: User
  onUserChange: (user: User) => void
  onError: (message: string) => void
  onMessage: (message: string) => void
}

type SourceKind = 'news' | 'contests'

export function FeedSourcesTab({ user, onUserChange, onError, onMessage }: FeedSourcesTabProps) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [newsSources, setNewsSources] = useState<NewsSource[] | null>(null)
  const [contestSources, setContestSources] = useState<ContestSource[] | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [mobileKind, setMobileKind] = useState<SourceKind | null>(null)
  const [mobileSourceKey, setMobileSourceKey] = useState<string | null>(null)
  const [mobileEnabledKeys, setMobileEnabledKeys] = useState<string[]>([])

  useEffect(() => {
    let active = true
    void Promise.all([
      apiRequest<NewsSourcesPayload>('/api/news/sources/'),
      apiRequest<ContestSourcesPayload>('/api/contests/sources/'),
    ])
      .then(([newsPayload, contestPayload]) => {
        if (!active) return
        setNewsSources(newsPayload.items)
        setContestSources(contestPayload.items)
      })
      .catch((error: unknown) => {
        if (active) onError(error instanceof Error ? error.message : t('feedSources.loadFailed'))
      })
    return () => {
      active = false
    }
  }, [onError, t])

  async function toggleSource(kind: SourceKind, sourceKey: string) {
    if (!newsSources || !contestSources || savingKey) return
    const current = kind === 'news' ? newsSources : contestSources
    const next = current.map((source) => (
      source.key === sourceKey ? { ...source, enabled: !source.enabled } : source
    ))
    if (kind === 'news') setNewsSources(next)
    else setContestSources(next)
    setSavingKey(`${kind}:${sourceKey}`)

    try {
      const enabledSourceKeys = next
        .filter((source) => source.enabled)
        .map((source) => source.key)
      if (kind === 'news') {
        const payload = await apiRequest<NewsSourcesPayload>('/api/news/sources/', {
          method: 'PATCH',
          body: JSON.stringify({ enabledSourceKeys }),
        })
        setNewsSources(payload.items)
        onUserChange({
          ...user,
          newsEnabled: payload.newsEnabled,
          feedEnabled: payload.newsEnabled || user.contestsEnabled,
        })
      } else {
        const payload = await apiRequest<ContestSourcesPayload>('/api/contests/sources/', {
          method: 'PATCH',
          body: JSON.stringify({ enabledSourceKeys }),
        })
        setContestSources(payload.items)
        onUserChange({
          ...user,
          contestsEnabled: payload.contestsEnabled,
          feedEnabled: user.newsEnabled || payload.contestsEnabled,
        })
      }
      onMessage(t('feedSources.updated'))
    } catch (error) {
      if (kind === 'news') setNewsSources(current)
      else setContestSources(current)
      onError(error instanceof Error ? error.message : t('feedSources.saveFailed'))
    } finally {
      setSavingKey(null)
    }
  }

  function openMobileSource(kind: SourceKind, sourceKey: string) {
    const sources = kind === 'news' ? newsSources : contestSources
    if (!sources) return
    setMobileEnabledKeys(sources.filter((source) => source.enabled).map((source) => source.key))
    setMobileKind(kind)
    setMobileSourceKey(sourceKey)
  }

  function closeMobileSources() {
    if (savingKey) return
    setMobileKind(null)
    setMobileSourceKey(null)
    setMobileEnabledKeys([])
  }

  async function saveMobileSources(kind: SourceKind) {
    setSavingKey(`mobile:${kind}`)
    try {
      if (kind === 'news') {
        const payload = await apiRequest<NewsSourcesPayload>('/api/news/sources/', {
          method: 'PATCH',
          body: JSON.stringify({ enabledSourceKeys: mobileEnabledKeys }),
        })
        setNewsSources(payload.items)
        onUserChange({
          ...user,
          newsEnabled: payload.newsEnabled,
          feedEnabled: payload.newsEnabled || user.contestsEnabled,
        })
      } else {
        const payload = await apiRequest<ContestSourcesPayload>('/api/contests/sources/', {
          method: 'PATCH',
          body: JSON.stringify({ enabledSourceKeys: mobileEnabledKeys }),
        })
        setContestSources(payload.items)
        onUserChange({
          ...user,
          contestsEnabled: payload.contestsEnabled,
          feedEnabled: user.newsEnabled || payload.contestsEnabled,
        })
      }
      onMessage(t('feedSources.updated'))
      return true
    } catch (error) {
      onError(error instanceof Error ? error.message : t('feedSources.saveFailed'))
      return false
    } finally {
      setSavingKey(null)
    }
  }

  if (!newsSources || !contestSources) {
    return <TadpoleLoadingState className="settingsLoadingState" label={t('feedSources.loading')} />
  }

  function sourceRows(kind: SourceKind, sources: Array<NewsSource | ContestSource>) {
    return (
      <div className="feedSourcesList">
        {sources.map((source) => (
          <div className="feedSourceSettingRow" key={source.key}>
            <span className="feedSourceSettingIcon" aria-hidden="true">
              {source.key.startsWith('author_today.')
                ? <img src="/favicons/author-today.ico" alt="" />
                : null}
            </span>
            <span className="feedSourceSettingCopy">
              <strong>{source.name}</strong>
              <small>{t(`feedSources.descriptions.${source.key.replaceAll('.', '_')}`)}</small>
            </span>
            <button
              type="button"
              role="switch"
              className="securityToggle"
              aria-checked={source.enabled}
              aria-label={t('feedSources.toggle', { source: source.name, category: t(`feedSources.${kind}`) })}
              disabled={savingKey !== null}
              onClick={() => void toggleSource(kind, source.key)}
            >
              <span />
            </button>
          </div>
        ))}
      </div>
    )
  }

  function mobileSourceRow(kind: SourceKind, source: NewsSource | ContestSource) {
    return (
      <button
        type="button"
        className="accountMobileSettingRow feedMobileSourceMenuRow spaceButton"
        key={source.key}
        disabled={savingKey !== null}
        onClick={() => openMobileSource(kind, source.key)}
      >
        <span className="accountMobileSettingIcon feedMobileSourceMenuIcon" aria-hidden="true">
          {source.key.startsWith('author_today.')
            ? <img src="/favicons/author-today.ico" alt="" />
            : null}
        </span>
        <span className="accountMobileSettingCopy">
          <strong>{source.name}</strong>
          <small>{t(source.enabled ? 'common.enabled' : 'common.disabled')}</small>
        </span>
        <Icon name="arrow-right-2" />
      </button>
    )
  }

  const mobileSources = mobileKind === 'news' ? newsSources : contestSources
  const mobileSource = mobileSources.find((source) => source.key === mobileSourceKey)
  const mobileSourceEnabled = mobileSource ? mobileEnabledKeys.includes(mobileSource.key) : false
  const mobileDraftChanged = mobileSource
    ? mobileSource.enabled !== mobileSourceEnabled
    : false

  return (
    <div className="settingsStack feedSourcesSettings">
      {!isMobile && <><section className="settingsPanel feedSourcesIntro">
        <div className="authorProfileSectionHeader feedSourcesHeading">
          <Icon name="cheque-light" />
          <h2>{t('feedSources.title')}</h2>
        </div>
      </section>
      <section className="settingsPanel feedSourceGroup">
        <FeedSourceGroupHeader
          icon="cheque-light"
          title={t('feedSources.news')}
          description={t('feedSources.newsLead')}
        />
        {sourceRows('news', newsSources)}
      </section>
      <section className="settingsPanel feedSourceGroup">
        <FeedSourceGroupHeader
          icon="cup-star-light"
          title={t('feedSources.contests')}
          description={t('feedSources.contestsLead')}
        />
        {sourceRows('contests', contestSources)}
      </section>
      </>}

      {isMobile && (
        <div className="feedMobileSettingsLayout">
          <section className="authorProfileMobileSection feedMobileSection">
            <h2>{t('feedSources.news')}</h2>
            <div className="accountMobileSettingsList">
              {newsSources.map((source) => mobileSourceRow('news', source))}
            </div>
          </section>
          <section className="authorProfileMobileSection feedMobileSection">
            <h2>{t('feedSources.contests')}</h2>
            <div className="accountMobileSettingsList">
              {contestSources.map((source) => mobileSourceRow('contests', source))}
            </div>
          </section>
        </div>
      )}

      {isMobile && mobileKind && mobileSource && (
        <MobileSettingsSheet
          title={mobileSource.name}
          busy={savingKey === `mobile:${mobileKind}`}
          onClose={closeMobileSources}
        >
          {(close) => (
            <div className="feedMobileSheetLayout">
              <div className="feedMobileSourceOptions">
                <div className="feedMobileSourceToggleRow">
                  <strong>{t('common.enabled')}</strong>
                  <button
                    type="button"
                    role="switch"
                    className="securityToggle"
                    aria-checked={mobileSourceEnabled}
                    aria-label={t('feedSources.toggle', {
                      source: mobileSource.name,
                      category: t(`feedSources.${mobileKind}`),
                    })}
                    disabled={savingKey !== null}
                    onClick={() => setMobileEnabledKeys((current) => (
                      mobileSourceEnabled
                        ? current.filter((key) => key !== mobileSource.key)
                        : [...current, mobileSource.key]
                    ))}
                  >
                    <span />
                  </button>
                </div>
              </div>
              <div className="feedMobileSheetActions">
                <button type="button" className="secondary" disabled={savingKey !== null} onClick={close}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!mobileDraftChanged || savingKey !== null}
                  onClick={() => {
                    void saveMobileSources(mobileKind).then((saved) => {
                      if (saved) close()
                    })
                  }}
                >
                  {t(savingKey === `mobile:${mobileKind}` ? 'common.saving' : 'common.save')}
                </button>
              </div>
            </div>
          )}
        </MobileSettingsSheet>
      )}
    </div>
  )
}

function FeedSourceGroupHeader({ icon, title, description }: {
  icon: IconName
  title: string
  description: string
}) {
  return (
    <header className="feedSourceGroupHeader">
      <span className="feedSourceGroupIcon" aria-hidden="true"><Icon name={icon} /></span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </header>
  )
}
