import { Icon, type IconName } from '../../icons/Icon'

type StatusCardProps = {
  icon: IconName
  label: string
  value: string
  statusLabel: string
  tone: 'ok' | 'degraded' | 'neutral'
  details: Array<{ label: string; value: string }>
}

export function StatusCard({
  icon,
  label,
  value,
  statusLabel,
  tone,
  details,
}: StatusCardProps) {
  return (
    <article className={`adminServiceCard ${tone}`}>
      <div className="adminServiceCardTitle">
        <Icon name={icon} />
        <span>{label}</span>
      </div>
      <strong className="adminServiceCardValue">{value}</strong>
      <span className="adminServiceStatus">
        <span aria-hidden="true" />
        {statusLabel}
      </span>
      <dl className="adminServiceDetails">
        {details.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd title={detail.value}>{detail.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
