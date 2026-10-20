import type { ReactNode } from 'react'
import { CircleAlert, LoaderCircle, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import Modal from './Modal'

interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  loading?: boolean
  onConfirm: () => void | Promise<void>
  onClose: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'danger',
  loading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!loading) onClose()
      }}
      title={title}
      size="compact"
      closeOnBackdrop={!loading}
      showClose={!loading}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn('btn', tone === 'danger' ? 'btn-danger-solid' : 'btn-primary')}
            onClick={() => void onConfirm()}
            disabled={loading}
          >
            {loading ? <LoaderCircle size={16} className="spin" /> : null}
            {loading ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-dialog">
        <span className={cn('confirm-icon', tone === 'danger' ? 'confirm-icon-danger' : 'confirm-icon-brand')}>
          {tone === 'danger' ? <Trash2 size={18} /> : <CircleAlert size={18} />}
        </span>
        <div className="confirm-copy">{description}</div>
      </div>
    </Modal>
  )
}
