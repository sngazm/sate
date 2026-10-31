import { useState, useRef, useCallback, useEffect } from 'react';
import {
  readTextFile,
  readDir,
  mkdir,
  exists,
} from '@tauri-apps/plugin-fs';
import {
  type FileMetadata,
  type Memo,
  buildFrontMatter,
  parseFrontMatter,
  extractFirstLine,
} from '../lib/frontmatter';
import { upsertFile, updateSearchIndex, addSnapshot, deleteFile as deleteFileFromDb } from '../lib/db';
import { isWritable, setWritable, writeVaultFile, removeVaultFile } from '../lib/vaultWrite';

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
  const [title, setTitle] = useState<string | null>(null);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fileId, setFileId] = useState<string | null>(null);
  // Editor を強制再マウントするためのキー（Rewind 復元時などに使う）
  const [reloadKey, setReloadKey] = useState(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // fileName もref で持つ。オートセーブは setTimeout 経由で遅れて発火するため、
  // クロージャに古い fileName が残ったまま contentRef だけ新しい、という
  // 不整合な状態で保存される事故（開いたファイルの内容が元のファイルの
  // パスへ書き込まれてデータが消える）を防ぐ。保存時は常に ref から
  // 「いま」の fileName を読むことで、パスと内容の整合性を保証する。
  const fileNameRef = useRef<string | null>(fileName);
  const contentRef = useRef(content);
  const memosRef = useRef<Memo[]>(memos);
  const privateRef = useRef(isPrivate);
  const metadataRef = useRef<FileMetadata | null>(null);
  // ファイルを読み込んだ回数。読み込みが前後したとき、古いほうの結果で上書きしないために使う
  const loadSeqRef = useRef(0);

  fileNameRef.current = fileName;
  contentRef.current = content;
  memosRef.current = memos;
  privateRef.current = isPrivate;

  const applyFile = useCallback((name: string, metadata: FileMetadata | null, body: string) => {
    loadSeqRef.current += 1;
    setFileName(name);
    fileNameRef.current = name;
    setContent(body);
    contentRef.current = body;
    setTitle(metadata?.title ?? null);
    setMemos(metadata?.memos ?? []);
    memosRef.current = metadata?.memos ?? [];
    setIsPrivate(metadata?.private ?? false);
    privateRef.current = metadata?.private ?? false;
    setFileId(metadata?.uuid ?? null);
    metadataRef.current = metadata;
  }, []);

  const initFile = useCallback(async () => {
    const seq = loadSeqRef.current;
    const name = await getNextFileName(dirPath);
    // 名前を決めている間に別のファイルを受け取っていたら（起動直後のバトンなど）、そちらを残す
    if (seq !== loadSeqRef.current) return;
    loadSeqRef.current += 1;
    setFileName(name);
    fileNameRef.current = name;
    setContent('');
    contentRef.current = '';
    setTitle(null);
    setMemos([]);
    setIsPrivate(false);
    setFileId(null);
    metadataRef.current = null;
  }, [dirPath]);

  const saveFile = useCallback(async (force = false) => {
    // バトンを持っていなければ保存しない（src/lib/vaultWrite.ts）。メタデータも触らない
    if (!isWritable()) return;
    // クロージャではなく ref から読む（コメント参照: fileNameRef）
    const fileName = fileNameRef.current;
    if (!fileName) return;
    const currentContent = contentRef.current;
    // 空の新規は保存しない（空のファイルを作らない）。一度保存したファイルは、全部消したら空で保存する。
    // そうしないとディスクに消す前の本文が残り、読み直したとき（バイザーとの受け渡しなど）に復活する
    if (!currentContent && !force && !metadataRef.current) return;

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
          title: null,
          memos: memosRef.current,
          private: privateRef.current,
        };
        setFileId(metadataRef.current.uuid);
      } else {
        metadataRef.current = {
          ...metadataRef.current,
          updatedAt: now,
          memos: memosRef.current,
          private: privateRef.current,
        };
      }

      const fileContent = buildFrontMatter(metadataRef.current) + currentContent;
      const filePath = `${dirPath}/${fileName}`;
      if (!(await writeVaultFile(filePath, fileContent))) return;

      // --- DB 更新 ---
      // ファイル保存が成功したら、DB側も同期する。
      // DB がまだ初期化されてない場合は静かにスキップ（起動直後など）。
      try {
        const meta = metadataRef.current;
        const createdAt = Math.floor(new Date(meta.createdAt).getTime() / 1000);
        const updatedAt = Math.floor(new Date(meta.updatedAt).getTime() / 1000);
        const firstLine = extractFirstLine(currentContent);

        await upsertFile(meta.uuid, createdAt, updatedAt, meta.title, firstLine, fileName, meta.private);
        // プライベートなファイルは全文索引を作らない（検索対象外にする）
        await updateSearchIndex(meta.uuid, meta.private ? null : currentContent);
        await addSnapshot(meta.uuid, fileContent);
      } catch {
        // DB未初期化の場合はここに来る。ファイル保存自体は成功してるので問題なし
      }
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setIsSaving(false);
    }
  }, [dirPath]);

  const updateContent = useCallback(
    (newContent: string) => {
      setContent(newContent);
      contentRef.current = newContent;

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      // 空でも、一度保存したファイルなら保存する（saveFile のコメント参照）
      if (newContent || metadataRef.current) {
        saveTimerRef.current = setTimeout(() => {
          saveFile();
        }, 1500);
      }
    },
    [saveFile]
  );

  // 保留中のオートセーブがあれば今すぐ確定させる。オートセーブは入力が止まって 1.5 秒後なので、
  // 画面を隠したり手放したりする前に確定させないと、直前の入力が消える。
  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current) {
      await saveFile();
    }
  }, [saveFile]);

  // バトンを手放す（バイザーを出す・隠すとき）。保存を確定させてから保存を止める。
  // 戻り値は開いているファイル名。
  const releaseFile = useCallback(async () => {
    await flushPendingSave();
    setWritable(false);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    return fileNameRef.current;
  }, [flushPendingSave]);

  // バトンを受け取る。相手は保存を確定させてから手放すので、ディスクの内容がいちばん新しい。
  // 手元と同じ内容なら読み直さない（エディタを作り直すと取り消し履歴が消えるため）。
  // name が null なら自分のファイルのまま。戻り値は、読み直して作り直したかどうか。
  const acquireFile = useCallback(
    async (name: string | null) => {
      let reloaded = false;
      const target = name ?? fileNameRef.current;
      if (target) {
        try {
          const filePath = `${dirPath}/${target}`;
          const text = (await exists(filePath)) ? await readTextFile(filePath) : null;
          const disk = text === null ? null : parseFrontMatter(text);
          // フロントマターの書式の違いに左右されないよう、同じ書き出し方にそろえて比べる
          const serialize = (metadata: FileMetadata | null, body: string) =>
            (metadata ? buildFrontMatter(metadata) : '') + body;
          const unchanged =
            target === fileNameRef.current &&
            // ファイルが無いのは、まだ一度も保存していない新規のとき
            (disk === null || serialize(disk.metadata, disk.body) === serialize(metadataRef.current, contentRef.current));
          if (!unchanged) {
            applyFile(target, disk?.metadata ?? null, disk?.body ?? '');
            setReloadKey((k) => k + 1);
            reloaded = true;
          }
        } catch (err) {
          console.error('Failed to reload file:', err);
        }
      }
      setWritable(true);
      return reloaded;
    },
    [dirPath, applyFile],
  );

  const openFile = useCallback(
    async (name: string) => {
      // 保留中のオートセーブがあれば、切り替える前に「今のファイル」へ確定させる。
      // これをせずに内容を差し替えると、後からタイマーが発火したときに
      // 開いたファイルの内容が元のファイルへ書き込まれてしまう。
      // （直近 1.5 秒以内の編集が保存されないまま消える問題の防止も兼ねる）
      if (saveTimerRef.current) {
        await saveFile();
      }
      try {
        const filePath = `${dirPath}/${name}`;
        const text = await readTextFile(filePath);
        const { metadata, body } = parseFrontMatter(text);
        applyFile(name, metadata, body);
      } catch (err) {
        console.error('Failed to open file:', err);
      }
    },
    [dirPath, saveFile, applyFile]
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

  const updateTitle = useCallback(
    (newTitle: string | null) => {
      setTitle(newTitle);
      if (metadataRef.current) {
        metadataRef.current = { ...metadataRef.current, title: newTitle };
      }
      // タイトル変更もオートセーブ対象
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        saveFile();
      }, 1500);
    },
    [saveFile]
  );

  const updateMemos = useCallback(
    (newMemos: Memo[]) => {
      setMemos(newMemos);
      memosRef.current = newMemos;
      // メモ変更もオートセーブ対象
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => {
        saveFile();
      }, 1500);
    },
    [saveFile]
  );

  const deleteCurrentFile = useCallback(async () => {
    if (!fileName || !isWritable()) return;

    // 進行中のオートセーブはキャンセルする（削除後に書き戻されるのを防ぐ）
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    try {
      const filePath = `${dirPath}/${fileName}`;
      if (await exists(filePath)) {
        if (!(await removeVaultFile(filePath))) return;
      }
      const fileId = metadataRef.current?.uuid;
      if (fileId) {
        try {
          await deleteFileFromDb(fileId);
        } catch {
          // DB未初期化などは無視
        }
      }
    } catch (err) {
      console.error('Failed to delete file:', err);
      return;
    }

    await initFile();
  }, [fileName, dirPath, initFile]);

  const updatePrivate = useCallback(
    (next: boolean) => {
      setIsPrivate(next);
      privateRef.current = next;
      // プライベート状態の切り替えは即時反映したいので force 保存する。
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      saveFile(true);
    },
    [saveFile]
  );

  /**
   * スナップショット（フロントマター込みの全文）を現在のファイルに上書きする。
   *
   * 復元前の状態は呼び出し側で `saveFile(true)` 等で保存しておくこと。
   * メタデータ（uuid 等）は保ったまま、updatedAt のみ「今」に更新する。
   */
  const restoreSnapshot = useCallback(
    async (snapshotContent: string) => {
      if (!fileName || !isWritable()) return;
      const { metadata, body } = parseFrontMatter(snapshotContent);
      if (!metadata) return;

      // 進行中のオートセーブを止める（古い content で上書きされないように）
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      // 現在の uuid を保ったまま、updatedAt を「今」に。
      const currentUuid = metadataRef.current?.uuid ?? metadata.uuid;
      const restored: FileMetadata = {
        ...metadata,
        uuid: currentUuid,
        updatedAt: new Date().toISOString(),
      };

      metadataRef.current = restored;
      contentRef.current = body;
      memosRef.current = restored.memos;
      privateRef.current = restored.private;

      setContent(body);
      setTitle(restored.title);
      setMemos(restored.memos);
      setIsPrivate(restored.private);
      setFileId(restored.uuid);
      setReloadKey((k) => k + 1);

      try {
        await ensureDir(dirPath);
        const fileContent = buildFrontMatter(restored) + body;
        const filePath = `${dirPath}/${fileName}`;
        if (!(await writeVaultFile(filePath, fileContent))) return;

        try {
          const createdAt = Math.floor(new Date(restored.createdAt).getTime() / 1000);
          const updatedAt = Math.floor(new Date(restored.updatedAt).getTime() / 1000);
          const firstLine = extractFirstLine(body);
          await upsertFile(restored.uuid, createdAt, updatedAt, restored.title, firstLine, fileName, restored.private);
          await updateSearchIndex(restored.uuid, restored.private ? null : body);
          await addSnapshot(restored.uuid, fileContent);
        } catch {
          // DB 未初期化などは無視（ファイル本体は更新済み）
        }
      } catch (err) {
        console.error('Failed to restore snapshot:', err);
      }
    },
    [fileName, dirPath],
  );

  return {
    fileName,
    fileId,
    content,
    title,
    memos,
    isPrivate,
    isSaving,
    reloadKey,
    updateContent,
    updateTitle,
    updateMemos,
    updatePrivate,
    openFile,
    saveFile,
    flushPendingSave,
    releaseFile,
    acquireFile,
    initFile,
    deleteCurrentFile,
    restoreSnapshot,
  };
}
