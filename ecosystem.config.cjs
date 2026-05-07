module.exports = {
  apps: [
    {
      name: 'pr-babysit',
      script: 'index.js',
      interpreter: 'node',
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
