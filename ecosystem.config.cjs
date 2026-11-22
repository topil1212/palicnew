module.exports = {
  apps: [{
    name: 'palic-v2',
    cwd: __dirname,
    script: 'index.js',
    node_args: '--disable-warning=ExperimentalWarning',
    autorestart: true,
    max_restarts: 20,
  }],
};
