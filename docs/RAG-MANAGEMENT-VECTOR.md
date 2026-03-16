# RAG: management_vector (pgvector in Postgres)

The indexed documents are stored in a **PostgreSQL table** named `management_vector` in your **management Supabase database**, using the **pgvector** extension. This is **not** Supabase’s separate “Vector” bucket UI.

## Where to see the data

1. In **Supabase Dashboard** open your project (e.g. `zqhdznwquejnkdpxsuui`).
2. Go to **Database** → **Tables** (not “Vector” / “Vector bucket”).
3. In the list of tables you should see **`management_vector`**.

If you don’t see it, create it (and the extension) by running the migration in **SQL Editor**:

- Open **SQL Editor** → New query.
- Paste the contents of `migrations/009_management_vector_rag.sql`.
- Run it.

## Check that data is there

In **SQL Editor** run:

```sql
-- Count rows
SELECT COUNT(*) FROM management_vector;

-- List filenames and row count per file
SELECT metadata->>'filename' AS filename, COUNT(*) AS chunks
FROM management_vector
GROUP BY metadata->>'filename'
ORDER BY filename;
```

You should see the same filenames and counts as after running the index script.

## Summary

| What              | Where                                      |
|-------------------|--------------------------------------------|
| Table name        | `management_vector`                        |
| Location          | Same Postgres DB as your app (POSTGRES_URL) |
| How to view       | Database → Tables → `management_vector`    |
| Not used          | Supabase “Vector” / vector bucket UI       |
