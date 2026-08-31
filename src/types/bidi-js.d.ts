/**
 * Minimal typings for bidi-js (the package ships none).
 * Only the surface this project uses is declared.
 */
declare module 'bidi-js' {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }

  export interface Bidi {
    /** Resolve Unicode Bidi embedding levels for a paragraph. */
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    /** Reference visual reordering (rule L2 applied to characters). */
    getReorderedString(text: string, embeddingLevels: EmbeddingLevels): string;
    getReorderedIndices(text: string, embeddingLevels: EmbeddingLevels): number[];
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    /** Rule L4 mirroring; null when the character has no mirrored form. */
    getMirroredCharacter(char: string): string | null;
  }

  export default function bidiFactory(): Bidi;
}
