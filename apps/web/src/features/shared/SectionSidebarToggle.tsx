import { Icon } from '../../icons/Icon'

type SectionSidebarToggleProps = {
  collapsed: boolean
  collapseLabel: string
  expandLabel: string
  onToggle: () => void
}

export function SectionSidebarToggle({
  collapsed,
  collapseLabel,
  expandLabel,
  onToggle,
}: SectionSidebarToggleProps) {
  const actionLabel = collapsed ? expandLabel : collapseLabel

  return (
    <button
      type="button"
      className="sectionSidebarToggle spaceButton"
      aria-label={actionLabel}
      title={actionLabel}
      onClick={onToggle}
    >
      <Icon name={collapsed ? 'arrow-right-1' : 'arrow-left-1'} />
      <span>{collapseLabel}</span>
    </button>
  )
}
