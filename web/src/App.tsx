import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import AppShell from '@/components/AppShell'
import LoginPage from '@/features/auth/LoginPage'
import RegisterPage from '@/features/auth/RegisterPage'
import LibraryPage from '@/features/library/LibraryPage'
import EditorPage from '@/features/editor/EditorPage'
import RenderPage from '@/features/render/RenderPage'
import PublishPage from '@/features/publish/PublishPage'
import { Loader2 } from 'lucide-react'

function FullScreenLoading() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Loader2 size={18} className="spin" />
        正在加载 MultiPush…
      </div>
    </div>
  )
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <FullScreenLoading />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/editor/:id"
        element={
          <Protected>
            <EditorPage />
          </Protected>
        }
      />
      <Route
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/library/favorites" element={<LibraryPage />} />
        <Route path="/library/trash" element={<LibraryPage />} />
        <Route path="/library/book/:bookId" element={<LibraryPage />} />
        <Route path="/render" element={<RenderPage />} />
        <Route path="/publish" element={<PublishPage />} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Route>
    </Routes>
  )
}
