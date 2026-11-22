import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Ban, CheckCircle2, Copy, LoaderCircle, Plus, Ticket } from 'lucide-react'
import { toast } from 'sonner'
import type { InviteCode } from '@shared/types'
import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'

function inviteStatus(invite: InviteCode): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!invite.active) return { label: '已停用', tone: 'muted' }
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return { label: '已过期', tone: 'warn' }
  if (invite.usedCount >= invite.maxUses) return { label: '已用完', tone: 'warn' }
  return { label: '可用', tone: 'ok' }
}


export default function InviteCodesSettings() {
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [maxUses, setMaxUses] = useState('1')
  const [expiresAt, setExpiresAt] = useState('')
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.admin.inviteCodes.list()
      setInvites(result.invites)
    } catch (cause) {
      setError(getErrorMessage(cause, '加载邀请码失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating) return
    const uses = Number(maxUses)
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
      setError('使用次数必须是 1–1000 的整数')
      return
    }
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      setError('失效时间必须晚于当前时间')
      return
    }
    setCreating(true)
    setError('')
    try {
      const result = await api.admin.inviteCodes.create({
        maxUses: uses,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      })
      setInvites((current) => [result.invite, ...current])
      setMaxUses('1')
      setExpiresAt('')
      toast.success(`邀请码 ${result.invite.code} 已生成`)
    } catch (cause) {
      setError(getErrorMessage(cause, '生成邀请码失败'))
    } finally {
      setCreating(false)
    }
  }

  async function toggle(invite: InviteCode) {
    if (busyId) return
    setBusyId(invite.id)
    setError('')
    try {
      const result = await api.admin.inviteCodes.update(invite.id, !invite.active)
      setInvites((current) => current.map((item) => item.id === result.invite.id ? result.invite : item))
    } catch (cause) {
      setError(getErrorMessage(cause, '更新邀请码失败'))
    } finally {
      setBusyId(null)
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('邀请码已复制')
    } catch {
      toast.error('复制失败，请手动选择邀请码')
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h2><Ticket size={16} /> 邀请码</h2>
            <p>新用户注册必须使用邀请码。邀请码只能由管理员生成，可限制使用次数和失效时间。</p>
          </div>
        </div>

        <form className="settings-form settings-form-grid invite-create-form" onSubmit={create}>
          <label className="field">
            <span className="label">使用次数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
              disabled={creating}
            />
            <span className="hint">每个邀请码最多可用于 1–1000 次注册</span>
          </label>
          <label className="field">
            <span className="label">失效时间 <span className="optional">可选</span></span>
            <input
              className="input"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              disabled={creating}
            />
            <span className="hint">留空表示不自动失效；以本地时间输入</span>
          </label>
          <div className="settings-actions invite-create-actions">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
              生成邀请码
            </button>
          </div>
        </form>
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h2>已生成的邀请码</h2>
            <p>停用后不能继续注册；已经注册的账号不受影响。</p>
          </div>
          <span className="settings-count">{invites.length} 个</span>
        </div>
        {loading ? (
          <p className="settings-loading"><LoaderCircle size={16} className="spin" />正在加载邀请码…</p>
        ) : invites.length === 0 ? (
          <div className="invite-empty">还没有邀请码，先在上方生成一个。</div>
        ) : (
          <div className="invite-list">
            {invites.map((invite) => {
              const status = inviteStatus(invite)
              return (
                <article className="invite-row" key={invite.id}>
                  <div className="invite-code">
                    <code>{invite.code}</code>
                    <button type="button" className="btn btn-sm" onClick={() => void copy(invite.code)} title="复制邀请码">
                      <Copy size={13} />
                    </button>
                  </div>
                  <div className="invite-meta">
                    <span>已用 {invite.usedCount}/{invite.maxUses} 次</span>
                    <span>{invite.expiresAt ? `失效：${formatDateTime(invite.expiresAt)}` : '不自动失效'}</span>
                    <span className={`invite-status is-${status.tone}`}>
                      {status.tone === 'ok' ? <CheckCircle2 size={12} /> : <Ban size={12} />}
                      {status.label}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === invite.id}
                    onClick={() => void toggle(invite)}
                  >
                    {busyId === invite.id ? <LoaderCircle size={13} className="spin" /> : null}
                    {invite.active ? '停用' : '重新启用'}
                  </button>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
