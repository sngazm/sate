import { useState, useRef, useCallback, useEffect } from 'react';
import {
  writeTextFile,
  readTextFile,
  readDir,
} from '@tauri-apps/plugin-fs';
import type { FileMetadata } from '../lib/fileUtils';
import { ensureDir, buildFrontMatter, parseFrontMatter, getFirstLine } from '../lib/fileUtils';
import { getDb, isFts5Supported } from '../lib/db';

function generateDatePrefix(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function getNextFileName(dirPath: string): Promise<string> {
  const datePrefix = generateDatePrefix();

  try {
    await ensureDir(dirPath);

    const entries = await readDir(dirPath);
    const todayFiles = entries
      .filter((e) => e.name?.startsWith(datePrefix) && e.name?.endsWith('.md'))
      .map((e) => e.name!)
      .sort();

    let nextNum = 1;
    if (todayFiles.length > 0) {
      const lastFile = todayFiles[todayFiles.length - 1];
      const match = lastFile.match(/-(\d{3})\.md$/);
      if (match) {
        nextNum = parseInt(match[1], 10) + 1;
      }
    }

    const numStr = String(nextNum).padStart(3, '0');
    return `${datePrefix}-${numStr}.md`;
  } catch {
    return `${datePrefix}-001.md`;
  }
}

export function useFile(dirPath: string) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const metadataRef = useRef<FileMetadata | null>(null);

  contentRef.current = content;

  const initFile = useCallback(async () => {
    const name = await getNextFileName(dirPath);
    setFileName(name);
    setContent('');
    metadataRef.current = null;
  }, [dirPath]);

  const saveFile = useCallback(async (force = false) => {
    if (!fileName) return;
    const currentContent = contentRef.current;
    if (!currentContent && !force) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    setIsSaving(true);
    try {
      await ensureDir(dirPath);

      const now = new Date().toISOString();
      if (!metadataRef.current) {
        metadataRef.current = {
          uuid: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
      } else {
        metadataRef.current = { ...metadataRef.current, updatedAt: now };
      }

      const fileContent = buildFrontMatter(metadataRef.current) + currentContent;
      const filePath = `${dirPath}/${fileName}`;
      await writeTextFile(filePath, fileContent);

      // Sync to DB (fire-and-forget, don't block save)
      const meta = metadataRef.current;
      const db = getDb();
      if (db && meta) {
        const firstLine = getFirstLine(currentContent);
        const ts = new Date(meta.updatedAt).getTime();
        const createdTs = new Date(meta.createdAt).getTime();
        try {
          await db.execute(
            `INSERT INTO files (file_id, created_at, updated_at, first_line, current_path)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT(file_id) DO UPDATE SET
               updated_at = $3, first_line = $4, current_path = $5`,
            [meta.uuid, createdTs, ts, firstLine, fileName]
          );

          // Update search index
          if (isFts5Supported()) {
            await db.execute('DELETE FROM search_index WHERE file_id = $1', [meta.uuid]);
            await db.execute('INSERT INTO search_index (file_id, content) VALUES ($1, $2)', [meta.uuid, currentContent]);
          } else {
            await db.execute('UPDATE files SET content_cache = $1 WHERE file_id = $2', [currentContent, meta.uuid]);
          }
        } catch (dbErr) {
          console.error('DB sync failed:', dbErr);
        }
      }
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setIsSaving(false);
    }
  }, [fileName, dirPath]);

  const updateContent = useCallback(
    (newContent: string) => {
      setContent(newContent);
      contentRef.current = newContent;

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      if (newContent) {
        saveTimerRef.current = setTimeout(() => {
          saveFile();
        }, 3000);
      }
    },
    [saveFile]
  );

  const openFile = useCallback(
    async (name: string) => {
      try {
        const filePath = `${dirPath}/${name}`;
        const text = await readTextFile(filePath);
        const { metadata, body } = parseFrontMatter(text);
        setFileName(name);
        setContent(body);
        metadataRef.current = metadata;
      } catch (err) {
        console.error('Failed to open file:', err);
      }
    },
    [dirPath]
  );

  useEffect(() => {
    initFile();
  }, [initFile]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  return {
    fileName,
    content,
    isSaving,
    updateContent,
    openFile,
    saveFile,
    initFile,
    metadataRef,
    contentRef,
  };
}
