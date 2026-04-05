import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditorComponent from './components/Editor';
import WordCount from './components/WordCount';
import ShortcutHelp from './components/ShortcutHelp';
import SettingsDialog from './components/SettingsDialog';
import FileOpenDialog from './components/FileOpenDialog';
import RewindTimeline from './components/RewindTimeline';
import { useFile } from './hooks/useFile';
import { useRewind } from './hooks/useRewind';
import { useSettings } from './hooks/useSettings';
import { initDatabase } from './lib/db';
import { reconcile } from './lib/reconcile';
import './App.css';

function App() {
  const { settings, loaded, updateSettings } = useSettings();
  const { fileName, fileId, content, updateContent, saveFile, openFile, initFile } = useFile(settings?.baseDir ?? '');
  const rewind = useRewind(fileId);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFileOpen, setShowFileOpen] = useState(false);

  const displayContent = rewind.active && rewind.currentContent !== null
    ? rewind.currentContent
    : content;

  // Crossfade: track previous content to fade out while new content fades in
  const [fadeContent, setFadeContent] = useState<string | null>(null);
  const [fadeKey, setFadeKey] = useState(0);
  const prevDisplayRef = useRef(displayContent);

  useEffect(() => {
    if (rewind.active && prevDisplayRef.current !== displayContent) {
      // Capture old content for fade-out layer
      setFadeContent(prevDisplayRef.current);
      setFadeKey((k) => k + 1);
      prevDisplayRef.current = displayContent;
    } else if (!rewind.active) {
      setFadeContent(null);
      prevDisplayRef.current = displayContent;
    }
  }, [rewind.active, displayContent]);

  const charCount = useMemo(() => {
    if (!displayContent) return 0;
    // Milkdownは段落間を \n\n で区切り、空段落に <br /> を入れる
    // 段落ごとに分割してカウントする
    const paragraphs = displayContent.split(/\n\n/);
    let count = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i]
        .replace(/<[^>]*>/g, '')  // HTMLタグ除去
        .replace(/\s/g, '');      // 空白除去
      count += text.length;
      // 段落間の改行を1としてカウント（最後の段落の後は数えない）
      if (i < paragraphs.length - 1) count += 1;
    }
    return count;
  }, [displayContent]);

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
      if (e.metaKey && e.key === 'n') {
        e.preventDefault();
        if (content) {
          saveFile(true).then(() => {
            initFile();
            setTimeout(() => {
              const el = document.querySelector('.ProseMirror') as HTMLElement | null;
              el?.focus();
            }, 160);
          });
        }
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
  }, [showShortcuts, showSettings, showFileOpen, saveFile, initFile, content]);

  useEffect(() => {
    if (!loaded || !settings) return;
    initDatabase(settings.baseDir)
      .then(() => reconcile(settings.baseDir))
      .catch((err) => console.error('Failed to init DB:', err));
  }, [loaded, settings]);

  if (!loaded || !settings) return null;

  return (
    <div className={`app${rewind.active ? ' rewind-active' : ''}`} onClick={handleClick}>
      <div className="editor-container">
        <div className="editor-wrapper">
          {/* Fade-out layer: previous snapshot content */}
          {rewind.active && fadeContent !== null && (
            <div key={`fade-${fadeKey}`} className="rewind-fade-out">
              <EditorComponent
                initialContent={fadeContent}
                readOnly
              />
            </div>
          )}
          {/* Main editor layer */}
          <div
            key={rewind.active ? `${fileName}-rewind-${rewind.currentIndex}` : fileName}
            className={rewind.active ? 'rewind-fade-in' : undefined}
          >
            <EditorComponent
              initialContent={displayContent}
              onChange={rewind.active ? undefined : updateContent}
              readOnly={rewind.active}
            />
          </div>
        </div>
      </div>
      {fileName && <div className="file-name">{fileName.replace(/\.md$/, '')}</div>}
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
        onOpen={openFile}
        onClose={() => setShowFileOpen(false)}
      />
      <RewindTimeline
        visible={rewind.active}
        snapshots={rewind.snapshots}
        currentIndex={rewind.currentIndex}
      />
    </div>
  );
}

export default App;
