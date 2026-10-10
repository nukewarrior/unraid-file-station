# Unraid File Station

在 **Unraid WebGUI** 内提供接近 Synology DSM File Station 的文件管理体验，同时保留 Unraid 的顶部导航、Shares 设置页以及原生文件管理器。

> **开发状态：v0.1 只读预览，针对 Unraid 7.2.2 设计。** 尚未在真实 NAS 上完成端到端验证。请勿将它理解为完整的 DSM File Station 替代品。
>
> 项目与 Unraid、Synology 均无官方关联。设计灵感来自 Synology DSM File Station。

## 已经实现

- 从 Shares 页每个共享旁边的 **蓝色 Browse 图标** 进入 File Station，自动定位到对应目录。
- 在 Shares 页增加独立 **FILE STATION** 按钮，进入全部共享的根目录。
- 保留 Unraid 顶部导航与现有 Share 名称链接（Share 名称仍进入共享设置）。
- 在 Browse 页面中嵌入新的文件管理区域，不修改 Unraid 系统文件。
- 通过 Unraid 7.2.2 的 \`/webGui/include/Browse.php\` 读取真实目录，限定为 \`/mnt/user\`。
- 目录树、目录标签页、面包屑路径、后退/前进、上一级、刷新。
- 列表/网格视图、当前目录过滤、文件夹优先排序。
- 单选、Ctrl/⌘ 多选、Shift 连选、Ctrl/⌘+A、Escape 取消。
- 文件右键菜单、路径复制、单文件下载。
- 可选详细信息侧栏和两种主题（Unraid 融合 / DSM 经典）。
- 一键切回原生文件管理器；可随时重新启用，回退状态保存在浏览器本地。

## 尚未实现

- 新建、重命名、上传、复制、移动、删除等 **写入操作**。
- 图片/PDF/视频在线预览、缩略图缓存、压缩/解压和后台任务中心。
- Flash、单独物理磁盘、缓存池的直接浏览。
- 完整 DSM 风格的高级鼠标拖放以及文件夹批量下载。

工具栏中的写入按钮目前会显示说明，不会向 Unraid 提交写入请求。需要写入时请切换回原生文件管理器。

## 安装（开发预览版）

1. 在浏览器中安装 Tampermonkey 或其他兼容的用户脚本管理器。
2. 打开 \`src/unraid-file-station.user.js\` 的 Raw 地址，安装脚本。
3. **建议在用户脚本管理器中将匹配地址收窄为自己的 NAS 主机名或 IP。** 默认规则匹配任何主机上的 \`/Shares*\` 路径，仅为兼容不同 Unraid 主机名。
4. 打开 Unraid 7.2.2 的 **SHARES** 页，点击共享名称左边的蓝色浏览图标；或者点击 Shares 下方新出现的 **FILE STATION** 按钮。
5. File Station 右上角的 **返回原生** 可以恢复原生文件管理页面；原生页面上会有 **打开 File Station** 按钮用于切回。

示例：如果你的 Unraid 地址是 \`http://tower\`，可将用户脚本头部的通用匹配规则改为：

\`\`\`javascript
// @match        http://tower/Shares*
// @match        http://tower/Main/Browse*
\`\`\`

如果使用 IP、端口、HTTPS 或自定义域名，请相应调整。不要直接使用示例地址覆盖自己的 NAS 地址。

**脚本只向同源 Unraid WebGUI 发送目录读取请求**，不需要 API Key、数据库、额外 Docker 容器或 NAS root shell 权限。尽管当前只读，也建议先在非关键目录试用。

### 兼容条件

当前仅对 Unraid **7.2.2** 的以下官方源码进行了结构核对：

- [ShareList.php](https://github.com/unraid/webgui/blob/7.2.2/emhttp/plugins/dynamix/include/ShareList.php)
- [Browse.page](https://github.com/unraid/webgui/blob/7.2.2/emhttp/plugins/dynamix/Browse.page)
- [Browse.php](https://github.com/unraid/webgui/blob/7.2.2/emhttp/plugins/dynamix/include/Browse.php)
- [Control.php](https://github.com/unraid/webgui/blob/7.2.2/emhttp/plugins/dynamix/include/Control.php)

这些是 Unraid WebGUI 的内部实现，不是稳定公开 API。未来升级后可能需要调整解析器。其他版本尚未验证。

## 无 NAS 的本地演示

\`\`\`bash
git clone https://github.com/nukewarrior/unraid-file-station.git
cd unraid-file-station
python3 -m http.server 8088
\`\`\`

然后访问：\`http://127.0.0.1:8088/demo/\`

演示页带模拟文件夹和文件，可以测试主题、目录树、标签页、列表/网格切换、文件多选与右键菜单。**演示模式没有真实文件写入或下载**，也不需要访问 NAS。演示里的 Unraid 导航仅是静态外观，不包含管理功能。

## 开发与测试

- 代码：\`src/unraid-file-station.user.js\`，纯原生 JavaScript，无第三方运行依赖。
- 演示：\`demo/index.html\`，静态网页，复用同一脚本。
- 静态检查：\`node --check src/unraid-file-station.user.js\`。
- 自动检查：\`node --test tests/*.test.mjs\`。
- 人工验收：\`docs/acceptance.md\`。

建议在真实 Unraid 上分别测试目录名含中文、空格、引号、括号与特殊字符的情况，浏览器返回行为，以及白色和黑色 WebGUI 主题。只读版不应更改 NAS 端任何文件。

## 技术与安全原则

- **不更改 Unraid 系统文件**，通过浏览器用户脚本实现可逆接入。
- **只读优先**：当前所有文件操作请求只有 GET 目录请求；下载采用原生文件 URL，写入功能暂不调用 \`Control.php\`。
- **路径边界**：只允许 \`/mnt/user\` 及其子目录，不让用户共享与物理磁盘路径互相拖放。
- **视图与数据隔离**：动态文件名使用 \`textContent\` 渲染，不直接拼入 HTML 字符串。
- **同源请求**：使用已有 Unraid 登录会话，无第三方上传或数据收集。
- **回退开关**：浏览器保存用户偏好，关闭/卸载脚本立即恢复原生 WebGUI。

## Roadmap

| 阶段 | 内容 |
| --- | --- |
| v0.1 | 嵌入式界面、真实只读目录浏览、交互演示与原生回退 |
| v0.2 | 验证路径与 API 行为，安全适配原生创建、重命名、上传、复制/移动、删除 |
| v0.3 | 图片/PDF 预览、媒体缩略图、后台任务队列 |
| v1.0 | 稳定的插件安装方式、跨 Unraid 版本适配与完整验收 |

在 v0.2 引入任何写入操作之前，需要验证 Unraid 7.2.2 现有后台任务行为、复制覆盖冲突、路径编码、文件系统边界和权限限制，并对所有危险操作加确认流程。

## License

参见仓库根目录的 [LICENSE](LICENSE)。
