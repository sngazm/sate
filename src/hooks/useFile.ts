import { useState, useRef, useCallback, useEffect } from 'react';
import {
  writeTextFile,
  readTextFile,
  readDir,
  mkdir,
  exists,
} from '@tauri-apps/plugin-fs';
import { type FileMetadata, buildFrontMatter, parseFrontMatter, extractFirstLine } from '../lib/frontmatter';
import { upsertFile, updateSearchIndex, addSnapshot } from '../lib/db';

function generateDatePrefix(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function ensureDir(dirPath: string): Promise<void> {
  const dirExists = await exists(dirPath);
  if (!dirExists) {
    await mkdir(dirPath, { recursive: true });
  }
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
  const [fileId, setFileId] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const metadataRef = useRef<FileMetadata | null>(null);

  contentRef.current = content;

  const initFile = useCallback(async () => {
    const name = await getNextFileName(dirPath);
    setFileName(name);
    setContent('');
    setFileId(null);
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
        const uuid = crypto.randomUUID();
        metadataRef.current = {
          uuid,
          createdAt: now,
          updatedAt: now,
          title: null,
        };
        setFileId(uuid);
      } else {
        metadataRef.current = { ...metadataRef.current, updatedAt: now };
      }

      const fileContent = buildFrontMatter(metadataRef.current) + currentContent;
      const filePath = `${dirPath}/${fileName}`;
      await writeTextFile(filePath, fileContent);

      // --- DB 更新 ---
      // ファイル保存が成功したら、DB側も同期する。
      // DB がまだ初期化されてない場合は静かにスキップ（起動直後など）。
      try {
        const meta = metadataRef.current;
        const createdAt = Math.floor(new Date(meta.createdAt).getTime() / 1000);
        const updatedAt = Math.floor(new Date(meta.updatedAt).getTime() / 1000);
        const firstLine = extractFirstLine(currentContent);

        await upsertFile(meta.uuid, createdAt, updatedAt, meta.title, firstLine, fileName);
        await updateSearchIndex(meta.uuid, currentContent);
        await addSnapshot(meta.uuid, fileContent);
      } catch {
        // DB未初期化の場合はここに来る。ファイル保存自体は成功してるので問題なし
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
        }, 1500);
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
        setFileId(metadata?.uuid ?? null);
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
    fileId,
    content,
    isSaving,
    updateContent,
    openFile,
    saveFile,
    initFile,
  };
}
