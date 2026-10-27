/**
 * 行単位 + 文字単位の二段 diff（LCS ベース）。
 *
 * Rewind モードで「あるスナップショットと一つ前のスナップショット」の差分を
 * 視覚化するために使う。まず行単位で LCS を取り、削除と追加が連続する
 * ブロックは「同じ行が編集された」とみなして文字単位で再 diff する。
 * これで「数文字だけ書き換えた」場面でも、変わった文字だけが光るようになる。
 *
 * 大きすぎる文書では計算量が爆発するので、上限を超えたら diff を諦めて
 * すべて `same` として返す（光る演出は出ないがクラッシュはしない）。
 */

export type DiffTag = 'same' | 'added' | 'removed';

export interface DiffLine {
  text: string;
  tag: DiffTag;
}

export interface DiffSegment {
  text: string;
  tag: DiffTag;
}

/**
 * 1 行ぶんの差分。`segments` には複数のタグが混ざりうる（例: 「同じ部分」+
 * 「追加された部分」+ 「削除された部分」）。レンダリング側で
 * `removed` セグメントを非表示にすれば、その行は新版相当の見た目になる。
 */
export interface RichDiffLine {
  segments: DiffSegment[];
}

const MAX_LINES = 2000;
// 1 行の文字数がこれを超えるペアは文字 diff せず、行単位の追加/削除のまま扱う。
// O(m*n) の計算量を抑えるための上限。
const MAX_CHARS_FOR_PAIRING = 1500;

/**
 * Rewind プレビュー用に Markdown 的な「装飾用記号」を剥がす。
 *
 * Milkdown は本文を CommonMark として保存するので、太字なら `**...**`、
 * 古いファイルの空段落なら `<br />` といった「素のままだとノイズになる記号」が
 * テキストに混じる。本格的にレンダリングするのは重いので、目立つやつだけ
 * 取り除いて読みやすくする。装飾の見た目（太字表示など）は再現されない。
 */
export function cleanMarkdownForDisplay(text: string): string {
  return text
    // <br /> <br/> <br> を空白に置き換え（過去のスナップショットに残る空段落）
    .replace(/<br\s*\/?>/gi, ' ')
    // 強調記号（** ~~ __）を除去
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/~~/g, '')
    // インラインコード `code` はバッククォートだけ落として中身を残す
    .replace(/`([^`]+)`/g, '$1');
}

export function diffLines(prev: string, curr: string): DiffLine[] {
  const a = prev.split('\n');
  const b = curr.split('\n');
  const m = a.length;
  const n = b.length;

  if (m > MAX_LINES || n > MAX_LINES) {
    return b.map((text) => ({ text, tag: 'same' }));
  }

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ text: b[j], tag: 'same' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ text: a[i], tag: 'removed' });
      i++;
    } else {
      result.push({ text: b[j], tag: 'added' });
      j++;
    }
  }
  while (i < m) result.push({ text: a[i++], tag: 'removed' });
  while (j < n) result.push({ text: b[j++], tag: 'added' });
  return result;
}

/**
 * 文字単位の LCS diff。同じタグが連続するセグメントはまとめて返す。
 * サロゲートペア（絵文字など）も Array.from で 1 文字として扱う。
 */
function diffChars(a: string, b: string): DiffSegment[] {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const m = aa.length;
  const n = bb.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ text: b, tag: 'added' }];
  if (n === 0) return [{ text: a, tag: 'removed' }];

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aa[i] === bb[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const segs: DiffSegment[] = [];
  const push = (tag: DiffTag, ch: string) => {
    const last = segs[segs.length - 1];
    if (last && last.tag === tag) last.text += ch;
    else segs.push({ text: ch, tag });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aa[i] === bb[j]) { push('same', bb[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('removed', aa[i]); i++; }
    else { push('added', bb[j]); j++; }
  }
  while (i < m) push('removed', aa[i++]);
  while (j < n) push('added', bb[j++]);
  return segs;
}

/**
 * 行 diff の結果を見て、削除→追加が連続するブロックを「同じ行を編集した」
 * とみなして 1 対 1 でペアリングし、文字単位の diff に置き換える。
 * 余ったぶん（削除のほうが多い、追加のほうが多い）はそのまま行レベルの
 * 削除/追加として残す。
 */
export function diffLinesRich(prev: string, curr: string): RichDiffLine[] {
  const lines = diffLines(prev, curr);
  const result: RichDiffLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.tag === 'same') {
      result.push({ segments: [{ text: line.text, tag: 'same' }] });
      i++;
      continue;
    }
    if (line.tag === 'removed') {
      // removed が並んだあと、続けて added が並ぶブロックを集める
      const removeds: string[] = [];
      const addeds: string[] = [];
      while (i < lines.length && lines[i].tag === 'removed') { removeds.push(lines[i].text); i++; }
      while (i < lines.length && lines[i].tag === 'added') { addeds.push(lines[i].text); i++; }

      const pairCount = Math.min(removeds.length, addeds.length);
      for (let k = 0; k < pairCount; k++) {
        const a = removeds[k];
        const b = addeds[k];
        if (a.length > MAX_CHARS_FOR_PAIRING || b.length > MAX_CHARS_FOR_PAIRING) {
          result.push({ segments: [{ text: a, tag: 'removed' }] });
          result.push({ segments: [{ text: b, tag: 'added' }] });
        } else {
          result.push({ segments: diffChars(a, b) });
        }
      }
      for (let k = pairCount; k < removeds.length; k++) {
        result.push({ segments: [{ text: removeds[k], tag: 'removed' }] });
      }
      for (let k = pairCount; k < addeds.length; k++) {
        result.push({ segments: [{ text: addeds[k], tag: 'added' }] });
      }
      continue;
    }
    // added 単独（直前に removed がないケース）
    result.push({ segments: [{ text: line.text, tag: 'added' }] });
    i++;
  }

  return result;
}
