import { useState, useEffect, useRef, useCallback } from 'react';
import { readDir } from '@tauri-apps/plugin-fs';
import Database from '@tauri-apps/plugin-sql';
import { listFiles, searchFiles } from '../lib/search';
import type { FileEntry } from '../lib/search';
import './FileOpenDialog.css';

interface FileOpenDialogProps {
  visible: boolean;
  dirPath: string;
  db: Database | null;
  dbReady: boolean;
  onOpen: (fileName: string) => void;
  onClose: () => void;
}

export default function FileOpenDialog({ visible, dirPath, db, dbReady, onOpen, onClose }: FileOpenDialogProps) {
  const [items, setItems] = useState<{ name: string; firstLine?: string }[]>([]);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    (async () => {
      try {
        let result: { name: string; firstLine?: string }[];
        if (db && dbReady) {
          let entries: FileEntry[];
          if (query.trim()) {
            entries = await searchFiles(db, query.trim());
          } else {
            entries = await listFiles(db);
          }
          result = entries.map((e) => ({ name: e.current_path, firstLine: e.first_line }));
        } else {
          const entries = await readDir(dirPath);
          const mdFiles = entries
            .filter((e) => e.name?.endsWith('.md'))
            .map((e) => e.name!)
            .sort()
            .reverse();
          result = mdFiles.map((name) => ({ name }));
        }
        if (!cancelled) {
          setItems(result);
          setSelectedIndex(0);
        }
      } catch {
        if (!cancelled) {
          setItems([]);
          setSelectedIndex(0);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visible, dirPath, db, dbReady, query]);

  useEffect(() => {
    if (visible) {
      // Focus the input if available, otherwise the panel
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }, [visible]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleClose = useCallback(() => {
    setQuery('');
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[selectedIndex]) {
          onOpen(items[selectedIndex].name);
          handleClose();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    },
    [items, selectedIndex, onOpen, handleClose]
  );

  if (!visible) return null;

  return (
    <div className="fileopen-overlay" onClick={handleClose}>
      <div
        ref={panelRef}
        className="fileopen-panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <input
          ref={inputRef}
          className="fileopen-search"
          type="text"
          placeholder="検索..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {items.length === 0 ? (
          <div className="fileopen-empty">
            {query ? '見つかりません' : 'ファイルがありません'}
          </div>
        ) : (
          <div className="fileopen-list">
            {items.map((item, i) => (
              <div
                key={item.name}
                ref={i === selectedIndex ? selectedItemRef : null}
                className={`fileopen-item${i === selectedIndex ? ' fileopen-item--selected' : ''}`}
                onClick={() => { onOpen(item.name); handleClose(); }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <div className="fileopen-item-name">{item.name.replace(/\.md$/, '')}</div>
                {item.firstLine && (
                  <div className="fileopen-item-preview">{item.firstLine}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
