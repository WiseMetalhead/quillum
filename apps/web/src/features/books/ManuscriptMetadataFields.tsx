import { useMemo, useState } from 'react'
import { CustomSelect } from '../shared/CustomSelect'
import { useTranslation } from 'react-i18next'
import { MANUSCRIPT_GENRES, MANUSCRIPT_LANGUAGES } from './ManuscriptMetadata'

type Props = {
  language: string
  genres: string[]
  onLanguageChange: (language: string) => void
  onGenresChange: (genres: string[]) => void
  disabled?: boolean
}

export function ManuscriptMetadataFields({
  language,
  genres,
  onLanguageChange,
  onGenresChange,
  disabled = false,
}: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [genresOpen, setGenresOpen] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleGenres = useMemo(
    () => MANUSCRIPT_GENRES.filter((genre) => (
      !normalizedQuery
      || t(`manuscriptMetadata.genres.${genre}`).toLocaleLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, t],
  )

  function toggleGenre(genre: string, checked: boolean) {
    if (checked) {
      if (genres.length >= 5 || genres.includes(genre)) return
      onGenresChange([...genres, genre])
      return
    }
    onGenresChange(genres.filter((candidate) => candidate !== genre))
  }

  return (
    <>
      <label className="dialogField">
        <span>{t('manuscriptMetadata.language')} <strong aria-hidden="true">*</strong></span>
        <CustomSelect value={language} required disabled={disabled} onChange={(event) => onLanguageChange(event.target.value)}>
          <option value="" disabled>{t('manuscriptMetadata.selectLanguage')}</option>
          {MANUSCRIPT_LANGUAGES.map((code) => (
            <option key={code} value={code}>{t(`manuscriptMetadata.languages.${code}`)}</option>
          ))}
        </CustomSelect>
      </label>
      <fieldset className="manuscriptGenrePicker" disabled={disabled}>
        <legend>{t('manuscriptMetadata.genresLabel')} <em>{t('manuscripts.optional')}</em></legend>
        <button
          type="button"
          className="manuscriptGenreToggle booksButton"
          aria-expanded={genresOpen}
          aria-controls="manuscript-genre-options"
          onClick={() => setGenresOpen((open) => !open)}
        >
          <span>{t('manuscriptMetadata.genreLimit', { count: genres.length })}</span>
          <span aria-hidden="true">{genresOpen ? '−' : '+'}</span>
        </button>
        {genresOpen && (
          <div className="manuscriptGenrePanel" id="manuscript-genre-options">
            <input
              type="search"
              value={query}
              placeholder={t('manuscriptMetadata.searchGenres')}
              aria-label={t('manuscriptMetadata.searchGenres')}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="manuscriptGenreOptions">
              {visibleGenres.map((genre) => (
                <label key={genre}>
                  <input
                    type="checkbox"
                    checked={genres.includes(genre)}
                    disabled={!genres.includes(genre) && genres.length >= 5}
                    onChange={(event) => toggleGenre(genre, event.target.checked)}
                  />
                  <span>{t(`manuscriptMetadata.genres.${genre}`)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </fieldset>
    </>
  )
}
