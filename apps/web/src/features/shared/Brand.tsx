type BrandProps = {
  onActivate?: () => void
  disabled?: boolean
}

function BrandContent() {
  return (
    <>
      <span className="brandMark" aria-hidden="true">
        <img src="/quillum-logo-mark.png" alt="" />
      </span>
      <span>Quillum</span>
    </>
  )
}

export function Brand({ onActivate, disabled = false }: BrandProps) {
  if (onActivate) {
    return (
      <button
        type="button"
        className="brand brandButton spaceButton"
        disabled={disabled}
        onClick={onActivate}
      >
        <BrandContent />
      </button>
    )
  }

  return <div className="brand"><BrandContent /></div>
}
