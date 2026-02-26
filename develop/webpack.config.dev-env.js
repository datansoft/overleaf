const { merge } = require('webpack-merge')

const base = require('./webpack.config.dev')

module.exports = merge(base, {
  devServer: {
    allowedHosts: ['localhost', '127.0.0.1', 'host.docker.internal', '.localhost'],
    devMiddleware: {
      index: false,
    },
    proxy: [
      {
        context: '/socket.io/**',
        target: 'http://real-time:3026',
        ws: true,
      },
      {
        context: ['!**/*.js', '!**/*.css', '!**/*.json'],
        target: 'http://web:3000',
      },
    ],
  },
})
