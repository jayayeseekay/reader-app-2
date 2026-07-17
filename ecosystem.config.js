module.exports = {
  apps: [{
    name: 'reader-app',
    script: 'server.js',
    watch: true,
    ignore_watch: [
      'data',
      'node_modules',
      '*.log',
      '.git'
    ],
    watch_options: {
      followSymlinks: false,
      usePolling: true,
      interval: 1000
    },
    env: {
      NODE_ENV: 'development'
    }
  }]
};
