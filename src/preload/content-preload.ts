import { ipcRenderer, contextBridge } from 'electron'
import { readFileSync } from 'fs'
import orbitIcon from '../renderer/src/lib/assets/images/orbit.png?asset'

// The Open WebUI client is rendered in a <webview>, rather than the desktop
// renderer. Apply managed branding here so it reaches the guest page as well.
const orbitIconData = `data:image/png;base64,${readFileSync(orbitIcon).toString('base64')}`

const applyOrbitBranding = (): void => {
  if (!document.documentElement) return

  document.title = 'Omio Orbit'

  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    const text = element.textContent?.trim()
    if (text !== 'Open WebUI' && text !== 'orbit') continue

    element.textContent = text === 'orbit' ? 'Orbit' : 'Omio Orbit'
    const header = element.parentElement
    const oldIcon = header?.querySelector('img, svg')
    if (!oldIcon || oldIcon.getAttribute('data-orbit-icon') === 'true') continue

    const image = document.createElement('img')
    image.src = orbitIconData
    image.alt = 'Omio Orbit'
    image.setAttribute('data-orbit-icon', 'true')
    image.style.cssText = 'width:1.5rem;height:1.5rem;object-fit:contain;flex:none;'
    oldIcon.replaceWith(image)
  }
}

const startOrbitBranding = (): void => {
  applyOrbitBranding()
  new MutationObserver(applyOrbitBranding).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startOrbitBranding, { once: true })
} else {
  startOrbitBranding()
}

// ─── Desktop ↔ Open WebUI Generic Protocol ──────────────
// This preload is a dumb relay. It passes typed {type, data}
// messages between the embedder (desktop renderer) and the
// Open WebUI page. Business logic lives elsewhere.
// To add new features, just add new event types — this file
// never needs to change.

type EventCallback = (data: any) => void
const eventCallbacks: EventCallback[] = []

// Embedder → Guest (push events from desktop)
ipcRenderer.on('desktop:event', (_event, data) => {
  eventCallbacks.forEach((cb) => cb(data))
})

// ─── Theme Sync: Open WebUI → Desktop ───────────────────
// Open WebUI calls window.applyTheme() after every theme change.
// We inject this hook so the desktop shell can mirror the theme.
contextBridge.exposeInMainWorld('applyTheme', () => {
  const theme = localStorage.getItem('theme') ?? 'system'
  ipcRenderer.sendToHost('webview:event', { type: 'theme:update', data: { theme } })
})

// Expose to the Open WebUI page via contextBridge (secure, unforgeable)
contextBridge.exposeInMainWorld('electronAPI', {
  // Push events: desktop → Open WebUI
  onEvent: (callback: EventCallback): void => {
    eventCallbacks.push(callback)
  },

  // Request/Response: Open WebUI → desktop
  send: (data: any): Promise<any> => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2)
      const handler = (_event: any, response: any) => {
        if (response?._responseId === id) {
          ipcRenderer.removeListener('desktop:response', handler)
          resolve(response.data)
        }
      }
      ipcRenderer.on('desktop:response', handler)
      ipcRenderer.sendToHost('webview:send', { ...data, _requestId: id })
    })
  },

  // Navigation: Open WebUI → desktop
  load: (page: string): void => {
    ipcRenderer.sendToHost('webview:load', page)
  }
})
