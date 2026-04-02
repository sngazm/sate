import { useCallback, useEffect, useMemo, useState } from 'react';
import EditorComponent from './components/Editor';
import WordCount from './components/WordCount';
import ShortcutHelp from './components/ShortcutHelp';
import SettingsDialog from './components/SettingsDialog';
import FileOpenDialog from './components/FileOpenDialog';
import { useFile } from './hooks/useFile';
import { useSettings } from './hooks/useSettings';
import { useDb } from './hooks/useDb';
import { useSnapshot } from './hooks/useSnapshot';
import './App.css';

function App() {
  const { settings, loaded, updateSettings } = useSettings();
  const { fileName, content, updateContent, saveFile, openFile, metadataRef, contentRef } = useFile(settings?.baseDir ?? '');
  const { db, ready: dbReady } = useDb(settings?.baseDir ?? '');
  useSnapshot({ db, metadataRef, contentRef, content });
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFileOpen, setShowFileOpen] = useState(false);

  const charCount = useMemo(() => {
    return content.replace(/\s/g, '').length;
  }, [content]);

  const handleClick = useCallback(() => {
    if (showShortcuts || showSettings) return;
    const el = document.querySelector('.ProseMirror') as HTMLElement | null;
    if (el && document.activeElement !== el) {
      el.focus();
    }
  }, [showShortcuts, showSettings]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 's') {
        e.preventDefault();
        saveFile(true);
      }
      if (e.metaKey && e.key === 'o') {
        e.preventDefault();
        setShowFileOpen((v) => !v);
      }
      if (e.metaKey && e.key === '/') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setShowSettings((v) => !v);
      }
      if (e.key === 'Escape') {
        if (showSettings) {
          e.preventDefault();
          setShowSettings(false);
        } else if (showShortcuts) {
          e.preventDefault();
          setShowShortcuts(false);
        } else if (showFileOpen) {
          e.preventDefault();
          setShowFileOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showShortcuts, showSettings, showFileOpen, saveFile]);

  if (!loaded || !settings) return null;

  return (
    <div className="app" onClick={handleClick}>
      <div className="editor-container">
        <div className="editor-wrapper">
          <EditorComponent key={fileName} initialContent={content} onChange={updateContent} />
        </div>
      </div>
      <WordCount count={charCount} />
      <ShortcutHelp visible={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <SettingsDialog
        visible={showSettings}
        settings={settings}
        onSave={updateSettings}
        onClose={() => setShowSettings(false)}
      />
      <FileOpenDialog
        visible={showFileOpen}
        dirPath={settings.baseDir}
        db={db}
        dbReady={dbReady}
        onOpen={openFile}
        onClose={() => setShowFileOpen(false)}
      />
    </div>
  );
}

export default App;
