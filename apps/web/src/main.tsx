import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans/wght.css'
import '@fontsource-variable/noto-sans/wght-italic.css'
import './i18n'
import './styles/tokens.css'
import './styles/scrollbars.css'
import './styles/tiptap.css'
import './index.css'
import './features/books/OfflineStorageCleanup'
import App from './App.tsx'
import { registerPwa } from './pwa/registerPwa.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

registerPwa()
