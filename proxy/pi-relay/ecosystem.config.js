module.exports = {
  apps: [
    {
      name: 'shelly-quality-dashboard-relay',
      script: 'server.js',
      cwd: __dirname,
      env: {
        PORT: 5057,
        // Lock this down to your GitHub Pages origin once you know it, e.g.
        // 'https://your-github-username.github.io' — '*' is fine to start with.
        ALLOWED_ORIGIN: '*',
        JIRA_BASE_URL: 'https://shellyusa.atlassian.net',
      },
      autorestart: true,
      watch: false,
    },
  ],
};
