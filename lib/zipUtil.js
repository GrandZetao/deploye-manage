const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * 安全解压 zip 到目标目录。
 * - 防止 zip slip（压缩包内条目用 ../ 之类的路径逃逸到目标目录之外）
 * - 自动"拍平"常见的打包习惯：如果压缩包解压后只有一个顶层文件夹
 *   （比如打包时压缩了整个 dist 文件夹，解压出来是 dist/index.html 而不是 index.html），
 *   会自动把这个文件夹里的内容提升一层，这样 nginx 才能直接从版本目录根部找到 index.html
 */
function safeExtract(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const resolvedDest = path.resolve(destDir);

  for (const entry of entries) {
    const targetPath = path.resolve(destDir, entry.entryName);
    if (targetPath !== resolvedDest && !targetPath.startsWith(resolvedDest + path.sep)) {
      throw new Error(`压缩包中包含不安全的路径，已中止解压：${entry.entryName}`);
    }
  }

  fs.ensureDirSync(destDir);
  zip.extractAllTo(destDir, true);

  flattenSingleTopDir(destDir);
}

function flattenSingleTopDir(destDir) {
  const items = fs.readdirSync(destDir).filter(n => n !== '__MACOSX');
  if (items.length === 1) {
    const only = path.join(destDir, items[0]);
    if (fs.statSync(only).isDirectory()) {
      const tmp = destDir + '__flatten_tmp';
      fs.moveSync(only, tmp);
      fs.removeSync(destDir);
      fs.moveSync(tmp, destDir);
    }
  }
}

module.exports = { safeExtract };
