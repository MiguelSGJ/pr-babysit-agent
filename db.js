import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prs (
      pr_id       BIGINT PRIMARY KEY,
      repo        TEXT NOT NULL,
      pr_number   INTEGER NOT NULL,
      author_login TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT NOT NULL,
      state       TEXT NOT NULL,
      is_draft    BOOLEAN NOT NULL DEFAULT FALSE,
      is_merged   BOOLEAN NOT NULL DEFAULT FALSE,
      mergeable_state TEXT,
      opened_at   TIMESTAMPTZ NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL,
      reviewers   JSONB NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS processed_events (
      event_key   TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications_log (
      id          SERIAL PRIMARY KEY,
      pr_id       BIGINT NOT NULL,
      event_type  TEXT NOT NULL,
      target_login TEXT NOT NULL,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_lookup
      ON notifications_log(pr_id, event_type, target_login, sent_at);
  `);
}

export async function upsertPR(pr) {
  await pool.query(`
    INSERT INTO prs
      (pr_id, repo, pr_number, author_login, title, url, state,
       is_draft, is_merged, mergeable_state, opened_at, updated_at, reviewers)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (pr_id) DO UPDATE SET
      state           = EXCLUDED.state,
      is_draft        = EXCLUDED.is_draft,
      is_merged       = EXCLUDED.is_merged,
      mergeable_state = EXCLUDED.mergeable_state,
      updated_at      = EXCLUDED.updated_at,
      reviewers       = EXCLUDED.reviewers,
      title           = EXCLUDED.title
  `, [
    pr.pr_id, pr.repo, pr.pr_number, pr.author_login, pr.title,
    pr.url, pr.state, pr.is_draft, pr.is_merged, pr.mergeable_state ?? null,
    pr.opened_at, pr.updated_at, JSON.stringify(pr.reviewers ?? []),
  ]);
}

export async function getPR(prId) {
  const { rows } = await pool.query('SELECT * FROM prs WHERE pr_id = $1', [prId]);
  return rows[0] ?? null;
}

export async function getAllOpenPRs() {
  const { rows } = await pool.query("SELECT * FROM prs WHERE state = 'open'");
  return rows;
}

// ── Deduplicação: eventos que devem ocorrer exatamente uma vez ──────────────

export async function markEventProcessed(eventKey) {
  await pool.query(
    'INSERT INTO processed_events (event_key) VALUES ($1) ON CONFLICT DO NOTHING',
    [eventKey],
  );
}

export async function wasEventProcessed(eventKey) {
  const { rows } = await pool.query(
    'SELECT 1 FROM processed_events WHERE event_key = $1',
    [eventKey],
  );
  return rows.length > 0;
}

// ── Cooldown: eventos que podem repetir, mas com intervalo mínimo ────────────

export async function logNotification(prId, eventType, targetLogin) {
  await pool.query(
    'INSERT INTO notifications_log (pr_id, event_type, target_login) VALUES ($1, $2, $3)',
    [prId, eventType, targetLogin],
  );
}

export async function wasNotifiedRecently(prId, eventType, targetLogin, cooldownHours) {
  const { rows } = await pool.query(`
    SELECT 1 FROM notifications_log
    WHERE pr_id = $1
      AND event_type = $2
      AND target_login = $3
      AND sent_at > NOW() - ($4 || ' hours')::interval
    LIMIT 1
  `, [prId, eventType, targetLogin, cooldownHours]);
  return rows.length > 0;
}

export default pool;
