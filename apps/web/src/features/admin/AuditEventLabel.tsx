import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Icon } from '../../icons/Icon'
import { auditEventName } from './auditEvents'

type AuditEventLabelProps = {
  event: string
}

export function AuditEventLabel({ event }: AuditEventLabelProps) {
  const { t } = useTranslation()
  const tooltipId = useId()
  const label = auditEventName(t, event)

  return (
    <span className="adminAuditEventLabel">
      <span className="adminAuditEventName">{label}</span>
      <span
        className="adminAuditEventCodeInfo"
        tabIndex={0}
        aria-label={t('admin.showEventCode', { code: event })}
        aria-describedby={tooltipId}
      >
        <Icon name="info-square-light" />
        <span id={tooltipId} className="adminAuditEventCodeTooltip" role="tooltip">
          {event}
        </span>
      </span>
    </span>
  )
}
