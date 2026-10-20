/**
 * 空段落（空行）の保存形式の変換。
 *
 * Milkdown は空段落を `<br />` という HTML として Markdown に書き出す
 * （そうしないと Markdown では連続する空行が 1 つに潰れて消えてしまうため）。
 * ファイルに `<br />` が並ぶのは見た目が悪いので、Sate では空段落を
 * 「余分な空行」として保存する。
 *
 * - 段落と段落の間: 空行 1 つが通常の区切り。2 つ目以降の空行 1 つにつき空段落 1 つ
 * - 文書の先頭: 空行 1 つにつき空段落 1 つ
 * - 文書の末尾: 最後の改行に続く空行 1 つにつき空段落 1 つ
 *
 * エディタに渡す前に `<br />` 形式へ戻し、エディタから受け取った直後に
 * 空行形式へ変換する。エディタの外（ファイル・スナップショット・検索・公開）は
 * 空行形式だけを扱う。過去に `<br />` のまま保存されたファイルもそのまま読める。
 */

const BR = '<br />';
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 行ごとに、フェンス付きコードブロックの中（開始・終了行を含む）かどうかを返す */
function fencedLines(lines: string[]): boolean[] {
  const result: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence) {
      result.push(true);
      const m = line.match(FENCE);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
        fence = null;
      }
      continue;
    }
    const m = line.match(FENCE);
    if (m) fence = m[1];
    result.push(!!m);
  }
  return result;
}

/** 空行形式 → Milkdown が読める `<br />` 形式 */
export function toEditorMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (fenced[i] || !isBlank(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && !fenced[end] && isBlank(lines[end])) end++;
    const count = end - i;
    const atStart = i === 0;
    const next = lines[end];
    // インデントされた行（リストの続き・インデントコード）の前は触らない。
    // 文末は最後の改行のぶんの空要素があるので、段落間と同じく 1 つ引く
    const convertible = next === undefined || !/^\s/.test(next);
    const empties = convertible ? (atStart ? count : count - 1) : 0;
    if (empties <= 0) {
      out.push(...lines.slice(i, end));
    } else {
      if (!atStart) out.push('');
      for (let k = 0; k < empties; k++) out.push(BR, '');
    }
    i = end;
  }
  return out.join('\n');
}

/** Milkdown が書き出した `<br />` 形式 → 空行形式 */
export function fromEditorMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isEmptyParagraph =
      !fenced[i] &&
      lines[i] === BR &&
      (i === 0 || isBlank(lines[i - 1])) &&
      (i + 1 >= lines.length || isBlank(lines[i + 1]));
    if (isEmptyParagraph) {
      // `<br />` 行とその後ろの区切りの空行を、空行 1 つにまとめる
      out.push('');
      if (i + 1 < lines.length) i++;
      continue;
    }
    // 段落先頭の強制改行は行末スペース 2 つだけの行になる。Markdown では空行と
    // 同じ扱いなので、見えない空白を残さず空行にする
    out.push(!fenced[i] && isBlank(lines[i]) ? '' : lines[i]);
  }
  return out.join('\n');
}
