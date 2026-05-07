// Map de GitHub username -> Slack User ID
// Edite este arquivo para adicionar os membros da sua equipe
export const userMap = {
  'Github-user': 'Slack-ID',
};

export function getSlackId(githubLogin) {
  return userMap[githubLogin] ?? null;
}
