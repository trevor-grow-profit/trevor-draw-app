import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { warmEngineFor } from './drawings/engine'
import { storage } from './lib/storage'
import './app.css'

// First-paint theming (K, GRO-2218): the app state arrives async over the bridge, but main set
// `nativeTheme.themeSource` from the stored setting BEFORE this window existed — so the media
// query already IS the effective theme. Stamping it synchronously (before render, same script
// turn as the CSS) means even the pre-React body paints in the right palette; App re-resolves
// and keeps it live once the state loads.
document.documentElement.dataset.theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

function render(): void {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

// The app state lives in the main process (D9): load it (and this window's identity) before the first render.
void storage
  .init()
  .catch((err: unknown) => console.error('[storage] init failed; rendering with defaults', err))
  .then(() => {
    warmEngineFor(storage.getFile())
    render()
  })
