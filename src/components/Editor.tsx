import { useRef } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark, codeBlockKeymap } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { useEditor, Milkdown, MilkdownProvider } from '@milkdown/react';
import { ProsemirrorAdapterProvider } from '@prosemirror-adapter/react';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { splitBlock } from '@milkdown/prose/commands';

interface EditorComponentProps {
  onChange?: (markdown: string) => void;
  initialContent?: string;
  readOnly?: boolean;
}

// Shift+Enter を通常のEnter（段落分割）と同じにする
const shiftEnterAsSplitPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('shift-enter-as-split'),
    props: {
      handleKeyDown(view, event) {
        if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
          return splitBlock(view.state, view.dispatch);
        }
        return false;
      },
    },
  });
});

// コピー時のプレーンテキストを段落ごとに改行1つで区切る（デフォルトは\n\n）
const clipboardTextSerializerPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('clipboard-text-serializer'),
    props: {
      clipboardTextSerializer(slice) {
        return slice.content.textBetween(0, slice.content.size, '\n');
      },
    },
  });
});

// テキスト選択のハイライトをカスタムデコレーションで描画
const selectionHighlightPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('selection-highlight'),
    props: {
      decorations(state) {
        const { from, to } = state.selection;
        if (from === to) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.inline(from, to, {
            class: 'sate-selection',
            style: 'background-color: #555048;',
          }),
        ]);
      },
    },
  });
});

function MilkdownEditor({ onChange, initialContent = '', readOnly = false }: EditorComponentProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const readOnlyPlugin = $prose(() => {
    return new Plugin({
      key: new PluginKey('read-only'),
      props: {
        editable: () => !readOnly,
      },
    });
  });

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, initialContent);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChangeRef.current?.(markdown);
        });
      })
      .use(commonmark)
      .use(history)
      .use(listener)
      .use(shiftEnterAsSplitPlugin)
      .use(selectionHighlightPlugin)
      .use(clipboardTextSerializerPlugin)
      .use(readOnlyPlugin)
      .config((ctx) => {
        ctx.set(codeBlockKeymap.key, {
          CreateCodeBlock: { shortcuts: '' },
        });
      }),
    []
  );

  return <Milkdown />;
}

export default function EditorComponent({ onChange, initialContent, readOnly }: EditorComponentProps) {
  return (
    <MilkdownProvider>
      <ProsemirrorAdapterProvider>
        <MilkdownEditor onChange={onChange} initialContent={initialContent} readOnly={readOnly} />
      </ProsemirrorAdapterProvider>
    </MilkdownProvider>
  );
}
