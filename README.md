# Deploy Manager

Deploy Manager 是一个运行在 Windows 上的图形化部署工具，用于管理 Windows 本机项目和通过 SSH 连接的 Linux 项目。

每次部署都会生成独立、不可变的版本目录，再通过目录联接点或 Linux 软链接切换线上版本。Nginx 的站点目录只需配置一次，后续部署、切换和回滚不需要反复修改 Nginx 配置。

## 当前功能

- Windows 本机不可变版本部署和 NTFS junction 原子切换。
- SSH 密码或私钥连接 Linux，SFTP 上传压缩包。
- Linux 上传后校验 SHA-256，在 staging 目录解压成功后才生成正式版本。
- 支持新项目的 `current` 布局，以及已有 Linux 部署脚本的站点软链接布局。
- 同步服务器上已有的 Linux 历史版本，不要求重新部署。
- 部署后立即上线或仅上传版本。
- 切换历史版本、删除离线版本、清理旧版本，以及 Linux 项目一键回滚。
- Nginx 配置校验、reload 和 restart，支持自定义可执行文件与 systemd 服务。
- HTTP/HTTPS 健康检查，可配置 Host 请求头和超时时间。
- 远程环境诊断和项目目录范围内的只读 SFTP 文件浏览器。
- Deploy Manager 运行日志，以及 Nginx access/error 日志实时查看。

## 目录布局

### Windows 本机项目

```text
D:\sites\my-project\
  releases\
    20260818-153042-a1b2c3\
    20260817-120500-f4e5d6\
  current                         <- NTFS 目录联接点
```

Nginx 固定访问：

```nginx
root D:/sites/my-project/current;
```

`current` 指向 `releases` 中当前上线的版本。切换版本只会替换联接点，不复制静态文件，也不需要 reload Nginx。

### Linux：项目目录 / current

适合由 Deploy Manager 新建和管理的项目：

```text
/var/www/my-project/
  releases/
    20260818-153042-a1b2c3/
    20260817-120500-f4e5d6/
  current                         <- Linux 软链接
  .deploy-manager/
```

Nginx 固定访问：

```nginx
root /var/www/my-project/current;
```

### Linux：兼容旧脚本

适合已经由 `waterx-deploy.sh` 等脚本管理的项目：

```text
/home/nginx/nginx/html/waterx-micro             <- 线上站点软链接
/home/nginx/nginx/html/waterx-micro-releases/
  20260817-145509/
  20260817-162541/
```

项目设置中填写：

- 线上站点路径：`/home/nginx/nginx/html/waterx-micro`
- 历史版本目录：`/home/nginx/nginx/html/waterx-micro-releases`
- Linux 目录布局：`兼容旧脚本`

这个模式会直接切换线上站点软链接，**不会创建或使用 `/current`**。原有 Nginx `root` 保持不变。

## 安装和启动

前提：Windows 已安装 Node.js 18 或更高版本。

```powershell
cd E:\download\deploy-manager
npm install
npm start
```

也可以双击 `start.bat`。默认访问地址：

```text
http://127.0.0.1:3000
```

服务默认只监听 `127.0.0.1`。只有在可信网络中才应通过 `HOST` 显式开放：

```powershell
$env:HOST = "0.0.0.0"
npm start
```

上传大小默认限制为 300MB，可通过环境变量修改：

```powershell
$env:MAX_UPLOAD_MB = "500"
npm start
```

## Windows 项目使用方法

1. 新建项目，选择 `Windows 本机`，填写项目名称和绝对部署目录。
2. 把 Nginx `root` 指向 `<项目目录>/current`，首次 reload 一次 Nginx。
3. 点击“部署新版本”，上传 `.zip` 构建产物。
4. 在版本时间线中切换、删除或清理历史版本。
5. 需要回滚时，在版本时间线中切换到之前的版本。

如果压缩包最外层只有一个目录，例如 `dist/`，部署时会自动去掉这一层。

## Linux 项目使用方法

### 1. 检查 Linux 环境

查看发行版和内核：

```bash
cat /etc/os-release
uname -a
```

查看初始化系统：

```bash
ps -p 1 -o comm=
```

输出为 `systemd` 时可以使用 systemd 控制方式；自编译 Nginx 没有服务单元时选择“可执行文件”。

部署所需的常用命令包括：

```text
unzip sha256sum find du ln mv stat awk cut basename tr
```

日志模块还会使用 `tail`，健康检查会使用 `curl` 或 `wget`。

### 2. 新增并连接 SSH 服务器

1. 打开“SSH 服务器”。
2. 填写地址、端口、用户名和认证方式。
3. 点击“保存并测试”，首次连接时确认服务器主机指纹。
4. 测试成功后，当前 Deploy Manager 进程会保存本次会话需要的凭据。

密码和私钥口令不会写入 `data/db.json`，只保存在当前 Node.js 进程内存中。服务重启或点击“断开连接”后需要重新输入一次；会话有效期间，部署、同步、诊断、文件浏览和日志读取不需要反复输入密码。

### 3. 新建 Linux 项目

选择 SSH 服务器，并根据实际情况选择目录布局：

- 新项目：选择“项目目录 / current”。
- 已使用旧脚本管理：选择“兼容旧脚本”，分别填写线上软链接和历史版本目录。

部署目录由用户自行选择。SSH 用户必须对版本目录以及线上软链接所在目录具有读写权限。

### 4. 同步已有版本

兼容旧脚本的项目创建后，点击“同步远程版本”。管理器会读取版本目录和线上软链接：

- 只导入服务器上已经存在的版本。
- 以线上软链接当前指向作为已上线版本。
- 不修改、不移动已有静态文件。
- 不会因为同步而把路径改成 `releases` 或 `current`。

### 5. 部署

部署流程如下：

```text
ZIP 上传 -> SFTP 传输 -> SHA-256 校验 -> staging 解压
-> 生成不可变版本 -> 原子切换软链接 -> 健康检查
```

项目部署期间会创建锁，防止同一个项目同时执行两个会破坏版本状态的操作。

## Nginx 运维

Linux 项目可在“项目设置 → Linux 运维”中配置：

- Nginx 控制方式：可执行文件或 systemd。
- Nginx 可执行文件，例如 `/home/nginx/nginx/sbin/nginx`。
- Nginx 配置文件；留空时使用该二进制编译时的默认配置。
- systemd 服务名，例如 `nginx.service`。
- access/error 日志路径。
- 健康检查地址、Host 请求头和超时。

### 查找 Nginx 可执行文件

```bash
command -v nginx
ps -eo pid,user,args | grep '[n]ginx: master process'
```

自编译安装可能位于：

```text
/home/nginx/nginx/sbin/nginx
/usr/local/nginx/sbin/nginx
```

### 查找 systemd 服务名

```bash
systemctl list-unit-files --type=service | grep -Ei 'nginx|openresty|tengine'
systemctl list-units --type=service --all | grep -Ei 'nginx|openresty|tengine'
```

如果没有结果，但能找到 Nginx master 进程和可执行文件，说明它可能是脚本或手动启动的，应使用“可执行文件”控制方式。

### 查找日志路径

```bash
/home/nginx/nginx/sbin/nginx -T 2>&1 | grep -E 'access_log|error_log'
```

常见路径：

```text
/home/nginx/nginx/logs/access.log
/home/nginx/nginx/logs/error.log
/var/log/nginx/access.log
/var/log/nginx/error.log
```

### 操作规则

- “校验配置”只执行 Nginx `-t`。
- reload 和 restart 执行前都会先校验配置。
- systemd 模式通过保存的服务名控制服务。
- 可执行文件模式直接调用配置的 Nginx 二进制。
- restart 可能造成短暂中断，优先使用 reload。

SSH 用户需要具备相应权限。如果 Nginx 由其他用户或 root 启动，应提前配置受限的 sudo/systemd 权限，避免授予无关命令权限。

## 健康检查和回滚

健康检查地址必须是没有账号密码的 HTTP 或 HTTPS 地址，例如：

```text
http://127.0.0.1/health
https://example.com/
```

如果同一 IP 上有多个虚拟主机，可单独填写 Host 请求头。配置健康检查后，版本上线、切换和一键回滚完成时都会检查站点状态。

一键回滚优先使用管理器记录的上一个线上版本。对于首次导入的旧脚本项目，在没有切换历史时只选择当前版本之前最近的版本，不会回滚到更新但未上线的目录。

## 远程诊断和文件浏览

“远程诊断”会只读检查：

- Linux 发行版、内核、当前用户和 init 系统。
- 内存、磁盘和项目目录。
- 部署工具是否存在。
- Nginx master 进程、编译信息、配置文件和 systemd 单元。
- 监听端口。

“文件浏览”通过 SFTP 提供只读访问：

- 只能浏览当前项目的线上目录和版本仓库。
- 每次访问都会使用服务器 `realpath` 校验，项目内软链接不能跳到未授权目录。
- 只允许预览 512KB 以内的文本文件。
- 不提供修改、上传和删除入口，避免破坏不可变版本。

## 运行日志

点击项目顶部的“运行日志”可以选择三种来源：

### Deploy Manager

记录当前管理器进程中的：

- 服务启动事件。
- API 请求方法、路径、状态码和耗时。
- 部署、同步、Nginx 操作、回滚等任务的开始、完成和错误。

管理器日志使用最多 1000 条的内存环形缓冲区，服务重启后清空。日志不会保存请求体、SSH 密码、私钥或口令。

### Nginx access/error

远程日志路径必须预先保存在项目设置中，接口不能接收任意服务器文件路径。

- 可显示最近 100、200、500 或 1000 行。
- 支持内容搜索、手动刷新、实时刷新和暂停。
- 实时模式每 5 秒刷新，避免频繁建立 SSH 连接。
- 单行最多读取 8KB。
- access 日志按 HTTP 4xx/5xx 标记警告和错误。
- error 日志识别 Nginx 的 warn/error/crit 等级。

读取 Nginx 日志时，SSH 用户必须拥有对应文件的读取权限。

## 数据和备份

项目、服务器、版本和操作记录保存在：

```text
data/db.json
```

建议定期备份这个文件。它不保存 SSH 密码和私钥口令，但会保存服务器地址、用户名、私钥文件路径、主机指纹和项目配置。

临时上传文件保存在 `data/tmp-uploads`，部署结束后会自动清理。

## 安全说明

- 当前版本没有用户登录和权限系统，默认只允许本机访问。
- 不要把 3000 端口直接暴露到公网。
- 浏览器提交 SSH 密码时使用的是管理器当前的 HTTP 连接。HTTP 本身不加密，因此远程使用时应通过 SSH 隧道访问，或在前面配置带 HTTPS 和访问认证的反向代理。
- 推荐的 SSH 隧道：

  ```bash
  ssh -L 3000:127.0.0.1:3000 windows-server
  ```

- Linux SSH 用户应只拥有部署目录和必要 Nginx 操作权限。
- SFTP 浏览器和日志接口都有服务端路径限制，但这不能替代正确的 Linux 文件权限。
- 删除项目默认只移除管理器元数据；只有明确选择同时删除文件时才会删除受管目录。

## 常见问题

### 接口返回 404

确认当前运行的 Node.js 服务已经重启到最新代码，并直接访问：

```text
http://127.0.0.1:3000/api/projects
```

如果页面仍引用旧资源，执行一次强制刷新。

### Nginx 日志返回 400

400 表示路由已经存在，但项目配置、SSH 会话、文件路径或读取权限不满足。依次检查：

1. SSH 服务器是否显示“本次会话已连接”。
2. 项目是否配置了 access/error 日志绝对路径。
3. SSH 用户能否执行 `tail` 并读取该日志文件。

### 服务重启后为什么需要重新输入 SSH 密码

这是预期行为。凭据只保存在内存中，服务重启后会被清除；重新连接一次后，本次会话中的后续操作不再重复询问。

### 切换版本后仍看到旧资源

先检查浏览器/CDN缓存。如果 Nginx 配置了 `open_file_cache`，也可能短时间复用旧文件句柄，建议关闭对应静态目录的缓存或缩短有效期。
