import {
  upsertPR,
  getPR,
  getAllOpenPRs,
  markEventProcessed,
  wasEventProcessed,
} from './db.js';
import {
  handlePROpened,
  handlePRClosed,
  handleConvertedToDraft,
  handleReadyForReview,
  handleReviewRequested,
  handleConflict,
  handleReviewSubmitted,
  handleReviewComment,
  handleIssueComment,
} from './handlers.js';
import { sendCriticalAlert } from './slack.js';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_SECONDS ?? '300', 10) * 1000;

// PRs criados antes deste momento são tratados como históricos (sem notificação no startup)
const agentStartTime = new Date();

// Controle de alertas para não repetir o mesmo alerta várias vezes
let rateLimitAlertSent = false;
let lastHeartbeatHour = -1;

// ── GitHub API ───────────────────────────────────────────────────────────────

async function githubFetch(path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  // ── Monitoramento de rate limit ──────────────────────────────────────────
  const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '9999', 10);
  const resetAt = parseInt(res.headers.get('x-ratelimit-reset') ?? '0', 10);
  const resetTime = new Date(resetAt * 1000).toLocaleTimeString('pt-BR');

  if (remaining < 100 && !rateLimitAlertSent) {
    const msg = `:warning: GitHub rate limit baixo: *${remaining} requests restantes*. Reset às ${resetTime}.`;
    console.warn(`[poller] ${msg}`);
    await sendCriticalAlert(msg);
    rateLimitAlertSent = true;
  }

  // Reset do flag quando o limite se recuperar
  if (remaining > 500) rateLimitAlertSent = false;

  // ── Erros críticos ───────────────────────────────────────────────────────
  if (res.status === 401) {
    const msg = ':red_circle: `GITHUB_TOKEN` inválido ou expirado. O agente parou de buscar dados do GitHub.';
    console.error(`[poller] Token inválido (401) em ${path}`);
    await sendCriticalAlert(msg);
    throw new Error(`GitHub API 401: token inválido em ${path}`);
  }

  if (res.status === 403 && remaining === 0) {
    const resetIn = Math.ceil((resetAt * 1000 - Date.now()) / 60000);
    const msg = `:warning: GitHub rate limit atingido. Reset em ${resetIn} min (${resetTime}).`;
    console.warn(`[poller] ${msg}`);
    await sendCriticalAlert(msg);
    throw new Error(`Rate limit atingido. Reset em ${resetIn} min`);
  }

  if (res.status === 304) return null; // Not Modified
  if (!res.ok) throw new Error(`GitHub API ${res.status} em ${path}`);
  return res.json();
}

// Busca todas as páginas de um endpoint paginado
async function githubFetchAll(path, params = {}) {
  const results = [];
  let page = 1;

  while (true) {
    const data = await githubFetch(path, { ...params, per_page: '100', page: String(page) });
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break; // última página
    page++;
  }

  return results;
}

// ── Polling por repo ─────────────────────────────────────────────────────────

async function pollRepo(repoFullName) {
  const [owner, repo] = repoFullName.split('/');

  // Busca TODOS os PRs abertos (com paginação)
  const openPRs = await githubFetchAll(`/repos/${owner}/${repo}/pulls`, { state: 'open' });

  // Normaliza para string: GitHub retorna id como number, PostgreSQL retorna BIGINT como string
  const openIds = new Set(openPRs.map(pr => String(pr.id)));

  // Detecta PRs que fecharam (estavam no DB como open, não vieram na lista)
  const dbOpenPRs = (await getAllOpenPRs()).filter(p => p.repo === repoFullName);
  for (const dbPR of dbOpenPRs) {
    if (openIds.has(String(dbPR.pr_id))) continue;

    const closedPR = await githubFetch(`/repos/${owner}/${repo}/pulls/${dbPR.pr_number}`);
    if (!closedPR) continue;

    await handlePRClosed(closedPR, { full_name: repoFullName });
    await upsertPR(prToRow(closedPR, repoFullName));
  }

  // Processa cada PR aberto
  for (const pr of openPRs) {
    await processPR(pr, repoFullName, owner, repo);
  }
}

async function processPR(pr, repoFullName, owner, repo) {
  const stored = await getPR(pr.id);
  const isFirstSeen = !stored;
  // PR histórico = existia antes do agente iniciar (não deve gerar notificação no startup)
  const isHistorical = isFirstSeen && new Date(pr.created_at) < agentStartTime;

  if (isFirstSeen && !isHistorical) {
    // PR genuinamente novo — aberto após o agente iniciar
    await handlePROpened(pr, { full_name: repoFullName });
  } else if (!isFirstSeen) {
    const wasDraft = stored.is_draft;
    const isDraft = pr.draft;

    if (wasDraft && !isDraft) {
      await handleReadyForReview(pr, { full_name: repoFullName });
    } else if (!wasDraft && isDraft) {
      await handleConvertedToDraft(pr, { full_name: repoFullName });
    }

    // Conflito de merge
    if (pr.mergeable_state === 'dirty' && stored.mergeable_state !== 'dirty') {
      await handleConflict(pr, { full_name: repoFullName });
    }

    // Novos revisores solicitados
    const storedReviewers = new Set((stored.reviewers ?? []).map(r => r.login));
    for (const reviewer of pr.requested_reviewers ?? []) {
      if (!storedReviewers.has(reviewer.login)) {
        await handleReviewRequested(pr, { full_name: repoFullName }, reviewer);
      }
    }
  }

  // Salva/atualiza estado no DB
  await upsertPR(prToRow(pr, repoFullName));

  // Busca reviews e comentários se PR é novo ou teve mudança desde o último poll
  const updatedAtChanged = isFirstSeen || stored.updated_at?.toISOString() !== new Date(pr.updated_at).toISOString();
  if (updatedAtChanged) {
    await pollReviews(owner, repo, repoFullName, pr, isHistorical);
    await pollComments(owner, repo, repoFullName, pr, isHistorical);
  }
}

async function pollReviews(owner, repo, repoFullName, pr, silent = false) {
  const reviews = await githubFetch(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews`);
  if (!reviews) return;

  for (const review of reviews) {
    const key = `polled:review:${review.id}`;
    if (await wasEventProcessed(key)) continue;
    if (!silent) await handleReviewSubmitted(review, pr, { full_name: repoFullName });
    await markEventProcessed(key);
  }
}

async function pollComments(owner, repo, repoFullName, pr, silent = false) {
  // Comentários de código (review comments)
  // position === null indica comentário em código desatualizado (thread resolvida por mudança de código)
  const reviewComments = await githubFetch(
    `/repos/${owner}/${repo}/pulls/${pr.number}/comments`,
  );
  if (reviewComments) {
    for (const comment of reviewComments) {
      const key = `polled:rc:${comment.id}`;
      if (await wasEventProcessed(key)) continue;
      if (!silent && comment.position !== null) {
        await handleReviewComment(comment, pr, { full_name: repoFullName });
      }
      await markEventProcessed(key);
    }
  }

  // Comentários gerais do PR (issue comments)
  const issueComments = await githubFetch(
    `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
  );
  if (issueComments) {
    for (const comment of issueComments) {
      const key = `polled:ic:${comment.id}`;
      if (await wasEventProcessed(key)) continue;
      if (!silent) await handleIssueComment(comment, pr, { full_name: repoFullName });
      await markEventProcessed(key);
    }
  }
}

// ── Conversão GitHub PR → linha do DB ───────────────────────────────────────

function prToRow(pr, repoFullName) {
  return {
    pr_id: pr.id,
    repo: repoFullName,
    pr_number: pr.number,
    author_login: pr.user.login,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    is_draft: pr.draft ?? false,
    is_merged: pr.merged ?? false,
    mergeable_state: pr.mergeable_state ?? null,
    opened_at: pr.created_at,
    updated_at: pr.updated_at,
    reviewers: pr.requested_reviewers ?? [],
  };
}

// ── Entrada pública ──────────────────────────────────────────────────────────

export async function startPoller() {
  const repos = (process.env.GITHUB_REPOS ?? '')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    console.warn('[poller] GITHUB_REPOS não configurado — poller inativo');
    return;
  }

  console.log(`[poller] Monitorando: ${repos.join(', ')} (intervalo: ${POLL_INTERVAL_MS / 1000}s)`);

  const run = async () => {
    // Heartbeat: loga uma vez por hora para confirmar que está vivo
    const hour = new Date().getHours();
    if (hour !== lastHeartbeatHour) {
      console.log(`[pr-babysit] Heartbeat — ${new Date().toLocaleString('pt-BR')}`);
      lastHeartbeatHour = hour;
    }

    for (const repo of repos) {
      try {
        await pollRepo(repo);
      } catch (err) {
        console.error(`[poller] Erro em ${repo}:`, err.message);
      }
    }
  };

  await run(); // executa imediatamente na inicialização
  setInterval(run, POLL_INTERVAL_MS);
}
