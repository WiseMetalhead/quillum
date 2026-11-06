import { useEffect, useId, useRef, useState } from 'react'
import { Icon, type IconName } from '../../icons/Icon'
import './MobileSectionSelector.css'

export type MobileSectionItem<T extends string> = {
  id: T
  label: string
  icon: IconName
}

type MobileSectionSelectorProps<T extends string> = {
  items: Array<MobileSectionItem<T>>
  activeId: T
  ariaLabel: string
  onSelect: (id: T) => void
}

export function MobileSectionSelector<T extends string>({
  items,
  activeId,
  ariaLabel,
  onSelect,
}: MobileSectionSelectorProps<T>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const selectorRef = useRef<HTMLElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const activeItem = items.find((item) => item.id === activeId) ?? items[0]

  useEffect(() => {
    if (!menuOpen) return

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!selectorRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  if (!activeItem) return null

  function selectSection(id: T) {
    setMenuOpen(false)
    triggerRef.current?.focus()
    onSelect(id)
  }

  return (
    <nav className="mobileSectionSelector" aria-label={ariaLabel} ref={selectorRef}>
      <button
        type="button"
        className="mobileSectionSelectorButton spaceButton"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        ref={triggerRef}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Icon name={activeItem.icon} />
        <span>{activeItem.label}</span>
        <Icon
          name="arrow-down-2"
          className={`mobileSectionSelectorChevron ${menuOpen ? 'open' : ''}`}
        />
      </button>

      <div
        className={`mobileSectionSelectorMenu ${menuOpen ? 'open' : ''}`}
        id={menuId}
        role="menu"
        inert={menuOpen ? undefined : true}
      >
        {items.map((item) => (
          <button
            type="button"
            className={`mobileSectionSelectorOption spaceButton ${activeId === item.id ? 'active' : ''}`}
            role="menuitemradio"
            aria-checked={activeId === item.id}
            key={item.id}
            onClick={() => selectSection(item.id)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
