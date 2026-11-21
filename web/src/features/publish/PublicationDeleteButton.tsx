import { useState } from 'react'
import { toast } from 'sonner'
import type { PublicationDeletion } from '@shared/types'
import ConfirmDialog from '@/components/ConfirmDialog'
import { getErrorMessage } from '@/lib/errors'

type DeletablePublication = {
  id: string
  title: string
  status: 'running' | 'draft' | 'awaiting_confirmation' | 'published' | 'failed' | 'uncertain'
}

type Props = {
  publication: DeletablePublication
  remove: (id: string) => Promise<PublicationDeletion>
  onDeleted: () => void
  platformName: string
  /** Whether this platform can delete its remote draft automatically. */
  remote: boolean
  disabled?: boolean
}

/**
 * Shared delete action for publication history. Only draft/failed records are
 * deletable; the API enforces the same rule. Published content is never removed.
 */
export default function PublicationDeleteButton({ publication, remove, onDeleted, platformName, remote, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const draft = publication.status === 'draft'
  const label = draft ? '删除草稿' : '删除记录'
  const description = remote
    ? draft
      ? <>将同时删除{platformName}后台的这份草稿和本系统的发布记录，删除后无法恢复。</>
      : <>将清理本系统记录；如果这次提交在{platformName}留下了草稿，会尝试一并删除。已发布内容不受影响。</>
    : draft
      ? <>只删除本系统的发布记录，不会操作{platformName}后台。{platformName}的草稿需要到平台后台手动删除。</>
      : <>只删除本系统的发布记录，不会操作{platformName}后台的草稿或已发布内容。</>

  async function run() {
    setBusy(true)
    try {
      const result = await remove(publication.id)
      onDeleted()
      setOpen(false)
      toast.success(result.remoteDeleted ? `${platformName}草稿已删除` : '发布记录已删除')
    } catch (cause) {
      toast.error(getErrorMessage(cause))
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm" disabled={disabled || busy} onClick={() => setOpen(true)}>
        {busy ? '删除中…' : label}
      </button>
      <ConfirmDialog
        open={open}
        title={draft ? `删除${platformName}草稿？` : `删除${platformName}发布记录？`}
        description={<><strong>{publication.title}</strong><p>{description}</p></>}
        confirmLabel={label}
        loading={busy}
        onConfirm={run}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
