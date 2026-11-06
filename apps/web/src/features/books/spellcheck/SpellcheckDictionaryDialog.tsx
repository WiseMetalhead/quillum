import { type FormEvent, type ReactNode, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { apiRequest } from '../../../api/client'
import { Icon } from '../../../icons/Icon'
import { ActionDialog } from '../../shared/ActionDialog'
import { useMobileDialogTransition } from '../../shared/useMobileDialogTransition'
import { useMobileViewport } from '../../shared/useMobileViewport'
import type { SpellcheckDictionary } from '../EditorPreferences'
import type { SpellcheckCustomWord, SpellcheckLexicon } from './SpellcheckTypes'

type Props = {
  manuscriptId: string
  lexicon: SpellcheckLexicon
  dictionary: SpellcheckDictionary
  online: boolean
  onChange: (lexicon: SpellcheckLexicon) => void
  onClose: () => void
  onError: (error: string) => void
}

function MobileDictionarySectionDialog({ title, busy, children, onBack }: {
  title: string
  busy: boolean
  children: ReactNode
  onBack: () => void
}) {
  const { t } = useTranslation()
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose: onBack })

  return (
    <ActionDialog
      variant="structured"
      title={title}
      closeLabel={t('common.close')}
      mobileBackLabel={t('common.back')}
      mobileBackAction={close}
      busy={busy || closing}
      className="spellcheckDictionarySectionDialog mobileFullView"
      backdropClassName={`spellcheckDictionarySectionBackdrop mobileFullViewBackdrop ${backdropStateClass}`}
      onClose={close}
    >
      {children}
    </ActionDialog>
  )
}

export function SpellcheckDictionaryDialog({
  manuscriptId,
  lexicon,
  dictionary,
  online,
  onChange,
  onClose,
  onError,
}: Props) {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const { backdropStateClass, close, closing } = useMobileDialogTransition({ onClose })
  const [query, setQuery] = useState('')
  const [word, setWord] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'overview' | 'custom-words' | 'glossary'>('overview')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const customWords = useMemo(
    () => lexicon.customWords.filter((item) => item.word.toLocaleLowerCase().includes(normalizedQuery)),
    [lexicon.customWords, normalizedQuery],
  )
  const glossaryTerms = useMemo(
    () => lexicon.glossaryTerms.filter((term) => term.toLocaleLowerCase().includes(normalizedQuery)),
    [lexicon.glossaryTerms, normalizedQuery],
  )

  async function addWord(event: FormEvent) {
    event.preventDefault()
    if (!online || !word.trim()) return
    setBusyId('add')
    try {
      const payload = await apiRequest<{ word: SpellcheckCustomWord }>(
        `/api/manuscripts/${manuscriptId}/spellcheck-lexicon/words/`,
        { method: 'POST', body: JSON.stringify({ word: word.trim() }) },
      )
      const customWords = lexicon.customWords.some((item) => item.id === payload.word.id)
        ? lexicon.customWords
        : [...lexicon.customWords, payload.word]
      onChange({ ...lexicon, revision: new Date().toISOString(), customWords })
      setWord('')
      onError('')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'spellcheck_word_add_failed')
    } finally {
      setBusyId(null)
    }
  }

  async function removeWord(item: SpellcheckCustomWord) {
    if (!online) return
    setBusyId(item.id)
    try {
      await apiRequest(`/api/manuscripts/${manuscriptId}/spellcheck-lexicon/words/${item.id}/`, { method: 'DELETE' })
      onChange({
        ...lexicon,
        revision: new Date().toISOString(),
        customWords: lexicon.customWords.filter((word) => word.id !== item.id),
      })
      onError('')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'spellcheck_word_delete_failed')
    } finally {
      setBusyId(null)
    }
  }

  return createPortal(
    <>
      <ActionDialog
        variant="structured"
        title={t('spellcheck.dictionaryTitle')}
        description={isMobile ? undefined : t(lexicon.scope.type === 'series' ? 'spellcheck.seriesScope' : 'spellcheck.manuscriptScope')}
        closeLabel={t('common.close')}
        mobileBackLabel={isMobile ? t('common.back') : undefined}
        mobileBackAction={isMobile ? close : undefined}
        busy={busyId !== null || closing}
        className={`spellcheckDictionaryDialog ${isMobile ? 'spellcheckDictionaryMobileDialog mobileFullView' : ''}`}
        backdropClassName={isMobile ? `spellcheckDictionaryMobileBackdrop mobileFullViewBackdrop ${backdropStateClass}` : ''}
        escapeAction={isMobile && mobileView !== 'overview' ? () => undefined : undefined}
        onClose={isMobile ? close : onClose}
      >
        {isMobile ? (
          <div className="spellcheckDictionaryMobileOverview">
            {!online && <p className="spellcheckOfflineNotice">{t('spellcheck.offlineReadOnly')}</p>}
            <button type="button" className="spellcheckDictionaryMobileLink spaceButton" onClick={() => setMobileView('custom-words')}>
              <span>
                <strong>{t('spellcheck.customWords')}</strong>
                <small>{lexicon.customWords.length}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
            <button type="button" className="spellcheckDictionaryMobileLink spaceButton" onClick={() => setMobileView('glossary')}>
              <span>
                <strong>{t('spellcheck.glossaryDictionary')}</strong>
                <small>{lexicon.glossaryTerms.length}</small>
              </span>
              <Icon name="arrow-right-2" />
            </button>
          </div>
        ) : (
          <div className="spellcheckDictionaryBody">
            {!online && <p className="spellcheckOfflineNotice">{t('spellcheck.offlineReadOnly')}</p>}
            <form className="spellcheckAddForm" onSubmit={(event) => void addWord(event)}>
              <label>
                <span>{t('spellcheck.newWord')}</span>
                <input value={word} maxLength={80} disabled={!online || busyId !== null} placeholder={t('spellcheck.newWordPlaceholder')} onChange={(event) => setWord(event.target.value)} />
              </label>
              <button type="submit" className="dialogSubmit spaceButton" disabled={!online || busyId !== null || !word.trim()}>
                {t(busyId === 'add' ? 'spellcheck.adding' : 'common.add')}
              </button>
            </form>
            <label className="spellcheckSearch">
              <span>{t('common.search')}</span>
              <input type="search" value={query} placeholder={t('spellcheck.searchPlaceholder')} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="spellcheckDictionaryColumns">
              <section className="spellcheckCustomWordsSection">
                <header>
                  <strong>{t('spellcheck.customWords')}</strong>
                  <span>{lexicon.customWords.length}</span>
                </header>
                {customWords.length ? (
                  <ul className="spellcheckWordList">
                    {customWords.map((item) => (
                      <li key={item.id}>
                        <span>{item.word}</span>
                        <button
                          type="button"
                          className="spellcheckWordRemove compactDialogSecondaryAction spaceButton"
                          disabled={!online || busyId !== null}
                          aria-label={t('spellcheck.removeWord', { word: item.word })}
                          onClick={() => void removeWord(item)}
                        >
                          {t(busyId === item.id ? 'spellcheck.removing' : 'common.delete')}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="spellcheckEmptyList">{t('spellcheck.noCustomWords')}</p>}
              </section>
              <section className="spellcheckGlossarySection">
                <header>
                  <strong>{t('spellcheck.glossaryTerms')}</strong>
                  <span>{lexicon.glossaryTerms.length}</span>
                </header>
                <p className="spellcheckSectionLead">
                  {t(dictionary === 'ru' ? 'spellcheck.glossaryTermsLead' : 'spellcheck.glossaryTermsExactLead')}
                </p>
                {glossaryTerms.length ? (
                  <ul className="spellcheckGlossaryTerms">
                    {glossaryTerms.map((term, index) => <li key={`${term}:${index}`}>{term}</li>)}
                  </ul>
                ) : <p className="spellcheckEmptyList">{t('spellcheck.noGlossaryTerms')}</p>}
              </section>
            </div>
          </div>
        )}
      </ActionDialog>

      {isMobile && mobileView === 'custom-words' && (
        <MobileDictionarySectionDialog
          title={t('spellcheck.customWords')}
          busy={busyId !== null}
          onBack={() => setMobileView('overview')}
        >
          <div className="spellcheckDictionaryMobileSection">
            {!online && <p className="spellcheckOfflineNotice">{t('spellcheck.offlineReadOnly')}</p>}
            <form className="spellcheckMobileAddForm" onSubmit={(event) => void addWord(event)}>
              <label>
                <span>{t('spellcheck.newWord')}</span>
                <input value={word} maxLength={80} disabled={!online || busyId !== null} placeholder={t('spellcheck.newWordPlaceholder')} onChange={(event) => setWord(event.target.value)} />
              </label>
              <button type="submit" className="dialogSubmit spaceButton" disabled={!online || busyId !== null || !word.trim()}>
                {t(busyId === 'add' ? 'spellcheck.adding' : 'common.add')}
              </button>
            </form>
            <div className="spellcheckMobileListDivider" />
            {lexicon.customWords.length ? (
              <ul className="spellcheckMobileFlatList">
                {lexicon.customWords.map((item) => (
                  <li key={item.id}>
                    <span>{item.word}</span>
                    <button
                      type="button"
                      className="spellcheckMobileRemove spaceButton"
                      disabled={!online || busyId !== null}
                      aria-label={t('spellcheck.removeWord', { word: item.word })}
                      title={t('spellcheck.removeWord', { word: item.word })}
                      onClick={() => void removeWord(item)}
                    >
                      <Icon name="trash-bin-trash-light" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="spellcheckMobileEmpty">{t('spellcheck.noCustomWords')}</p>}
          </div>
        </MobileDictionarySectionDialog>
      )}

      {isMobile && mobileView === 'glossary' && (
        <MobileDictionarySectionDialog
          title={t('spellcheck.glossaryDictionary')}
          busy={false}
          onBack={() => setMobileView('overview')}
        >
          <div className="spellcheckDictionaryMobileSection">
            <div className="spellcheckMobileListDivider" />
            {lexicon.glossaryTerms.length ? (
              <ul className="spellcheckMobileFlatList glossary">
                {lexicon.glossaryTerms.map((term, index) => <li key={`${term}:${index}`}><span>{term}</span></li>)}
              </ul>
            ) : <p className="spellcheckMobileEmpty">{t('spellcheck.noGlossaryTerms')}</p>}
          </div>
        </MobileDictionarySectionDialog>
      )}
    </>,
    document.body,
  )
}
