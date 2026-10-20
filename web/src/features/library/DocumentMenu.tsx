import {
  Braces,
  Code2,
  Copy,
  Download,
  Ellipsis,
  FileText,
  FolderInput,
  PenLine,
  RotateCcw,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import type { ContentSummary } from '@shared/types'
import type { ExportFormat } from '@/lib/content-io'
import { cn } from '@/lib/utils'
import Dropdown, { type DropdownEntry } from '@/components/Dropdown'
import type { LibraryMode } from './types'

export interface DocumentActions {
  open: (item: ContentSummary) => void
  toggleFavorite: (item: ContentSummary) => void
  exportFormat: (item: ContentSummary, format: ExportFormat) => void
  duplicate: (item: ContentSummary) => void
  move: (item: ContentSummary) => void
  remove: (item: ContentSummary) => void
  restore: (item: ContentSummary) => void
  permanentRemove: (item: ContentSummary) => void
  render: (item: ContentSummary) => void
}

interface DocumentMenuProps {
  item: ContentSummary
  mode: LibraryMode
  actions: DocumentActions
  className?: string
}

export default function DocumentMenu({ item, mode, actions, className }: DocumentMenuProps) {
  const items: DropdownEntry[] =
    mode === 'trash'
      ? [
          {
            key: 'open',
            label: '查看文档',
            icon: <PenLine size={16} />,
            onSelect: () => actions.open(item),
          },
          'separator',
          {
            key: 'restore',
            label: '恢复文档',
            icon: <RotateCcw size={16} />,
            onSelect: () => actions.restore(item),
          },
          {
            key: 'delete',
            label: '彻底删除',
            icon: <Trash2 size={16} />,
            danger: true,
            onSelect: () => actions.permanentRemove(item),
          },
        ]
      : [
          {
            key: 'open',
            label: '打开编辑',
            icon: <PenLine size={16} />,
            onSelect: () => actions.open(item),
          },
          'separator',
          {
            key: 'render',
            label: '前往渲染',
            icon: <WandSparkles size={16} />,
            onSelect: () => actions.render(item),
          },
          {
            key: 'duplicate',
            label: '复制文档',
            icon: <Copy size={16} />,
            onSelect: () => actions.duplicate(item),
          },
          {
            key: 'move',
            label: '移动知识库',
            icon: <FolderInput size={16} />,
            onSelect: () => actions.move(item),
          },
          {
            key: 'export',
            label: '导出',
            icon: <Download size={16} />,
            submenu: [
              {
                key: 'export-markdown',
                label: 'Markdown',
                icon: <FileText size={15} />,
                hint: '.md',
                onSelect: () => actions.exportFormat(item, 'markdown'),
              },
              {
                key: 'export-html',
                label: 'HTML',
                icon: <Code2 size={15} />,
                hint: '.html',
                onSelect: () => actions.exportFormat(item, 'html'),
              },
              {
                key: 'export-json',
                label: 'MultiPush JSON',
                icon: <Braces size={15} />,
                hint: '.json',
                onSelect: () => actions.exportFormat(item, 'json'),
              },
            ],
          },
          'separator',
          {
            key: 'delete',
            label: '删除文档',
            icon: <Trash2 size={16} />,
            danger: true,
            onSelect: () => actions.remove(item),
          },
        ]

  return (
    <Dropdown
      align="end"
      minWidth={196}
      className={cn('document-menu', className)}
      trigger={
        <button
          type="button"
          className="document-more"
          aria-label={`「${item.title || '无标题文档'}」更多操作`}
          title="更多操作"
        >
          <Ellipsis size={17} />
        </button>
      }
      items={items}
    />
  )
}
