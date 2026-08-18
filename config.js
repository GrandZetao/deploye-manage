const path = require('path');

module.exports = {
  // 服务监听端口
  port: Number(process.env.PORT) || 3000,

  // 数据存放目录（项目/版本元数据、临时上传文件）
  dataDir: path.join(__dirname, 'data'),
  dbFile: path.join(__dirname, 'data', 'db.json'),
  uploadTmpDir: path.join(__dirname, 'data', 'tmp-uploads'),

  // 单次上传压缩包大小限制（MB）
  maxUploadSizeMB: Number(process.env.MAX_UPLOAD_MB) || 300
};
