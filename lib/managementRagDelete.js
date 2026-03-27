/**
 * Remove management-vector rows for a project file name (used on DELETE /files).
 * @param {object|null} rag - ragService instance
 * @param {string} originalName
 */
export async function deleteManagementVectorByFilename(rag, originalName) {
  const name = String(originalName || '').trim();
  if (!rag?.vectorStore || !name) return;
  await rag.vectorStore.deleteDocuments(null, { filename: name });
}
