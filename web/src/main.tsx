import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import './styles/globals.css'
import './components/common.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster richColors closeButton position="top-center" toastOptions={{ duration: 2800 }} />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
