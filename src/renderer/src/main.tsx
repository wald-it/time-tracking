import '@fontsource-variable/archivo/wdth.css' // 'Archivo Variable', wght 100–900, wdth 62–125 %
import '@fontsource/ibm-plex-mono/300.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './assets/base.css'
import './assets/main.css'
// v1.5 PR A — route renderer console.* through main-process electron-log
// (which is initialized with spyRendererConsole: true). Picked up via IPC.
import 'electron-log/renderer'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useSettingsStore } from './store/settingsStore'
import { I18nProvider } from './contexts/I18nContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { RoundingProvider } from './contexts/RoundingContext'

// v1.13.2 PR 2: settings live in a zustand store (selector-based, no
// provider needed). Kick off the initial load before first render.
void useSettingsStore.getState().load()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <RoundingProvider>
          <App />
        </RoundingProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>
)
