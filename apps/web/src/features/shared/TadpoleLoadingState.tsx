import TadpoleIcon from '~icons/svg-spinners/tadpole'
import './TadpoleLoadingState.css'

type Props = {
  label: string
  className?: string
}

export function TadpoleLoadingState({ label, className = '' }: Props) {
  return (
    <div
      className={`tadpoleLoadingState ${className}`.trim()}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      <TadpoleIcon />
    </div>
  )
}
