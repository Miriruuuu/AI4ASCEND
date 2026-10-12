/**
 * pm2 部署配置：pm2 start ecosystem.config.cjs
 *
 * 注意：对局状态保存在进程内存里，因此**必须单实例**（fork 模式），
 * 不要用 cluster/多实例，否则两名玩家可能被分配到不同进程导致匹配失败。
 */
module.exports = {
  apps: [
    {
      name: 'connect4-backend',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      listen_timeout: 10000,
      merge_logs: true,
      time: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      env: {
        NODE_ENV: 'production',
        // 端口 / Mongo / 是否托管前端等都在 .env 里配置（dotenv 会自动加载）
      },
    },
  ],
}
