/**
 * Text chunking for RAG (management system)
 */
export default class TextChunker {
  constructor(chunkSize = 1000, chunkOverlap = 200) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  chunkText(text, metadata, chunkSize = null, chunkOverlap = null) {
    if (!text || !text.trim()) return [];
    const size = chunkSize || this.chunkSize;
    const overlap = chunkOverlap || this.chunkOverlap;
    const cleaned = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const paragraphs = cleaned.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

    const chunks = [];
    let current = '';
    let idx = 0;
    for (const para of paragraphs) {
      if (current.length + para.length + 1 > size && current) {
        chunks.push({ text: current.trim(), metadata: { ...metadata, chunk_index: idx, chunk_size: current.length } });
        idx++;
        const overlapText = overlap > 0 && current.length > overlap ? current.slice(-overlap) : '';
        current = overlapText ? overlapText + '\n' + para : para;
      } else {
        current = current ? current + '\n' + para : para;
      }
    }
    if (current.trim()) {
      chunks.push({ text: current.trim(), metadata: { ...metadata, chunk_index: idx, chunk_size: current.length } });
    }
    if (chunks.length === 0 && text) {
      chunks.push({ text, metadata: { ...metadata, chunk_index: 0, chunk_size: text.length } });
    }
    return chunks;
  }
}
