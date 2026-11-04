'use strict'

const api = window.multipushDesktop
const form = document.getElementById('form')
const serverInput = document.getElementById('server')
const connectButton = document.getElementById('connect')
const testButton = document.getElementById('test')
const resetButton = document.getElementById('reset')
const status = document.getElementById('status')
const title = document.getElementById('title')
const description = document.getElementById('description')
const meta = document.getElementById('meta')

const query = new URLSearchParams(window.location.search)
const reason = query.get('reason') || 'change'
const initialError = query.get('error') || ''
const initialCurrent = query.get('current') || ''
let defaultServer = 'https://publish.yuan-xin.top'

function setStatus(kind, message) {
  status.dataset.kind = kind
  status.textContent = message
}

function setBusy(busy, activeButton) {
  for (const button of [connectButton, testButton, resetButton]) {
    button.disabled = busy
  }
  if (busy && activeButton) activeButton.textContent = '请稍候…'
}

function restoreLabels() {
  connectButton.textContent = '连接'
  testButton.textContent = '测试连接'
  resetButton.textContent = '恢复默认'
}

function showReason() {
  if (reason === 'unreachable') {
    title.textContent = '重新连接 MultiPush'
    description.textContent = '当前无法打开服务。请检查服务器地址、网络连接，或确认 MultiPush 服务正在运行。'
  } else if (reason === 'first-run') {
    title.textContent = '连接你的 MultiPush 服务'
  } else {
    title.textContent = '切换 MultiPush 服务'
    description.textContent = '切换服务器不会删除本地数据；登录状态按服务器地址分别保存。'
  }
  if (initialError) setStatus('error', initialError)
}

async function init() {
  showReason()
  try {
    const state = await api.getState()
    defaultServer = state.defaultServer || defaultServer
    if (!serverInput.value) serverInput.value = initialCurrent || state.current || defaultServer
    meta.textContent = `MultiPush Desktop ${state.version} · ${state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : state.platform}`
  } catch (error) {
    serverInput.value = initialCurrent || defaultServer
    meta.textContent = 'MultiPush Desktop'
    if (!initialError) setStatus('error', error instanceof Error ? error.message : String(error))
  }
  serverInput.focus()
  serverInput.select()
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (connectButton.disabled) return
  const value = serverInput.value.trim()
  if (!value) {
    setStatus('error', '请输入服务器地址')
    serverInput.focus()
    return
  }
  setBusy(true, connectButton)
  setStatus('progress', '正在验证服务器…')
  try {
    const result = await api.connect(value)
    if (!result.ok) {
      setStatus('error', result.message || '连接失败')
      return
    }
    serverInput.value = result.url
    setStatus('success', `连接成功${result.version ? ` · 服务版本 ${result.version}` : ''}，正在打开…`)
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error))
  } finally {
    restoreLabels()
    setBusy(false)
  }
})

testButton.addEventListener('click', async () => {
  if (testButton.disabled) return
  const value = serverInput.value.trim()
  if (!value) {
    setStatus('error', '请输入服务器地址')
    serverInput.focus()
    return
  }
  setBusy(true, testButton)
  setStatus('progress', '正在验证服务器…')
  try {
    const result = await api.testServer(value)
    if (!result.ok) {
      setStatus('error', result.message || '连接失败')
      return
    }
    serverInput.value = result.url
    setStatus('success', `连接成功${result.version ? ` · 服务版本 ${result.version}` : ''}`)
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error))
  } finally {
    restoreLabels()
    setBusy(false)
  }
})

resetButton.addEventListener('click', () => {
  serverInput.value = defaultServer
  serverInput.focus()
  serverInput.select()
  setStatus('idle', '')
})

document.getElementById('quit').addEventListener('click', () => {
  void api.quit()
})

init()
