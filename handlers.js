import { sendNotification } from './slack.js';
import { getSlackId } from './users.js';
import {
  markEventProcessed,
  wasEventProcessed,
  logNotification,
  wasNotifiedRecently,
} from './db.js';

// ── Helpers internos ─────────────────────────────────────────────────────────

const warnedLogins = new Set();

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

async function notify(githubLogin, text, blocks) {
  const slackId = getSlackId(githubLogin);
  if (!slackId) {
    if (!warnedLogins.has(githubLogin)) {
      console.warn(`[handlers] githubLogin não mapeado: ${githubLogin}`);
      warnedLogins.add(githubLogin);
    }
    return;
  }
  try {
    await sendNotification(slackId, text, blocks);
  } catch (err) {
    console.error(`[handlers] Falha ao notificar ${githubLogin}:`, err.message);
  }
}

// Notifica uma vez para a combinação (eventKey, githubLogin)
async function notifyOnce(eventKey, githubLogin, text, blocks) {
  const key = `${eventKey}:${githubLogin}`;
  if (await wasEventProcessed(key)) return;
  await notify(githubLogin, text, blocks);
  await markEventProcessed(key);
}

// Notifica com cooldown em horas (pode repetir após o intervalo)
async function notifyWithCooldown(prId, eventType, githubLogin, cooldownHours, text, blocks) {
  if (await wasNotifiedRecently(prId, eventType, githubLogin, cooldownHours)) return;
  await notify(githubLogin, text, blocks);
  await logNotification(prId, eventType, githubLogin);
}

async function notifyMentions(text, authorLogin, contextLabel, url, prId, sourceId) {
  if (!text) return;
  const usernames = [
    ...new Set((text.match(/@([a-zA-Z0-9_-]+)/g) ?? []).map(m => m.slice(1))),
  ];
  for (const username of usernames) {
    if (username === authorLogin) continue;
    if (!getSlackId(username)) continue;
    const key = `notif:mention:${sourceId}:${username}`;
    if (await wasEventProcessed(key)) continue;
    const blocks = buildPRBlocks(
      `:bust_in_silhouette: Você foi mencionado em *${contextLabel}*\n<${url}|Ver contexto>`,
      url,
    );
    await notify(username, `Menção em ${contextLabel}`, blocks);
    await markEventProcessed(key);
  }
}

// ── Handlers exportados (chamados pelo poller) ────────────────────────────────

export async function handlePROpened(pr, repo) {
  const { html_url: url, title, id: prId, user, body, requested_reviewers: reviewers = [] } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;

  const blocks = buildPRBlocks(
    `:rocket: Seu PR foi aberto!\n*<${url}|${title}>*\n${repoName}`,
    url,
  );
  await notifyOnce(`notif:opened:${prId}`, authorLogin, `PR aberto: ${title}`, blocks);
  await notifyMentions(body, authorLogin, `descrição do PR "${title}"`, url, prId, `desc:${prId}`);
}

export async function handlePRClosed(pr, repo) {
  const { html_url: url, title, id: prId, user, merged } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;

  if (merged) {
    const blocks = buildPRBlocks(
      `:tada: Seu PR foi mergeado!\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(`notif:merged:${prId}`, authorLogin, `PR mergeado: ${title}`, blocks);
  } else {
    const blocks = buildPRBlocks(
      `:x: Seu PR foi fechado sem merge.\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(`notif:closed:${prId}`, authorLogin, `PR fechado: ${title}`, blocks);
  }
}

export async function handleConvertedToDraft(pr, repo) {
  const { html_url: url, title, id: prId, requested_reviewers: reviewers = [], updated_at } = pr;
  const repoName = repo.full_name;

  for (const reviewer of reviewers) {
    const blocks = buildPRBlocks(
      `:pencil2: Um PR voltou para draft (saiu da fila).\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(
      `notif:to_draft:${prId}:${updated_at}`,
      reviewer.login,
      `PR voltou para draft: ${title}`,
      blocks,
    );
  }
}

export async function handleReadyForReview(pr, repo) {
  const { html_url: url, title, id: prId, requested_reviewers: reviewers = [], updated_at } = pr;
  const repoName = repo.full_name;

  for (const reviewer of reviewers) {
    const blocks = buildPRBlocks(
      `:eyes: Um PR está pronto para revisão!\n*<${url}|${title}>*\nAutor: @${pr.user.login} | ${repoName}`,
      url,
    );
    await notifyOnce(
      `notif:ready:${prId}:${updated_at}`,
      reviewer.login,
      `PR pronto para revisão: ${title}`,
      blocks,
    );
  }
}

export async function handleReviewRequested(pr, repo, requestedReviewer) {
  const { html_url: url, title, id: prId, user } = pr;
  const repoName = repo.full_name;
  const reviewerLogin = requestedReviewer.login;

  const blocks = buildPRBlocks(
    `:bell: Você foi solicitado como revisor!\n*<${url}|${title}>*\nAutor: @${user.login} | ${repoName}`,
    url,
  );
  await notifyOnce(
    `notif:review_requested:${prId}:${reviewerLogin}`,
    reviewerLogin,
    `Revisão solicitada: ${title}`,
    blocks,
  );
}

export async function handleConflict(pr, repo) {
  const { html_url: url, title, id: prId, user } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;

  const CONFLICT_COOLDOWN_HOURS = 4;
  const blocks = buildPRBlocks(
    `:warning: Seu PR tem conflito de merge!\n*<${url}|${title}>*\n${repoName}`,
    url,
  );
  await notifyWithCooldown(
    prId, 'conflict', authorLogin, CONFLICT_COOLDOWN_HOURS,
    `Conflito de merge: ${title}`, blocks,
  );
}

export async function handleReviewSubmitted(review, pr, repo) {
  const { html_url: url, title, id: prId, user } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;
  const reviewerLogin = review.user.login;
  const reviewId = review.id;

  if (review.state === 'approved') {
    const blocks = buildPRBlocks(
      `:white_check_mark: Seu PR foi aprovado por @${reviewerLogin}!\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(
      `notif:review:${reviewId}`,
      authorLogin,
      `PR aprovado por ${reviewerLogin}: ${title}`,
      blocks,
    );
  } else if (review.state === 'changes_requested') {
    const blocks = buildPRBlocks(
      `:pencil: @${reviewerLogin} solicitou alterações.\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(
      `notif:review:${reviewId}`,
      authorLogin,
      `Alterações solicitadas por ${reviewerLogin}: ${title}`,
      blocks,
    );
    await notifyMentions(review.body, authorLogin, `revisão de "${title}"`, url, prId, `review:${reviewId}`);
  } else if (review.state === 'commented') {
    const blocks = buildPRBlocks(
      `:speech_balloon: @${reviewerLogin} comentou na revisão.\n*<${url}|${title}>*\n${repoName}`,
      url,
    );
    await notifyOnce(
      `notif:review:${reviewId}`,
      authorLogin,
      `Comentário de revisão de ${reviewerLogin}: ${title}`,
      blocks,
    );
    await notifyMentions(review.body, authorLogin, `revisão de "${title}"`, url, prId, `review:${reviewId}`);
  }
}

export async function handleReviewComment(comment, pr, repo) {
  const { html_url: url, title, id: prId, user } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;
  const commenterLogin = comment.user.login;
  const commentId = comment.id;

  if (commenterLogin === authorLogin) return;

  const blocks = buildPRBlocks(
    `:left_speech_bubble: @${commenterLogin} comentou no código.\n*<${url}|${title}>*\n${repoName}`,
    url,
  );
  await notifyOnce(
    `notif:rc:${commentId}`,
    authorLogin,
    `Comentário de código de ${commenterLogin}: ${title}`,
    blocks,
  );
  await notifyMentions(comment.body, authorLogin, `comentário em "${title}"`, url, prId, `rc:${commentId}`);
}

export async function handleIssueComment(comment, pr, repo) {
  const { html_url: url, title, id: prId, user } = pr;
  const repoName = repo.full_name;
  const authorLogin = user.login;
  const commenterLogin = comment.user.login;
  const commentId = comment.id;

  if (commenterLogin === authorLogin) return;

  const blocks = buildPRBlocks(
    `:speech_balloon: @${commenterLogin} comentou no seu PR.\n*<${url}|${title}>*\n${repoName}`,
    url,
  );
  await notifyOnce(
    `notif:ic:${commentId}`,
    authorLogin,
    `Comentário de ${commenterLogin}: ${title}`,
    blocks,
  );
  await notifyMentions(comment.body, authorLogin, `comentário em "${title}"`, url, prId, `ic:${commentId}`);
}
