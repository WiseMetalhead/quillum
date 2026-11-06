import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import type { SpellcheckPopupTarget } from './SpellcheckTypes'

type Props = {
  target: SpellcheckPopupTarget
  suggestions: string[]
  loading: boolean
  online: boolean
  onReplace: (suggestion: string) => void
  onAdd: () => void
  onManage: () => void
  onClose: () => void
  canManageDictionary?: boolean
}

export function SpellcheckPopup({
  target,
  suggestions,
  loading,
  online,
  onReplace,
  onAdd,
  onManage,
  onClose,
  canManageDictionary = true,
}: Props) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const position = useMemo(() => {
    const width = Math.min(300, window.innerWidth - 20)
    const left = Math.max(10, Math.min(target.rect.left, window.innerWidth - width - 10))
    const placeAbove = target.rect.bottom + 260 > window.innerHeight && target.rect.top > 260
    return {
      width,
      left,
      top: placeAbove ? undefined : target.rect.bottom + 6,
      bottom: placeAbove ? window.innerHeight - target.rect.top + 6 : undefined,
    }
  }, [target])

  useEffect(() => {
    const menu = menuRef.current
    menu?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    function closeOutside(event: MouseEvent) {
      if (!menu?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', closeOutside)
    return () => document.removeEventListener('mousedown', closeOutside)
  }, [onClose])

  function moveFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    if (!buttons.length) return
    event.preventDefault()
    const index = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'ArrowDown'
      ? (index + 1) % buttons.length
      : (index - 1 + buttons.length) % buttons.length
    buttons[next].focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="spellcheckPopup"
      role="menu"
      aria-label={t('spellcheck.suggestionsFor', { word: target.word })}
      style={position}
      onKeyDown={moveFocus}
    >
      <header>{target.word}</header>
      <div className="spellcheckSuggestionList">
        {loading ? (
          <span className="spellcheckPopupState">{t('spellcheck.loadingSuggestions')}</span>
        ) : suggestions.length ? suggestions.map((suggestion) => (
          <button key={suggestion} type="button" className="spellcheckSuggestionRow spaceButton" role="menuitem" onClick={() => onReplace(suggestion)}>
            {suggestion}
          </button>
        )) : (
          <span className="spellcheckPopupState">{t('spellcheck.noSuggestions')}</span>
        )}
      </div>
      {canManageDictionary && <div className="spellcheckPopupActions">
        <button type="button" className="spellcheckPopupAction spaceButton" role="menuitem" disabled={!online} title={!online ? t('spellcheck.onlineRequired') : undefined} onClick={onAdd}>
          {t('spellcheck.addToDictionary')}
        </button>
        <button type="button" className="spellcheckPopupAction spaceButton" role="menuitem" onClick={onManage}>
          {t('spellcheck.manageDictionary')}
        </button>
      </div>}
    </div>,
    document.body,
  )
}
