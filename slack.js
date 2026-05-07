import { WebClient } from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Cache de channel IDs abertos por DM
const dmCache = new Map();

export async function sendNotification(slackUserId, text, blocks) {
  let channelId = dmCache.get(slackUserId);

  if (!channelId) {
    const result = await client.conversations.open({ users: slackUserId });
    channelId = result.channel.id;
    dmCache.set(slackUserId, channelId);
  }

  await client.chat.postMessage({
    channel: channelId,
    text,
    blocks,
  });
}

export async function findSlackUserByEmail(email) {
  const result = await client.users.lookupByEmail({ email });
  return result.user;
}

// Envia alerta crítico para ADMIN_SLACK_ID (erros de token, rate limit, etc.)
export async function sendCriticalAlert(text) {
  const adminId = process.env.ADMIN_SLACK_ID;
  if (!adminId) {
    console.error(`[slack] ADMIN_SLACK_ID não configurado — alerta não enviado: ${text}`);
    return;
  }
  try {
    await sendNotification(adminId, text, [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:rotating_light: *Alerta crítico — pr-babysit*\n${text}`,
        },
      },
    ]);
  } catch (err) {
    console.error('[slack] Falha ao enviar alerta crítico:', err.message);
  }
}
