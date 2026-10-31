import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import crimsonProUrl from '@fontsource/crimson-pro/files/crimson-pro-latin-300-normal.woff2?url'
import './index.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import App from './App.tsx'

// バイザー用パネル（src-tauri/src/visor.rs）も同じ index.html を読むので、ウィンドウのラベルで見分ける
const isVisor = '__TAURI_INTERNALS__' in window && getCurrentWindow().label === 'visor'

const crimsonPro = new FontFace(
  'Crimson Pro',
  `url(${crimsonProUrl}) format('woff2')`,
  { weight: '300', style: 'normal', display: 'block' },
)
document.fonts.add(crimsonPro)
crimsonPro.load()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App visor={isVisor} />
  </StrictMode>,
)
