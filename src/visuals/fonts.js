import { registerFont } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Palic card typography (both fonts are SIL OFL, licences in assets/fonts):
//   PalicSerif = DM Serif Display  (titles and the big numbers)
//   PalicMono  = IBM Plex Mono 500/600 (labels and figures)
// When a file is missing the canvas falls back to the system serif / monospace
// (see the stacks in theme.js), so rendering never fails.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.PALIC_FONT_DIR || path.join(projectRoot, 'assets', 'fonts');

const FILES = [
  { file: 'DMSerifDisplay-Regular.ttf', family: 'PalicSerif' },
  { file: 'IBMPlexMono-Medium.ttf', family: 'PalicMono', weight: '500' },
  { file: 'IBMPlexMono-SemiBold.ttf', family: 'PalicMono', weight: '600' },
];

let registered = false;

export function registerCardFonts() {
  if (registered) return;
  registered = true;
  for (const { file, family, weight } of FILES) {
    const full = path.join(DIR, file);
    try {
      if (fs.existsSync(full)) registerFont(full, weight ? { family, weight } : { family });
    } catch (err) {
      console.log(`[fonts] ${family} not registered: ${err.message}`);
    }
  }
}
