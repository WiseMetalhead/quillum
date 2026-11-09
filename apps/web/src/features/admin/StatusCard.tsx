import { Icon, type IconName } from '../../icons/Icon'

type StatusCardProps = {
  icon: IconName
  label: string
  metricLabel: string
  metricValue: string
  statusLabel: string
  openLabel: string
  tone: 'ok' | 'degraded'
  onClick: () => void
}

export function StatusCard({
  icon,
  label,
  metricLabel,
  metricValue,
  statusLabel,
  openLabel,
  tone,
  onClick,
}: StatusCardProps) {
  return (
    <button
      type="button"
      className={`adminServiceCard ${tone} spaceButton`}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <div className="adminServiceCardTitle">
        <Icon name={icon} />
        <span>{label}</span>
      </div>
      <span className="adminServiceStatus">
        <span aria-hidden="true" />
        {statusLabel}
      </span>
      <span className="adminServiceCardMetric">
        <span>{metricLabel}</span>
        <strong title={metricValue}>{metricValue}</strong>
      </span>
      <span className="srOnly">{openLabel}</span>
    </button>
  )
}
