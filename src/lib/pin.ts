// Private な文章を開くときの PIN（spec/private.md）。
// settings.json には PIN そのものではなく、ソルト付きのハッシュ（PBKDF2-SHA256）だけを置く。
// 間違って表示されるのを防ぐための鍵なので、総当たりには備えていない（数字 4 桁なら一瞬で総当たりできる）。
// ハッシュにしているのは、settings.json を開いたときに PIN が目に入らないようにするため

export interface StoredPin {
  salt: string; // base64
  hash: string; // base64
}

/** PIN は数字 4 桁 */
export const PIN_LENGTH = 4;
const ITERATIONS = 100_000;

/** 入力欄に打たれたものを PIN として使える形にする。全角の数字は半角にし、数字以外は捨て、4 桁で切る */
export function sanitizePinInput(input: string): string {
  return input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
    .slice(0, PIN_LENGTH);
}

export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/**
 * PIN の入力欄の placeholder。PIN が決まっていれば丸を並べて、言葉なしで設定済みと分かるようにする。
 * WebKit がパスワード欄の文字の代わりに描く丸（U+2022）と同じ字にして、打った丸と大きさをそろえる
 */
export const PIN_SET_MARK = '\u2022'.repeat(PIN_LENGTH);

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: toBase64(salt), hash: toBase64(await derive(pin, salt)) };
}

export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  try {
    return toBase64(await derive(pin, fromBase64(stored.salt))) === stored.hash;
  } catch {
    return false;
  }
}
