# Base64 Image Externalizer

把 Obsidian 笔记里内嵌的 Base64 图片存成附件，让正文和搜索结果清爽一些。适合整理从 AI 对话等地方导入的 Markdown。

支持 Markdown 图片语法中的 JPEG、PNG、GIF 和 WebP，也能识别标成 `application/octet-stream` 的这些图片。提取时保留原始图片字节，不压缩、不转码；相同内容复用同一份附件。

## 安装

需要 Obsidian 1.7.2 或更新版本。

1. 下载本仓库的 `main.js`、`manifest.json` 和 `styles.css`。
2. 在笔记库中创建 `.obsidian/plugins/base64-image-externalizer/`，把这三个文件放进去。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Base64 Image Externalizer**。

## 使用

默认会在粘贴内容、新建或修改 Markdown 文件后自动提取图片。附件放在 `Attachments/Images/`，可以在插件设置中更改。

命令面板里有三个操作：

- **Externalize base64 images in current file**：处理当前笔记。
- **Externalize base64 images in all files**：处理整个笔记库。
- **Bake externalized images back to base64 in current file**：把当前笔记的图片重新嵌入正文。先在设置中关闭两项自动处理并重启 Obsidian，就能保留还原后的 Base64 内容。

鼠标移到笔记中显示的本地图片上，会出现复制按钮，也可以右键选择 **Copy image**。

插件在附件目录保存一个 JSON 索引，用来记录图片与笔记的对应关系，还原时会用到它。还原后附件仍会保留。

MIT License
