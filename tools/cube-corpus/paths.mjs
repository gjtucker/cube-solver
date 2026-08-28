// Shared paths, so every stage agrees on where the corpus lives.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const CORPUS = join(ROOT, 'corpus');
export const RAW = join(CORPUS, 'raw');          // committable originals
export const LOCAL = join(CORPUS, 'local');      // CC BY / BY-SA originals, gitignored
export const FACES = join(CORPUS, 'faces');      // rectified face crops (committed)
export const FACES_JSON = join(CORPUS, 'faces.json');
export const INDEX_JSON = join(CORPUS, 'index.json');
