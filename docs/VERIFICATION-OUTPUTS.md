# Verification Outputs – Research Intelligence & Scope

סטטוס אימות: analysis endpoints, import/sharepoint-file, sync/experiments, validation, schema `decision_audit_log`.

---

## 1. Analysis endpoints (curl)

Replace `BASE`, `PROJECT_ID`, and `TOKEN` (Bearer).

```bash
# Contradictions
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/contradictions"

# Failure patterns
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/failure-patterns"

# Research snapshot (optional: ?research_session_id=UUID)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/research-snapshot"

# Formula validate (body: formula, domain, materials, percentages)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"formula":"A+B","domain":"paints","materials":["A","B"],"percentages":{"A":60,"B":40}}' \
  "$BASE/api/projects/$PROJECT_ID/analysis/formula-validate"

# Formulation intelligence (cached by input_hash)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"formula":"A+B","domain":"paints","materials":["A","B"],"percentages":{"A":60,"B":40}}' \
  "$BASE/api/projects/$PROJECT_ID/analysis/formulation-intelligence"

# Similar experiments (required: experiment_id; optional: experiment_outcome, material_pct_min, material_pct_max)
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/projects/$PROJECT_ID/analysis/similar-experiments?experiment_id=EXP_ID"
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/projects/$PROJECT_ID/analysis/similar-experiments?experiment_id=EXP_ID&experiment_outcome=success&material_pct_min=10&material_pct_max=90"

# Relations
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/relations"

# Insights
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/insights"

# Technology domains
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/projects/$PROJECT_ID/analysis/technology-domains"
```

---

## 2. Import / SharePoint file

- **Import (Excel):** `POST /api/projects/:projectId/import/experiment-excel` with `multipart/form-data` file. Response: `{ created, updated, error_count?, ... }`.
- **SharePoint upload:** `POST /api/projects/:projectId/files/upload-to-sharepoint-bucket` (or direct-to-bucket via signed-urls + config). Response: `{ uploaded, failed, uploaded_paths?, errors? }`.
- **List bucket:** `GET /api/projects/:projectId/files/sharepoint-bucket`. Response: `{ files, displayNamesMap? }`.

---

## 3. Sync experiments

**Maneger → Matriya (if used):**  
`POST $MATRIYA_BACK_URL/sync/experiments` with body:

```json
{
  "experiments": [
    {
      "experiment_id": "string",
      "technology_domain": "string",
      "formula": "string",
      "materials": [],
      "percentages": {},
      "results": "string",
      "experiment_outcome": "success|failure|partial|production_formula",
      "is_production_formula": false
    }
  ]
}
```

Response: `{ synced, errors }`.

**Maneger internal (lab_experiments):**  
Import from Excel or API that writes to `lab_experiments`; sync endpoint above is on Matriya back.

---

## 4. Validation errors

- **Formula validate:** returns `{ valid, errors[], warnings[] }`.
- **Formulation intelligence:** returns `{ status, issues[] }` (e.g. mass_balance, range, similar_failed, materials_in_failed, material_not_in_library).
- **400/422:** request validation (e.g. missing experiment_id, invalid body).

---

## 5. Schema: decision_audit_log (Matriya)

Table lives in **Matriya** Supabase (research / kernel), not in Maneger.

```sql
CREATE TABLE IF NOT EXISTS decision_audit_log (
    id SERIAL PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
    stage VARCHAR(10) NOT NULL,
    decision VARCHAR(20) NOT NULL,
    response_type VARCHAR(50),
    request_query TEXT,
    inputs_snapshot JSONB,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Indexes
CREATE INDEX IF NOT EXISTS decision_audit_log_session_id_idx ON decision_audit_log(session_id);
CREATE INDEX IF NOT EXISTS decision_audit_log_created_at_idx ON decision_audit_log(created_at);

-- Kernel Amendment v1.2
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(5,4);
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS basis_count INTEGER;
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS model_version_hash VARCHAR(64);
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS complexity_context JSONB;
ALTER TABLE decision_audit_log ADD COLUMN IF NOT EXISTS human_feedback VARCHAR(20);
```

---

## Research Intelligence scope checklist

| Item | Status |
|------|--------|
| Relations (experiment / material / formula) | `lab_experiments` + `experiment_materials` (migration 006) |
| Similar experiments | GET `similar-experiments` + filters `experiment_outcome`, `material_pct_min/max` |
| Failure pattern detection | GET `failure-patterns` |
| Formula analysis (mass balance + similar + warnings) | POST `formula-validate`, POST `formulation-intelligence` |
| Material Intelligence | `material_library`, `materials` central, formulation-intelligence issues |
| Formulation intelligence | POST `formulation-intelligence` |
| Experiment similarity endpoint | GET `similar-experiments` |
| **Caching (input_hash)** | `analysis_log.input_hash` + cache lookup in formulation-intelligence & similar-experiments |
| **experiment_materials.role** | migration 006: main / secondary / additive / catalyst / solvent |
| **Similar experiments filters** | `experiment_outcome`, `material_pct_min`, `material_pct_max` |
| **Indexes** | experiment_materials(experiment_id, material_id), analysis_log(input_hash) |
| **parent_experiment_id** | lab_experiments.parent_experiment_id (migration 006) |
| **experiment_relations (relationship_type)** | Table for derived_from / similar_to / inspired_by (migration 006) |
