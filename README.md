# 手机登录问题测试记录系统

这个项目用于批量测试手机访问国外登录页面的问题，记录电话号码、手机信息、问题描述和解决方案。

## 页面

- 手机测试页：`http://42.192.109.248/test.html`
- 后台管理页：`http://42.192.109.248/admin`

## 本地运行

```powershell
$env:PORT=3000
node server.js
```

访问：

- `http://127.0.0.1:3000/test.html`
- `http://127.0.0.1:3000/admin`

## 服务器运行

80 端口已开放时，在服务器项目目录执行：

```bash
PORT=80 node server.js
```

建议使用 `systemd` 或 `pm2` 做常驻进程。Linux 上监听 80 端口通常需要 root 权限，或者给 Node 配置低端口绑定能力。

## 服务器压测

后台 `/admin` 里有两个性能测试板块：

- 服务器压测：填写压测时长和并发数，在固定时间内持续请求，观察 RPS 和延迟。
- 并发测试：填写总请求数和并发数，观察固定请求量在并发下多久完成。

为了避免这个工具被误用成任意目标压测入口，后端默认只允许压测：

```text
42.192.109.248
127.0.0.1
localhost
```

如果需要增加授权目标，在启动时配置：

```bash
LOAD_TEST_ALLOWED_HOSTS=42.192.109.248,example.com PORT=80 node server.js
```

内置限制：

- 压测时长：1 到 60 秒
- 服务器压测并发数：1 到 50
- 并发测试总请求数：1 到 1000
- 并发测试并发数：1 到 100
- 单请求超时：5 秒

## 数据文件

记录保存在：

```text
data/records.json
```

备份时复制这个文件即可。后台的“导出 CSV”也可以用于日常备份和 Excel 分析。

## CSV 导入字段

后台支持导入 CSV，推荐表头：

```csv
phone,brand,model,os,browser,status,loginResult,issue,solution,networkSummary,targetUrl,userAgent,screen,language,timezone,notes,createdAt,updatedAt
```

`status` 可填写：

- `open`：待处理
- `blocked`：阻塞
- `resolved`：已解决
