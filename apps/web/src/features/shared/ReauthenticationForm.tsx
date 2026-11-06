import type { FormEvent } from 'react'

type Props = {
  explanation: string
  error: string
  submitting: boolean
  verifyingLabel: string
  cancelLabel: string
  continueLabel: string
  mobile?: boolean
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

export function ReauthenticationForm({
  explanation,
  error,
  submitting,
  verifyingLabel,
  cancelLabel,
  continueLabel,
  mobile = false,
  onCancel,
  onSubmit,
}: Props) {
  return (
    <form
      className={`reauthenticationStructuredForm ${mobile ? 'reauthenticationMobileForm' : ''}`.trim()}
      onSubmit={onSubmit}
    >
      <div className="compactDialogSection">
        <p>{explanation}</p>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
        />
        {error && <div className="notice error">{error}</div>}
      </div>
      <footer className="compactDialogFooter opposingDialogFooter">
        <button
          type="button"
          className="compactDialogSecondaryAction"
          disabled={submitting}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button type="submit" className="compactDialogPrimaryAction" disabled={submitting}>
          {submitting ? verifyingLabel : continueLabel}
        </button>
      </footer>
    </form>
  )
}
