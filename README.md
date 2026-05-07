# pr-babysit

Bot Slack que monitora Pull Requests do GitHub via polling e notifica os devs via DM.
Não precisa de webhook — funciona localmente sem expor nenhuma porta.

## O que é monitorado

| Situação detectada | Quem recebe |
|---|---|
| PR aberto | Autor |
| PR mergeado | Autor |
| PR fechado sem merge | Autor |
| PR convertido para draft | Revisores |
| PR pronto para revisão | Revisores |
| Revisão solicitada | Revisor solicitado |
| Conflito de merge detectado | Autor (máx 1x a cada 4h) |
| Review aprovado | Autor |
| Review com alterações solicitadas | Autor |
| Review comentado | Autor |
| Comentário de código | Autor |
| Comentário geral no PR | Autor |
| Menção @username em qualquer texto | Usuário mencionado |
| PR parado sem atividade (stale) | Revisores (ou autor se sem revisores) |
| Resumo diário | Todos os devs no `users.js` |

### Regras anti-flood

- Cada notificação pontual (PR aberto, review, comentário) é enviada **exatamente uma vez**, identificada por ID único salvo no banco.
- **Conflito de merge**: cooldown de 4 horas por PR por usuário.
- **Stale**: cooldown de `STALE_PR_HOURS` horas por PR por usuário.
- **Daily digest**: enviado **uma vez por dia** por usuário (chave `digest:{login}:{data}`).

---

## Setup

### 1. Pré-requisitos

- Node.js 18+
- PostgreSQL rodando localmente (ou em nuvem)

### 2. Criar banco de dados

```bash
psql -U postgres -c "CREATE DATABASE pr_babysit;"
```

As tabelas são criadas automaticamente na inicialização.

### 3. Instalar dependências

```bash
npm install
```

### 4. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...          # Token OAuth do bot Slack
GITHUB_TOKEN=ghp_...              # Personal Access Token do GitHub (scope: repo)
GITHUB_REPOS=owner/repo1,org/repo2  # Repos a monitorar (separados por vírgula)
DATABASE_URL=postgresql://usuario:senha@localhost:5432/pr_babysit
POLL_INTERVAL_SECONDS=300         # Intervalo de polling em segundos (padrão: 5min)
STALE_PR_HOURS=24                 # Horas até PR ser considerado parado
DIGEST_HOUR=9                     # Hora do resumo diário (formato 24h)
```

### 5. Configurar mapa de usuários

Edite `users.js`:

```js
export const userMap = {
  'seu-github-username': 'UXXXXXXXXX',  // Slack User ID
};
```

**Como achar o Slack User ID:** perfil → menu "..." → "Copiar ID do membro" (começa com `U`).

### 6. Criar GitHub Personal Access Token

1. GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Gere um token com o scope **`repo`** (para repos privados) ou **`public_repo`** (para públicos)
3. Cole em `GITHUB_TOKEN` no `.env`

### 7. Rodar

```bash
# Execução direta (manual)
npm start

# Ou com PM2 (recomendado — reinicia automaticamente e inicia com o sistema)
npm run pm2:start
```

---

## Iniciar automaticamente com o sistema (PM2)

### Instalar PM2

```bash
npm install -g pm2
```

### Registrar no sistema (Mac/Linux/Windows)

```bash
npm run pm2:start   # inicia o processo
pm2 save            # salva a lista de processos
pm2 startup         # imprime o comando para registrar no boot — execute o comando gerado
```

O `pm2 startup` detecta o OS automaticamente e imprime o comando exato. Exemplo no Mac:
```
sudo env PATH=$PATH:/opt/homebrew/bin pm2 startup launchd -u seunome --hp /Users/seunome
```
Basta copiar e executar esse comando.

### Comandos úteis

```bash
npm run pm2:status    # ver se está rodando
npm run pm2:logs      # ver logs em tempo real
npm run pm2:restart   # reiniciar
npm run pm2:stop      # parar
```

### Desregistrar do boot (se quiser remover)

```bash
pm2 unstartup
```

---

---

## Permissões necessárias no Slack

Na sua Slack App (api.slack.com → sua app → OAuth & Permissions):

| Scope | Para que serve |
|---|---|
| `chat:write` | Enviar mensagens |
| `im:write` | Abrir DMs |
| `users:read` | Buscar usuários |

---

## Estrutura do projeto

```
pr-babysit/
├── index.js       # Entrada: inicializa DB, poller e scheduler
├── poller.js      # Polling da GitHub API, detecção de mudanças
├── handlers.js    # Lógica de notificação por tipo de evento
├── scheduler.js   # Stale checker e daily digest
├── db.js          # Conexão PostgreSQL + queries
├── slack.js       # Cliente Slack com cache de DMs
├── users.js       # Mapa GitHub username → Slack User ID
└── .env.example
```
