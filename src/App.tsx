import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EditorComponent from './components/Editor';
import TitleInput from './components/TitleInput';
import WordCount from './components/WordCount';
import ShortcutHelp from './components/ShortcutHelp';
import SettingsDialog from './components/SettingsDialog';
import FileOpenDialog from './components/FileOpenDialog';
import FileHeader from './components/FileHeader';
import SideMemoLayer from './components/SideMemoLayer';
import RewindOverlay from './components/RewindOverlay';
import Timer from './components/Timer';
import FindBar, { type FindRequest } from './components/FindBar';
import { selectionAsQuery, stepSearch } from './components/searchPlugin';
import { useFile } from './hooks/useFile';
import { useSettings } from './hooks/useSettings';
import { usePublish } from './hooks/usePublish';
import { initDatabase, getSnapshots, type SnapshotRecord } from './lib/db';
import { reconcile } from './lib/reconcile';
import { parseFrontMatter, type Memo } from './lib/frontmatter';
import { diffLinesRich, cleanMarkdownForDisplay, type RichDiffLine } from './lib/diff';
import { Selection } from '@milkdown/prose/state';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_HOTKEY } from './lib/shortcut';
import { caretOf, restoreCaret, type Caret } from './lib/caret';
import { playDiveTransition } from './lib/diveTransition';
import './App.css';

// 1ステップ進める/戻すために必要なホイール累積量。trackpad の小刻みなイベントを
// 1スナップショット移動にまとめるための閾値。
const SCROLL_STEP_THRESHOLD = 50;

function App() {
  const { settings, loaded, updateSettings } = useSettings();
  const {
    fileName,
    fileId,
    content,
    title,
    memos,
    isPrivate,
    reloadKey,
    updateContent,
    updateTitle,
    updateMemos,
    updatePrivate,
    saveFile,
    flushPendingSave,
    openFile,
    initFile,
    deleteCurrentFile,
    restoreSnapshot,
  } = useFile(settings?.baseDir ?? '');
  const publish = usePublish(settings?.publishCommand, fileName, title, content);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFileOpen, setShowFileOpen] = useState(false);
  const [findRequest, setFindRequest] = useState<FindRequest | null>(null);

  // ---- Rewind state ----
  const [rewindActive, setRewindActive] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotRecord[]>([]);
  const [rewindIndex, setRewindIndex] = useState(0);
  const rewindActiveRef = useRef(false);
  rewindActiveRef.current = rewindActive;
  const rewindIndexRef = useRef(0);
  rewindIndexRef.current = rewindIndex;
  const snapshotsRef = useRef<SnapshotRecord[]>([]);
  snapshotsRef.current = snapshots;
  const wheelAccumRef = useRef(0);
  const fileIdRef = useRef<string | null>(null);
  fileIdRef.current = fileId;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const memosRef = useRef<Memo[]>(memos);
  memosRef.current = memos;
  const editorViewRef = useRef<import('@milkdown/prose/view').EditorView | null>(null);

  const charCount = useMemo(() => {
    if (!content) return 0;
    const paragraphs = content.split(/\n\n/);
    let count = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const text = paragraphs[i].replace(/<[^>]*>/g, '').replace(/\s/g, '');
      count += text.length;
      // 改段落と強制改行（行末スペース 2 つ）は 1 文字ずつ数える
      count += (paragraphs[i].match(/ {2}\n/g) ?? []).length;
      if (i < paragraphs.length - 1) count += 1;
    }
    return count;
  }, [content]);

  // 現在ビュー中のスナップショットの本文と、一つ前との diff を計算する
  const rewindView = useMemo(() => {
    if (!rewindActive || snapshots.length === 0) return null;
    const idx = Math.max(0, Math.min(rewindIndex, snapshots.length - 1));
    const curr = snapshots[idx];
    const { body: currBody } = parseFrontMatter(curr.content);
    const prevBody = idx > 0 ? parseFrontMatter(snapshots[idx - 1].content).body : '';
    // 装飾記号（**、<br /> 等）を剥がしてから diff することで、
    // プレビュー上で記号が可視化されないようにする。
    const lines: RichDiffLine[] = diffLinesRich(
      cleanMarkdownForDisplay(prevBody),
      cleanMarkdownForDisplay(currBody),
    );
    return { idx, lines };
  }, [rewindActive, rewindIndex, snapshots]);

  const exitRewind = useCallback(() => {
    setRewindActive(false);
    setSnapshots([]);
    setRewindIndex(0);
    wheelAccumRef.current = 0;
  }, []);

  const enterRewind = useCallback(async () => {
    const id = fileIdRef.current;
    if (!id) return;
    // 現状をスナップショットとして保存しておく（戻れるように）
    try {
      await saveFile(true);
    } catch {
      // 保存失敗は無視。スナップショット履歴での操作自体は続行
    }
    let snaps: SnapshotRecord[] = [];
    try {
      snaps = await getSnapshots(id);
    } catch {
      return;
    }
    if (snaps.length === 0) return;
    setSnapshots(snaps);
    setRewindIndex(snaps.length - 1); // 最新から開始
    setRewindActive(true);
    setFindRequest(null);
    wheelAccumRef.current = 0;
    // エディタからフォーカスを外して、矢印キー等が ProseMirror に流れないようにする
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [saveFile]);

  const stepRewind = useCallback((delta: number) => {
    setRewindIndex((idx) => {
      const total = snapshotsRef.current.length;
      if (total === 0) return idx;
      const next = Math.max(0, Math.min(total - 1, idx + delta));
      return next;
    });
  }, []);

  const commitRewind = useCallback(async () => {
    const idx = rewindIndexRef.current;
    const snaps = snapshotsRef.current;
    if (snaps.length === 0) {
      exitRewind();
      return;
    }
    const target = snaps[Math.max(0, Math.min(idx, snaps.length - 1))];
    await restoreSnapshot(target.content);
    exitRewind();
  }, [restoreSnapshot, exitRewind]);

  // モーダル（ファイルを開く / 設定 / ショートカット）を閉じたらエディタにフォーカスを戻す。
  // ProseMirror の選択範囲は state に残っているので、focus するだけでキャレット位置が復元される。
  // ファイルを開いた場合はエディタが作り直されて旧 view は破棄済みなので、ここでは触らない。
  const anyModalOpen = showFileOpen || showSettings || showShortcuts;
  const wasModalOpenRef = useRef(false);
  useEffect(() => {
    if (wasModalOpenRef.current && !anyModalOpen) {
      const view = editorViewRef.current;
      if (view && !view.isDestroyed) view.focus();
    }
    wasModalOpenRef.current = anyModalOpen;
  }, [anyModalOpen]);

  // mousedown が ProseMirror 内で始まったかを覚えておく。
  // 本文をドラッグ選択してテキストエリアの外でボタンを離すと、click イベントは
  // mousedown と mouseup の共通祖先（.editor-container 等）で発火し、target が
  // ProseMirror の外になる。それを「余白クリック」と誤認して選択を潰さないようにする。
  const pressStartedInEditorRef = useRef(false);
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    pressStartedInEditorRef.current = !!(e.target as HTMLElement).closest('.ProseMirror');
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (rewindActive) return;
    if (pressStartedInEditorRef.current) return;
    if (showShortcuts || showSettings) return;
    const target = e.target as HTMLElement;
    if (target.closest('.title-input')) return;
    // ProseMirror 内部のクリックは通常動作に任せる
    if (target.closest('.ProseMirror')) return;
    // 余白(padding 等)をクリックしたら、エディタより上なら先頭・下なら末尾にキャレット
    const view = editorViewRef.current;
    if (!view) return;
    const rect = (view.dom as HTMLElement).getBoundingClientRect();
    const atStart = e.clientY < rect.top;
    const selection = atStart
      ? Selection.atStart(view.state.doc)
      : Selection.atEnd(view.state.doc);
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
    view.focus();
  }, [showShortcuts, showSettings, rewindActive]);

  // Cmd を押しながらのホイールで Rewind モードに入る/移動する
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Shift + Cmd の同時押しのみで反応させる。
      // Cmd 単独だと、トラックパッドの慣性スクロール中に Cmd を押し下げた瞬間に
      // 誤発動してしまうため。Shift も要求することで意図的な操作に絞る。
      if (!e.metaKey || !e.shiftKey) {
        wheelAccumRef.current = 0;
        return;
      }
      // モーダルが開いてる時は無視
      if (showShortcuts || showSettings || showFileOpen) return;

      e.preventDefault();
      // まだ Rewind モードでなければ起動
      if (!rewindActiveRef.current) {
        enterRewind();
        return;
      }

      // マウスホイールは Shift を押していると macOS が縦スクロールを横（deltaX）に
      // 振り替えるので、deltaY が 0 のときは deltaX を使う（トラックパッドは deltaY のまま）
      wheelAccumRef.current += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      let steps = 0;
      while (wheelAccumRef.current >= SCROLL_STEP_THRESHOLD) {
        // 下スクロール = 未来へ進む
        steps += 1;
        wheelAccumRef.current -= SCROLL_STEP_THRESHOLD;
      }
      while (wheelAccumRef.current <= -SCROLL_STEP_THRESHOLD) {
        // 上スクロール = 過去へ戻る
        steps -= 1;
        wheelAccumRef.current += SCROLL_STEP_THRESHOLD;
      }
      if (steps !== 0) stepRewind(steps);
    };
    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [enterRewind, stepRewind, showShortcuts, showSettings, showFileOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Rewind モード中はキーバインドを横取り（編集はさせない）
      if (rewindActive) {
        if (e.key === 'Escape') { e.preventDefault(); exitRewind(); return; }
        if (e.key === 'Enter') { e.preventDefault(); commitRewind(); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); stepRewind(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); stepRewind(1); return; }
        // それ以外は誤入力を防ぐためデフォルト動作も止める
        if (!e.metaKey && !e.ctrlKey && e.key.length === 1) e.preventDefault();
        return;
      }
      if (e.metaKey && e.key === 's') { e.preventDefault(); saveFile(true); }
      if (e.metaKey && e.key === 'n') {
        e.preventDefault();
        if (content) {
          saveFile(true).then(() => {
            initFile();
            setTimeout(() => { (document.querySelector('.ProseMirror') as HTMLElement | null)?.focus(); }, 160);
          });
        }
      }
      if (e.metaKey && e.key === 'o') { e.preventDefault(); setShowFileOpen((v) => !v); }
      if (e.metaKey && e.key === 'f') {
        e.preventDefault();
        if (!showShortcuts && !showSettings && !showFileOpen) {
          // エディタで選択中のテキストがあれば検索語にする。
          // 検索欄にいるときに押し直した場合は、エディタに残っている古い選択で
          // 入力中のクエリを上書きしないよう、エディタにフォーカスがあるときだけ見る。
          const view = editorViewRef.current;
          const seed = view && !view.isDestroyed && view.hasFocus() ? selectionAsQuery(view.state) : '';
          setFindRequest((r) => ({ seq: (r?.seq ?? 0) + 1, seed }));
        }
      }
      if (e.metaKey && e.key.toLowerCase() === 'g' && findRequest) {
        e.preventDefault();
        stepSearch(editorViewRef.current, e.shiftKey ? -1 : 1);
      }
      if (e.metaKey && e.key === '/') { e.preventDefault(); setShowShortcuts((v) => !v); }
      // Cmd+W で隠す。枠の無いパネルは、メニューの「閉じる」（performClose）では閉じられない
      if (e.metaKey && e.key.toLowerCase() === 'w') { e.preventDefault(); invoke('hide_dive'); }
      if (e.metaKey && e.key === ',') { e.preventDefault(); setShowSettings((v) => !v); }
      if (e.key === 'Escape') {
        if (showSettings) { e.preventDefault(); setShowSettings(false); }
        else if (showShortcuts) { e.preventDefault(); setShowShortcuts(false); }
        else if (showFileOpen) { e.preventDefault(); setShowFileOpen(false); }
        else if (findRequest) { e.preventDefault(); setFindRequest(null); }
        // Esc で隠す。IME の変換を取り消す Esc は除く。WebKit は compositionend を
        // 先に投げるので、その Esc の isComposing は false になっている。IME が処理したキーは keyCode が 229
        else if (!e.isComposing && e.keyCode !== 229) { e.preventDefault(); invoke('hide_dive'); }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showShortcuts, showSettings, showFileOpen, findRequest, saveFile, initFile, content, rewindActive, exitRewind, commitRewind, stepRewind]);

  // ファイルが切り替わったら（新規含め）Rewind と文書内検索は強制終了
  useEffect(() => {
    exitRewind();
    setFindRequest(null);
  }, [fileName, exitRewind]);

  // ---- Sate の画面（Dive）の出し入れ（src-tauri/src/dive.rs） ----
  // 隠すときは保留中の保存を確定させ、フォーカスとキャレットを覚えておく。
  // 出たときは WebKit がフォーカスを先頭の入力欄（タイトル）へ移してしまい、さらにキー入力を受け取れるように
  // なる前に本文へフォーカスしていると、受け取れるようになった時点でキャレットが先頭へ戻される。
  // そこでキー入力を受け取れるようになってから、隠す前にフォーカスがあった所（はじめは本文）へ戻し、
  // 本文ならキャレットも隠す前の位置へ置き直す。クリックで受け取れるようになったときは、クリックした所を優先する
  const flushPendingSaveRef = useRef(flushPendingSave);
  useEffect(() => {
    flushPendingSaveRef.current = flushPendingSave;
  }, [flushPendingSave]);

  useEffect(() => {
    if (!loaded) return;
    let last: HTMLElement | null = null;
    let caret: Caret | null = null;
    let restorePending = false;
    const restore = () => {
      restorePending = false;
      const view = editorViewRef.current;
      if (last && last.isConnected && !(view && view.dom.contains(last))) {
        last.focus();
        return;
      }
      if (!view || view.isDestroyed) return;
      if (caret) restoreCaret(view, caret);
      view.focus();
    };
    const onFocus = () => {
      if (restorePending) restore();
    };
    window.addEventListener('focus', onFocus);
    // emit_to で送られたイベントだけを受けるため、ウィンドウの listen を使う
    const win = getCurrentWebviewWindow();
    const unlistenEnter = win.listen<number>('dive-enter', ({ payload: seq }) => {
      playDiveTransition(true);
      // 2 回目の requestAnimationFrame の時点で 1 コマは描けている。それまでパネルは透明（dive.rs の dive_ready）
      requestAnimationFrame(() => requestAnimationFrame(() => invoke('dive_ready', { seq }).catch(() => {})));
      restorePending = true;
      // すでにキー入力を受け取れるようになっていれば、focus は来ない
      if (document.hasFocus()) restore();
    });
    const unlistenExit = win.listen<number>('dive-exit', ({ payload: seq }) => {
      const el = document.activeElement;
      // どこにもフォーカスが無かった（body）なら、戻すときは本文へ
      last = el instanceof HTMLElement && el !== document.body ? el : null;
      const view = editorViewRef.current;
      caret = view && !view.isDestroyed ? caretOf(view) : null;
      flushPendingSaveRef.current();
      // 消える演出が最後まで流れたら、パネルを画面から外してもらう
      playDiveTransition(false).then((done) => {
        if (done) invoke('dive_exit_done', { seq }).catch(() => {});
      });
    });
    // 聞けるようになったら知らせる。起動時はそこで初めて出る
    Promise.all([unlistenEnter, unlistenExit]).then(() => invoke('dive_attach').catch(() => {}));
    return () => {
      window.removeEventListener('focus', onFocus);
      unlistenEnter.then((f) => f());
      unlistenExit.then((f) => f());
    };
  }, [loaded]);

  // ウィンドウを閉じる操作でも、閉じずに隠す（閉じるとホットキーや Dock で出せなくなる）
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      invoke('hide_dive');
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Sate を開閉するホットキーを登録する（設定が変わったら登録し直す）。オフなら外す（src/lib/shortcut.ts）
  const hotkey = settings?.hotkeyEnabled ? (settings.hotkey ?? DEFAULT_HOTKEY) : null;
  useEffect(() => {
    if (!loaded) return;
    invoke('set_hotkey', { hotkey }).catch((err) => console.error('Failed to register hotkey:', err));
  }, [loaded, hotkey]);

  useEffect(() => {
    if (!loaded || !settings) return;
    initDatabase(settings.baseDir)
      .then(() => reconcile(settings.baseDir))
      .catch((err) => console.error('Failed to init DB:', err));
  }, [loaded, settings]);

  if (!loaded || !settings) return null;

  return (
    <div className="app" onClick={handleClick} onMouseDown={handleMouseDown}>
      <div className="editor-container" ref={editorContainerRef}>
        <div className="editor-wrapper">
          <TitleInput key={`title-${fileName}-${reloadKey}`} value={title} onChange={updateTitle} editorViewRef={editorViewRef} />
          <EditorComponent
            key={`${fileName}-${reloadKey}`}
            initialContent={content}
            onChange={updateContent}
            memosRef={memosRef}
            memos={memos}
            onMemosChange={updateMemos}
            editorViewRef={editorViewRef}
            containerRef={editorContainerRef}
          />
        </div>
        <SideMemoLayer
          key={`memos-${fileName}-${reloadKey}`}
          memos={memos}
          onChange={updateMemos}
          editorViewRef={editorViewRef}
        />
      </div>
      {fileName && !rewindActive && (
        <FileHeader
          fileName={fileName}
          isPrivate={isPrivate}
          onTogglePrivate={updatePrivate}
          onDelete={deleteCurrentFile}
          publishConfigured={publish.configured}
          publishBusy={publish.busy}
          onPublish={publish.publish}
        />
      )}
      {!rewindActive && <WordCount count={charCount} />}
      {!rewindActive && <Timer />}
      <FindBar
        request={findRequest}
        editorViewRef={editorViewRef}
        onClose={() => setFindRequest(null)}
      />
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
      {rewindActive && rewindView && (
        <RewindOverlay
          snapshots={snapshots}
          currentIndex={rewindView.idx}
          diffLines={rewindView.lines}
          onSelect={(i) => setRewindIndex(i)}
        />
      )}
    </div>
  );
}

export default App;
