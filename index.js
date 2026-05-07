import 'dotenv/config';
import { initDB } from './db.js';
import { startPoller } from './poller.js';
import { startStaleChecker, startDailyDigest, startPendingReviewChecker } from './scheduler.js';

async function main() {
  await initDB();
  console.log('[Pr-Babysit] Banco de dados pronto');

  startStaleChecker();
  startDailyDigest();
  startPendingReviewChecker();
  await startPoller();

  console.log('[Pr-Babysit] Rodando');
}

main().catch(err => {
  console.error('[Pr-Babysit] Erro fatal na inicialização:', err);
  process.exit(1);
});
