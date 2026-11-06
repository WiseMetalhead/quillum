import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { API_BASE, ApiError, apiRequest } from '../../api/client'
import { ActionDialog } from './ActionDialog'
import { MobileSettingsSheet } from './MobileSettingsSheet'
import { ReauthenticationForm } from './ReauthenticationForm'
import { useMobileViewport } from './useMobileViewport'

export function useSensitiveAction() {
  const { t } = useTranslation()
  const isMobile = useMobileViewport()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef<{
    resolve: () => void
    reject: (error: Error) => void
  } | null>(null)

  async function runSensitiveAction<T>(action: () => Promise<T>): Promise<T> {
    let reauthenticationMethod: 'password' | 'oidc' | 'passkey'
    try {
      return await action()
    } catch (actionError) {
      if (
        !(actionError instanceof ApiError) ||
        actionError.code !== 'recent_authentication_required'
      ) {
        throw actionError
      }
      reauthenticationMethod = actionError.details.reauthenticationMethod ?? 'password'
    }

    if (reauthenticationMethod === 'oidc') {
      await oidcReauthenticate()
      return action()
    }

    await new Promise<void>((resolve, reject) => {
      pending.current = { resolve, reject }
      setError('')
      setOpen(true)
    })
    return action()
  }

  function oidcReauthenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const popup = window.open(
        `${API_BASE}/api/auth/oidc/login/?reauthenticate=1`,
        'quillum-oidc-reauthentication',
        'popup,width=560,height=720',
      )
      if (!popup) {
        reject(new Error(t('sensitiveAction.popupBlocked')))
        return
      }

      let settled = false
      let closeWatcher = 0
      const cleanup = () => {
        settled = true
        window.removeEventListener('message', handleMessage)
        window.clearInterval(closeWatcher)
      }
      const handleMessage = (event: MessageEvent) => {
        if (event.source !== popup || event.data?.type !== 'quillum:oidc-reauthentication') {
          return
        }
        cleanup()
        if (event.data.ok) {
          resolve()
        } else {
          reject(new Error(t(`errors.${String(event.data.error)}`, {
            defaultValue: t('sensitiveAction.verificationFailed'),
          })))
        }
      }
      window.addEventListener('message', handleMessage)
      closeWatcher = window.setInterval(() => {
        if (!settled && popup.closed) {
          cleanup()
          reject(new Error(t('sensitiveAction.cancelled')))
        }
      }, 500)
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const password = String(new FormData(form).get('password') || '')
    setError('')
    setSubmitting(true)
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/reauthenticate/', {
        method: 'POST',
        body: JSON.stringify({ password }),
      })
      setOpen(false)
      form.reset()
      pending.current?.resolve()
      pending.current = null
    } catch (submitError) {
      setError(
        submitError instanceof ApiError && submitError.code === 'current_password_invalid'
          ? t('sensitiveAction.incorrectPassword')
          : submitError instanceof Error
            ? submitError.message
            : t('sensitiveAction.verificationFailed'),
      )
    } finally {
      setSubmitting(false)
    }
  }

  function cancel() {
    setOpen(false)
    pending.current?.reject(new Error(t('sensitiveAction.cancelled')))
    pending.current = null
  }

  const reauthenticationFormProps = {
    explanation: t('sensitiveAction.explanation'),
    error,
    submitting,
    verifyingLabel: t('sensitiveAction.verifying'),
    cancelLabel: t('common.cancel'),
    continueLabel: t('common.continue'),
    onSubmit: (event: FormEvent<HTMLFormElement>) => void handleSubmit(event),
  }

  const reauthenticationDialog = !open
    ? null
    : isMobile
      ? (
          <MobileSettingsSheet
            title={t('sensitiveAction.confirmPassword')}
            busy={submitting}
            onClose={cancel}
          >
            {(close) => (
              <ReauthenticationForm
                {...reauthenticationFormProps}
                mobile
                onCancel={close}
              />
            )}
          </MobileSettingsSheet>
        )
      : (
          <ActionDialog
            variant="compact"
            title={t('sensitiveAction.confirmPassword')}
            closeLabel={t('common.close')}
            backdropClassName="reauthenticationBackdrop"
            busy={submitting}
            onClose={cancel}
          >
            <ReauthenticationForm
              {...reauthenticationFormProps}
              onCancel={cancel}
            />
          </ActionDialog>
        )

  return { runSensitiveAction, reauthenticationDialog }
}
