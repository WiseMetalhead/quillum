import {
  Children,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ChangeEventHandler,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import './CustomSelect.css'

type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement>

export type CustomSelectProps = Omit<NativeSelectProps, 'multiple' | 'size'> & {
  children: ReactNode
  onChange?: ChangeEventHandler<HTMLSelectElement>
}

type SelectOption = {
  key: string
  value: string
  label: ReactNode
  text: string
  disabled: boolean
}

type MenuPosition = {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
  placement: 'above' | 'below'
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

function collectOptions(children: ReactNode, result: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    if (child.type === 'option') {
      const option = child as ReactElement<{
        children?: ReactNode
        disabled?: boolean
        value?: string | number
      }>
      const label = option.props.children
      const value = option.props.value === undefined ? nodeText(label) : String(option.props.value)
      result.push({
        key: option.key === null ? `${value}-${result.length}` : String(option.key),
        value,
        label,
        text: nodeText(label),
        disabled: Boolean(option.props.disabled),
      })
      return
    }
    const nested = child as ReactElement<{ children?: ReactNode }>
    if (nested.props.children) collectOptions(nested.props.children, result)
  })
  return result
}

export const CustomSelect = forwardRef<HTMLButtonElement, CustomSelectProps>(function CustomSelect(
  {
    children,
    className = '',
    disabled = false,
    id,
    name,
    onBlur,
    onChange,
    onFocus,
    onInvalid,
    required,
    tabIndex,
    value,
    defaultValue,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    ...nativeProps
  },
  forwardedRef,
) {
  const generatedId = useId()
  const listboxId = `${generatedId}-listbox`
  const nativeId = id ?? `${generatedId}-native`
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const nativeRef = useRef<HTMLSelectElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const options = useMemo(() => collectOptions(children), [children])
  const selectedValue = String(value ?? defaultValue ?? '')
  const selectedIndex = options.findIndex((option) => option.value === selectedValue)
  const selectedOption = options[selectedIndex] ?? options.find((option) => !option.disabled)

  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])

  const positionMenu = useCallback(() => {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const viewportPadding = 10
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding
    const availableAbove = rect.top - viewportPadding
    const opensAbove = availableBelow < 180 && availableAbove > availableBelow
    const placementSpace = opensAbove ? availableAbove : availableBelow
    const maxHeight = Math.max(40, Math.min(320, placementSpace - 6))
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - viewportPadding * 2)
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    )
    setMenuPosition({
      left,
      top: opensAbove ? undefined : rect.bottom + 6,
      bottom: opensAbove ? window.innerHeight - rect.top + 6 : undefined,
      width,
      maxHeight,
      placement: opensAbove ? 'above' : 'below',
    })
  }, [])

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false)
    setMenuPosition(null)
    if (restoreFocus) window.requestAnimationFrame(() => buttonRef.current?.focus())
  }, [])

  const openMenu = useCallback((preferredIndex?: number) => {
    if (disabled || options.length === 0) return
    const fallbackIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled)
    setActiveIndex(preferredIndex ?? fallbackIndex)
    setOpen(true)
    positionMenu()
  }, [disabled, options, positionMenu, selectedIndex])

  const selectValue = useCallback((nextValue: string) => {
    const nativeSelect = nativeRef.current
    if (!nativeSelect || disabled) return
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )?.set
    valueSetter?.call(nativeSelect, nextValue)
    nativeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    closeMenu(true)
  }, [closeMenu, disabled])

  const findEnabled = useCallback((start: number, direction: 1 | -1) => {
    if (options.length === 0) return -1
    let index = start
    for (let count = 0; count < options.length; count += 1) {
      index = (index + direction + options.length) % options.length
      if (!options[index].disabled) return index
    }
    return -1
  }, [options])

  const runTypeahead = useCallback((key: string) => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
    typeaheadRef.current += key.toLocaleLowerCase()
    const query = typeaheadRef.current
    const matchIndex = options.findIndex(
      (option) => !option.disabled && option.text.toLocaleLowerCase().startsWith(query),
    )
    if (matchIndex >= 0) {
      if (open) setActiveIndex(matchIndex)
      else selectValue(options[matchIndex].value)
    }
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadRef.current = ''
      typeaheadTimerRef.current = null
    }, 650)
  }, [open, options, selectValue])

  function handleButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      openMenu(findEnabled(selectedIndex, direction))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openMenu()
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      runTypeahead(event.key)
    }
  }

  useEffect(() => {
    if (!open) return
    positionMenu()

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) closeMenu()
    }

    function handleViewportChange() {
      positionMenu()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((current) => findEnabled(current, event.key === 'ArrowDown' ? 1 : -1))
      } else if (event.key === 'Home') {
        event.preventDefault()
        setActiveIndex(options.findIndex((option) => !option.disabled))
      } else if (event.key === 'End') {
        event.preventDefault()
        setActiveIndex(options.findLastIndex((option) => !option.disabled))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const option = options[activeIndex]
        if (option && !option.disabled) selectValue(option.value)
      } else if (event.key === 'Tab') {
        closeMenu()
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        runTypeahead(event.key)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [activeIndex, closeMenu, findEnabled, open, options, positionMenu, runTypeahead, selectValue])

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
  }, [])

  useEffect(() => {
    if (!open) return
    const activeOption = menuRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    )
    activeOption?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  return (
    <span className={`customSelect ${open ? 'open' : ''} ${className}`.trim()}>
      <select
        {...nativeProps}
        className="customSelectNative"
        disabled={disabled}
        id={nativeId}
        name={name}
        onBlur={onBlur}
        onChange={onChange}
        onFocus={(event) => {
          buttonRef.current?.focus()
          onFocus?.(event)
        }}
        onInvalid={(event) => {
          event.preventDefault()
          buttonRef.current?.focus()
          openMenu()
          onInvalid?.(event)
        }}
        ref={nativeRef}
        required={required}
        tabIndex={-1}
        value={value}
        defaultValue={value === undefined ? defaultValue : undefined}
        aria-hidden="true"
      >
        {children}
      </select>
      <button
        type="button"
        className="customSelectButton spaceButton"
        disabled={disabled}
        ref={setButtonRef}
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={required || undefined}
        tabIndex={tabIndex}
        onClick={() => {
          if (open) closeMenu()
          else openMenu()
        }}
        onKeyDown={handleButtonKeyDown}
      >
        <span className="customSelectValue">{selectedOption?.label}</span>
        <Icon name={open ? 'arrow-up-2' : 'arrow-down-2'} />
      </button>
      {open && menuPosition && createPortal(
        <div
          className="customSelectMenu"
          data-placement={menuPosition.placement}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          ref={menuRef}
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            bottom: menuPosition.bottom,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
          }}
        >
          {options.map((option, index) => (
            <button
              type="button"
              className={`customSelectOption spaceButton ${index === activeIndex ? 'active' : ''} ${option.value === selectedValue ? 'selected' : ''}`.trim()}
              role="option"
              aria-selected={option.value === selectedValue}
              disabled={option.disabled}
              data-option-index={index}
              key={option.key}
              tabIndex={-1}
              onPointerMove={() => {
                if (!option.disabled) setActiveIndex(index)
              }}
              onClick={() => selectValue(option.value)}
            >
              <span>{option.label}</span>
              {option.value === selectedValue && <Icon name="check-circle-1-light" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
})
