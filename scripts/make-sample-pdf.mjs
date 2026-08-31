/**
 * Generate dev/sample.pdf — a fixture for manual and automated checks.
 * Page 3 is rotated 90° on purpose: page rotation is where annotation
 * placement math most easily goes wrong.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const specs = [
  { title: 'Page 1 — Letter, upright', size: [612, 792], rotate: 0 },
  { title: 'Page 2 — A4, upright', size: [595, 842], rotate: 0 },
  { title: 'Page 3 — Letter, rotated 90', size: [612, 792], rotate: 90 },
];

specs.forEach((spec, i) => {
  const page = doc.addPage(spec.size);
  if (spec.rotate) page.setRotation(degrees(spec.rotate));
  const { width, height } = page.getSize();

  page.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: rgb(0.93, 0.95, 0.99) });
  page.drawText(spec.title, { x: 42, y: height - 46, size: 18, font: bold, color: rgb(0.1, 0.15, 0.3) });

  // Corner ticks — make it obvious if an annotation lands in the wrong corner.
  for (const [x, y, label] of [
    [24, height - 24, 'TL'],
    [width - 46, height - 24, 'TR'],
    [24, 18, 'BL'],
    [width - 46, 18, 'BR'],
  ]) {
    page.drawText(label, { x, y, size: 10, font, color: rgb(0.7, 0.2, 0.2) });
  }

  for (let l = 0; l < 14; l++) {
    page.drawText(
      `Line ${l + 1} — the quick brown fox jumps over the lazy dog. Sign here: ______________`,
      { x: 42, y: height - 120 - l * 26, size: 11, font, color: rgb(0.25, 0.27, 0.32) },
    );
  }
  page.drawText(`${i + 1} / ${specs.length}`, { x: width / 2 - 12, y: 30, size: 10, font, color: rgb(0.5, 0.5, 0.55) });
});

mkdirSync(new URL('../dev/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dev/sample.pdf', import.meta.url), await doc.save());
console.log('  dev/sample.pdf');
