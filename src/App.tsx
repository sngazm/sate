import { useCallback, useEffect, useMemo, useState } from 'react';
import EditorComponent from './components/Editor';
import WordCount from './components/WordCount';
import ShortcutHelp from './components/ShortcutHelp';
import SettingsDialog from './components/SettingsDialog';
import { useFile } from './hooks/useFile';
import { useSettings } from './hooks/useSettings';
import './App.css';

function App() {
  const { settings, loaded, updateSettings } = useSettings();
  const { content, updateContent } = useFile(settings?.baseDir ?? '');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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
    const tryFocus = () => {
      const el = document.querySelector('.ProseMirror') as HTMLElement | null;
      if (el) {
        el.focus();
        return true;
      }
      return false;
    };
    if (!tryFocus()) {
      const observer = new MutationObserver(() => {
        if (tryFocus()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showShortcuts, showSettings]);

  if (!loaded || !settings) return null;

  return (
    <div className="app" onClick={handleClick}>
      <div className="editor-container">
        <div className="editor-wrapper">
          <EditorComponent onChange={updateContent} />
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
    </div>
  );
}

export default App;
