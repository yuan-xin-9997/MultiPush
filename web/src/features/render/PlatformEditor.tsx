import { useRef, useState } from 'react'
import { EditorContent, Node, mergeAttributes, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Underline from '@tiptap/extension-underline'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { getPlatformInfo, type PlatformAdjustment, type PlatformRender, type XhsCard } from '@shared/types'
import { createCardId, getCaptionBody, renumberCards } from '@shared/render-workbench'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { getErrorMessage } from '@/lib/errors'
import Modal from '@/components/Modal'
import XhsCardView from './XhsCardView'
import type { CardStyle } from './types'

const Video = Node.create({
  name: 'video', group: 'block', atom: true,
  addAttributes: () => ({ src: { default: null }, poster: { default: null } }),
  parseHTML: () => [{ tag: 'video[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['video', mergeAttributes(HTMLAttributes, { controls: 'controls' })],
})

function editableArticle(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  // The renderer will rebuild the automatic table of contents after editing.
  document.querySelectorAll('nav').forEach((node) => node.remove())
  return document.body.innerHTML
}

interface Props {
  render: PlatformRender
  style: CardStyle
  onClose: () => void
  onSave: (input: PlatformAdjustment) => Promise<void>
}

export default function PlatformEditor({ render, style, onClose, onSave }: Props) {
  const [title, setTitle] = useState(render.title)
  const [body, setBody] = useState(getCaptionBody(render))
  const [tags, setTags] = useState(render.meta.tags.join(' '))
  const [cards, setCards] = useState(render.cards)
  const [index, setIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const changed = useRef(false)
  const cardText = useRef<HTMLTextAreaElement>(null)
  const article = render.platform === 'wechat' || render.platform === 'zhihu'
  const editor = useEditor({
    extensions: [StarterKit, Image, Link.configure({ openOnClick: false }), Table, TableRow, TableCell, TableHeader,
      Underline, TextStyle, Color, Highlight.configure({ multicolor: true }), TextAlign.configure({ types: ['heading', 'paragraph'] }), TaskList, TaskItem.configure({ nested: true }), Video],
    content: article ? editableArticle(render.html) : '', onUpdate: () => { changed.current = true },
  })
  const card = cards[index]
  const busy = saving || uploading
  function updateCard(patch: Partial<XhsCard>) {
    setCards((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item))
  }
  function move(direction: number) {
    const target = index + direction
    if (target < 0 || target >= cards.length) return
    const reordered = [...cards]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    setCards(renumberCards(reordered)); setIndex(target)
  }
  function split() {
    const text = card.body.join('\n\n')
    const position = cardText.current?.selectionStart ?? 0
    if (position <= 0 || position >= text.length) { toast.error('请先把光标放在要分页的位置'); return }
    const next = { ...card, id: createCardId(), type: 'content' as const, title: '', body: text.slice(position).split('\n\n'), images: [] }
    setCards(renumberCards([...cards.slice(0, index), { ...card, body: text.slice(0, position).split('\n\n') }, next, ...cards.slice(index + 1)]))
  }
  async function upload(file: File) {
    setUploading(true)
    try { const { media } = await api.media.upload(file); updateCard({ images: [media.url] }) }
    catch (error) { toast.error(getErrorMessage(error, '图片上传失败')) }
    finally { setUploading(false) }
  }
  async function save() {
    if (!title.trim()) { toast.error('请输入标题'); return }
    setSaving(true)
    try {
      await onSave({ title: title.trim(), tags: tags.split(/[\s,#，]+/).filter(Boolean),
        ...(article ? changed.current ? { html: editor?.getHTML() } : {} : { body }),
        ...(render.platform === 'xiaohongshu' ? { cards: renumberCards(cards) } : {}),
      })
      onClose()
    } catch (error) { toast.error(getErrorMessage(error, '保存调整失败')) }
    finally { setSaving(false) }
  }
  return <Modal open onClose={() => { if (!busy) onClose() }} title={`调整${getPlatformInfo(render.platform).name}`} size="wide"
    subtitle="只修改当前平台的渲染结果，保存到当前记录；原文和其他平台不受影响。"
    footer={<><button className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存调整'}</button></>}>
    <fieldset className="render-edit-form" disabled={busy}>
      <label>平台标题（{Array.from(title).length} 字）<input className="input" value={title} maxLength={500} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>话题标签（空格分隔，最多 10 个）<input className="input" value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      {article ? <div>
        <div className="render-edit-toolbar">
          <button className="btn btn-sm" onClick={() => editor?.chain().focus().toggleBold().run()}>加粗</button>
          <button className="btn btn-sm" onClick={() => editor?.chain().focus().toggleItalic().run()}>斜体</button>
          <button className="btn btn-sm" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>小标题</button>
          <button className="btn btn-sm" onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</button>
          <button className="btn btn-sm" onClick={() => editor?.chain().focus().undo().run()}>撤销</button>
        </div>
        <EditorContent editor={editor} className="render-article-editor" />
      </div> : <label>正文（标题和话题会分别组装到发布文案）<textarea className="input" rows={8} value={body} onChange={(event) => setBody(event.target.value)} /></label>}
      {render.platform === 'xiaohongshu' && card ? <div className="render-card-editor">
        <h3>卡片微调 · 保存后自动检查分页</h3>
        <div className="render-card-thumbnails" role="tablist" aria-label="选择要调整的卡片">
          {cards.map((item, i) => <button key={item.id} role="tab" aria-selected={index === i} aria-label={`编辑第 ${i + 1} 张卡片`} onClick={() => setIndex(i)}>
            <div className="render-card-thumbnail"><XhsCardView card={item} style={style} tags={render.meta.tags} /></div><span>第 {i + 1} 张</span>
          </button>)}
        </div>
        <div className="render-edit-toolbar">
          <button className="btn btn-sm" disabled={index === 0} onClick={() => move(-1)}>前移</button>
          <button className="btn btn-sm" disabled={index === cards.length - 1} onClick={() => move(1)}>后移</button>
          {card.type === 'content' || card.type === 'quote' ? <button className="btn btn-sm" onClick={split}>在光标处分页</button> : null}
          <button className="btn btn-sm" disabled={cards.length <= 1} onClick={() => { setCards(renumberCards(cards.filter((_, i) => i !== index))); setIndex(Math.max(0, index - 1)) }}>删除此卡片</button>
        </div>
        <label>卡片标题<input className="input" value={card.title} onChange={(event) => updateCard({ title: event.target.value })} /></label>
        <label>卡片文字<textarea ref={cardText} className="input" rows={5} value={card.body.join('\n\n')} onChange={(event) => updateCard({ body: event.target.value.split('\n\n') })} /></label>
        <label>替换图片 / 选择封面图<select className="input" value={card.images[0] ?? ''} onChange={(event) => updateCard({ images: event.target.value ? [event.target.value] : [] })}>
          <option value="">无图片</option>
          {[...new Set([...render.assets.filter((asset) => asset.kind === 'image').map((asset) => asset.url), ...cards.flatMap((item) => item.images)])].map((url, i) => <option key={url} value={url}>图片 {i + 1} · {url.split('/').pop()?.slice(0, 35)}</option>)}
        </select></label>
        <label>上传替换图片<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = '' }} /></label>
        {card.images.length ? <>
          <label>水平裁剪位置<input type="range" min="0" max="100" value={card.imagePosition?.x ?? 50} onChange={(event) => updateCard({ imagePosition: { x: Number(event.target.value), y: card.imagePosition?.y ?? 50 } })} /></label>
          <label>垂直裁剪位置<input type="range" min="0" max="100" value={card.imagePosition?.y ?? 50} onChange={(event) => updateCard({ imagePosition: { x: card.imagePosition?.x ?? 50, y: Number(event.target.value) } })} /></label>
        </> : null}
      </div> : null}
    </fieldset>
  </Modal>
}
