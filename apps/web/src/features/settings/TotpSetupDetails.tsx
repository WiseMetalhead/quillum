import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { Icon } from '../../icons/Icon'

type Props = {
  provisioningUri: string
}

export function TotpSetupDetails({ provisioningUri }: Props) {
  const { t } = useTranslation()
  const [qrResult, setQrResult] = useState<{
    source: string
    url: string
    error: boolean
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const secret = useMemo(() => {
    try {
      return new URL(provisioningUri).searchParams.get('secret') ?? ''
    } catch {
      return ''
    }
  }, [provisioningUri])

  useEffect(() => {
    let active = true
    void QRCode.toDataURL(provisioningUri, {
      width: 224,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#111111',
        light: '#ffffff',
      },
    })
      .then((url) => {
        if (active) setQrResult({ source: provisioningUri, url, error: false })
      })
      .catch(() => {
        if (active) setQrResult({ source: provisioningUri, url: '', error: true })
      })
    return () => {
      active = false
    }
  }, [provisioningUri])
  const qrCodeUrl = qrResult?.source === provisioningUri ? qrResult.url : ''
  const qrError = qrResult?.source === provisioningUri && qrResult.error

  async function copySecret() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="totpSetupDetails">
      <section className="totpQrSection">
        <div>
          <strong>{t('security.scanQrCode')}</strong>
          <p>{t('security.scanQrCodeLead')}</p>
        </div>
        {qrCodeUrl && (
          <img
            src={qrCodeUrl}
            alt={t('security.totpQrCodeAlt')}
            width="224"
            height="224"
          />
        )}
        {qrError && <div className="notice error inline">{t('security.qrGenerationFailed')}</div>}
      </section>

      <section className="totpManualSection">
        <div>
          <strong>{t('security.manualSetup')}</strong>
          <p>{t('security.manualSetupLead')}</p>
        </div>
        <div className="totpSecretRow">
          <code>{secret || t('security.secretUnavailable')}</code>
          <button
            type="button"
            className="iconAction"
            disabled={!secret}
            title={t(copied ? 'security.secretCopied' : 'security.copySecret')}
            aria-label={t(copied ? 'security.secretCopied' : 'security.copySecret')}
            onClick={() => void copySecret()}
          >
            <Icon name={copied ? 'check-circle-1-light' : 'clipboard-light'} />
          </button>
        </div>
      </section>
    </div>
  )
}
