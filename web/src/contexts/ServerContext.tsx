import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'

interface ServerInfo {
  desktopMode: boolean
  version: string
  loading: boolean
}

const ServerInfoContext = createContext<ServerInfo>({ desktopMode: false, version: '', loading: true })

export function ServerInfoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ServerInfo>({ desktopMode: false, version: '', loading: true })

  useEffect(() => {
    let active = true
    api.health()
      .then((health) => {
        if (active) setState({ desktopMode: health.desktopMode === true, version: health.version, loading: false })
      })
      .catch(() => {
        if (active) setState({ desktopMode: false, version: '', loading: false })
      })
    return () => { active = false }
  }, [])

  const value = useMemo(() => state, [state])
  return <ServerInfoContext.Provider value={value}>{children}</ServerInfoContext.Provider>
}

export function useServerInfo(): ServerInfo {
  return useContext(ServerInfoContext)
}
