import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import crimsonProUrl from '@fontsource/crimson-pro/files/crimson-pro-latin-300-normal.woff2?url'
import './index.css'
import App from './App.tsx'

// Sate の画面（Dive）は背後の画面を透かすので、下地を塗らない（index.css、src/lib/diveTransition.ts）。
// ブラウザで開いたとき（vite dev）は透かす先が無いので塗る
if ('__TAURI_INTERNALS__' in window) document.documentElement.classList.add('dive')

const crimsonPro = new FontFace(
  'Crimson Pro',
  `url(${crimsonProUrl}) format('woff2')`,
  { weight: '300', style: 'normal', display: 'block' },
)
document.fonts.add(crimsonPro)
crimsonPro.load()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
