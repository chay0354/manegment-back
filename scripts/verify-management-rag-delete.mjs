/**
 * Ensures DELETE /files uses managementRagDelete helper (vector rows removed by filename).
 */
import assert from 'node:assert/strict';
import { deleteManagementVectorByFilename } from '../lib/managementRagDelete.js';

let calls = 0;
const rag = {
  vectorStore: {
    deleteDocuments: async (_id, meta) => {
      calls++;
      assert.equal(meta.filename, 'Report.pdf');
    }
  }
};

await deleteManagementVectorByFilename(rag, 'Report.pdf');
assert.equal(calls, 1);

await deleteManagementVectorByFilename(null, 'Report.pdf');
await deleteManagementVectorByFilename(rag, '');
assert.equal(calls, 1);

console.log('verify-management-rag-delete: OK');
