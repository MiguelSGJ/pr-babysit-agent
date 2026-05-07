import { sendNotification } from './slack.js';
import { getSlackId, userMap } from './users.js';
import { getAllOpenPRs, wasNotifiedRecently, logNotification, wasEventProcessed, markEventProcessed } from './db.js';

const STALE_COOLDOWN_HOURS = parseInt(process.env.STALE_PR_HOURS ?? '24', 10);
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR ?? '9', 10);
const PENDING_REVIEW_HOURS = parseInt(process.env.PENDING_REVIEW_HOURS ?? '4', 10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildPRBlocks(text, url) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Ver PR', emoji: true },
        url,
        action_id: 'view_pr',
      },
    },
  ];
}

async function notifySafe(slackId, text, blocks) {
  try {
    await sendNotification(slackId, text, blocks);
  } catch (err) {
    console.error(`[scheduler] Falha ao notificar ${slackId}:`, err.message);
  }
}

function hoursOpen(openedAt) {
  return Math.floor((Date.now() - new Date(openedAt).getTime()) / (1000 * 60 * 60));
}

// ── Stale checker ─────────────────────────────────────────────────────────────

export function startStaleChecker() {
  setInterval(async () => {
    try {
      await runStaleCheck();
    } catch (err) {
      console.error('[scheduler] Erro no stale checker:', err.message);
    }
  }, 60 * 60 * 1000); // a cada 1 hora
}

async function runStaleCheck() {
  const openPRs = await getAllOpenPRs();

  for (const row of openPRs) {
    const hours = hoursOpen(row.opened_at);
    if (hours < STALE_COOLDOWN_HOURS) continue;

    const reviewers = Array.isArray(row.reviewers) ? row.reviewers : JSON.parse(row.reviewers ?? '[]');
    const mappedReviewers = reviewers.map(r => r.login).filter(l => getSlackId(l));

    const targets = mappedReviewers.length > 0
      ? mappedReviewers
      : [row.author_login]; // notifica autor se sem revisores

    for (const login of targets) {
      const alreadyNotified = await wasNotifiedRecently(row.pr_id, 'stale', login, STALE_COOLDOWN_HOURS);
      if (alreadyNotified) continue;

      const isAuthor = login === row.author_login;
      const msg = isAuthor
        ? `:hourglass: Seu PR está aberto há ${hours}h sem revisores atribuídos.`
        : `:hourglass: PR aguardando sua revisão há ${hours}h.`;

      const blocks = buildPRBlocks(`${msg}\n*<${row.url}|${row.title}>*\n${row.repo}`, row.url);
      const slackId = getSlackId(login);

      await notifySafe(slackId, `PR parado há ${hours}h: ${row.title}`, blocks);
      await logNotification(row.pr_id, 'stale', login);
    }
  }
}

// ── Pending review checker ────────────────────────────────────────────────────

export function startPendingReviewChecker() {
  setInterval(async () => {
    try {
      await runPendingReviewCheck();
    } catch (err) {
      console.error('[scheduler] Erro no pending review checker:', err.message);
    }
  }, 60 * 60 * 1000); // a cada 1 hora
}

async function runPendingReviewCheck() {
  const openPRs = await getAllOpenPRs();

  for (const row of openPRs) {
    const reviewers = Array.isArray(row.reviewers) ? row.reviewers : JSON.parse(row.reviewers ?? '[]');
    if (reviewers.length === 0) continue;

    const hours = hoursOpen(row.opened_at);
    if (hours < PENDING_REVIEW_HOURS) continue;

    for (const reviewer of reviewers) {
      const login = reviewer.login;
      const slackId = getSlackId(login);
      if (!slackId) continue;

      const alreadyNotified = await wasNotifiedRecently(row.pr_id, 'pending_review', login, PENDING_REVIEW_HOURS);
      if (alreadyNotified) continue;

      const blocks = buildPRBlocks(
        `:memo: Você tem uma revisão pendente há ${hours}h.\n*<${row.url}|${row.title}>*\nAutor: @${row.author_login} | ${row.repo}`,
        row.url,
      );

      await notifySafe(slackId, `Revisão pendente: ${row.title}`, blocks);
      await logNotification(row.pr_id, 'pending_review', login);
    }
  }
}

// ── Daily digest ──────────────────────────────────────────────────────────────

export function startDailyDigest() {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== DIGEST_HOUR || now.getMinutes() !== 0) return;

    try {
      await runDailyDigest();
    } catch (err) {
      console.error('[scheduler] Erro no daily digest:', err.message);
    }
  }, 60 * 1000); // verifica a cada 1 minuto
}

async function runDailyDigest() {
  const openPRs = await getAllOpenPRs();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Agrupa por autor e por revisor
  const prsByAuthor = new Map();
  const prsByReviewer = new Map();

  for (const row of openPRs) {
    if (!prsByAuthor.has(row.author_login)) prsByAuthor.set(row.author_login, []);
    prsByAuthor.get(row.author_login).push(row);

    const reviewers = Array.isArray(row.reviewers) ? row.reviewers : JSON.parse(row.reviewers ?? '[]');
    for (const r of reviewers) {
      if (!prsByReviewer.has(r.login)) prsByReviewer.set(r.login, []);
      prsByReviewer.get(r.login).push(row);
    }
  }

  for (const githubLogin of Object.keys(userMap)) {
    const slackId = getSlackId(githubLogin);
    if (!slackId) continue;

    // Garante que o digest seja enviado uma única vez por dia
    const digestKey = `digest:${githubLogin}:${today}`;
    if (await wasEventProcessed(digestKey)) continue;

    const myPRs = prsByAuthor.get(githubLogin) ?? [];
    const toReview = prsByReviewer.get(githubLogin) ?? [];
    if (myPRs.length === 0 && toReview.length === 0) continue;

    const blocks = buildDigestBlocks(myPRs, toReview);
    await notifySafe(slackId, 'Seu resumo diário de PRs', blocks);
    await markEventProcessed(digestKey);
  }
}

function buildDigestBlocks(myPRs, toReview) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':newspaper: Resumo diário de PRs', emoji: true },
    },
    { type: 'divider' },
  ];

  if (myPRs.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Seus PRs abertos:*' } });
    for (const row of myPRs) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• <${row.url}|${row.title}> — ${row.repo} (${hoursOpen(row.opened_at)}h aberto)`,
        },
      });
    }
    blocks.push({ type: 'divider' });
  }

  if (toReview.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*PRs aguardando sua revisão:*' } });
    for (const row of toReview) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `• <${row.url}|${row.title}> — ${row.repo} (${hoursOpen(row.opened_at)}h aberto)`,
        },
      });
    }
  }

  return blocks;
}
