const path = require('path');

module.exports = {
  // * SSH凭据和远程控制能力默认只允许本机访问；可信内网可显式设置 HOST。
  host: process.env.HOST || '127.0.0.1',

  // 服务监听端口
  port: Number(process.env.PORT) || 3000,

  // 数据存放目录（项目/版本元数据、临时上传文件）
  dataDir: path.join(__dirname, 'data'),
  dbFile: path.join(__dirname, 'data', 'db.json'),
  uploadTmpDir: path.join(__dirname, 'data', 'tmp-uploads'),

  // 单次上传压缩包大小限制（MB）
  maxUploadSizeMB: Number(process.env.MAX_UPLOAD_MB) || 300
};
