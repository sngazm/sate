import { mkdir, exists } from '@tauri-apps/plugin-fs';

export interface FileMetadata {
  uuid: string;
  createdAt: string;
  updatedAt: string;
}

export async function ensureDir(dirPath: string): Promise<void> {
  const dirExists = await exists(dirPath);
  if (!dirExists) {
    await mkdir(dirPath, { recursive: true });
  }
}

export function buildFrontMatter(meta: FileMetadata): string {
  return `---\nuuid: ${meta.uuid}\ncreated: ${meta.createdAt}\nupdated: ${meta.updatedAt}\n---\n\n`;
}

export function parseFrontMatter(fileContent: string): { metadata: FileMetadata | null; body: string } {
  if (!fileContent.startsWith('---\n')) {
    return { metadata: null, body: fileContent };
  }
  const end = fileContent.indexOf('\n---\n', 4);
  if (end === -1) {
    return { metadata: null, body: fileContent };
  }
  const fm = fileContent.slice(4, end);
  const rest = fileContent.slice(end + 5);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;

  const uuidMatch = fm.match(/^uuid:\s*(.+)$/m);
  const createdMatch = fm.match(/^created:\s*(.+)$/m);
  const updatedMatch = fm.match(/^updated:\s*(.+)$/m);

  if (!uuidMatch || !createdMatch || !updatedMatch) {
    return { metadata: null, body: fileContent };
  }

  return {
    metadata: {
      uuid: uuidMatch[1].trim(),
      createdAt: createdMatch[1].trim(),
      updatedAt: updatedMatch[1].trim(),
    },
    body,
  };
}

export function getFirstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0);
  return line?.trim() ?? '';
}
