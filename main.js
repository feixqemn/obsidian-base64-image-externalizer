"use strict";

const {
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  base64ToArrayBuffer,
  setIcon,
} = require("obsidian");

const DEFAULT_SETTINGS = {
  outputFolder: "Attachments/Images",
  indexPath: "Attachments/Images/image-externalizer-index.json",
  autoProcessOnPaste: true,
  autoProcessOnFileChange: true,
  quickCopyRenderedImages: true,
};

const INDEX_VERSION = 1;
const DATA_URI_IMAGE = /!\[([^\]]*)\]\(data:(image\/(?:jpeg|jpg|png|gif|webp)|application\/octet-stream);base64,([A-Za-z0-9+/=\s\r\n]+)\)/gi;

module.exports = class Base64ImageExternalizerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.processing = new Set();
    this.pendingTimers = new Map();
    this.activeImageEl = null;

    this.addCommand({
      id: "externalize-current-file",
      name: "Externalize base64 images in current file",
      editorCallback: async (editor, view) => {
        await this.processEditor(editor, view.file, true);
      },
    });

    this.addCommand({
      id: "externalize-all-files",
      name: "Externalize base64 images in all files",
      callback: async () => {
        await this.processAllFiles();
      },
    });

    this.addCommand({
      id: "bake-current-file",
      name: "Bake externalized images back to base64 in current file",
      editorCallback: async (editor, view) => {
        await this.bakeEditor(editor, view.file);
      },
    });

    this.addSettingTab(new Base64ImageExternalizerSettingTab(this.app, this));
    this.registerQuickCopy();

    if (this.settings.autoProcessOnPaste) {
      this.registerEvent(
        this.app.workspace.on("editor-paste", (_event, editor) => {
          window.setTimeout(async () => {
            const file = this.app.workspace.getActiveFile();
            await this.processEditor(editor, file, false);
          }, 250);
        })
      );
    }

    if (this.settings.autoProcessOnFileChange) {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          this.scheduleFile(file);
        })
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          this.scheduleFile(file);
        })
      );
    }
  }

  onunload() {
    for (const timer of this.pendingTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  registerQuickCopy() {
    this.copyButton = document.body.createEl("button", {
      cls: "base64-image-externalizer-copy-button",
      attr: {
        type: "button",
        "aria-label": "Copy image",
        title: "Copy image",
      },
    });
    setIcon(this.copyButton, "copy");
    this.copyButton.hide();

    this.registerDomEvent(this.copyButton, "click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const attachmentPath = this.copyButton.dataset.attachmentPath;
      if (!attachmentPath) return;
      await this.copyImageToClipboard(attachmentPath);
    });

    this.registerMarkdownPostProcessor((el, ctx) => {
      for (const img of el.querySelectorAll("img")) {
        const attachmentPath = this.resolveImagePath(img, ctx.sourcePath);
        if (attachmentPath) {
          img.dataset.base64ImageExternalizerAttachment = attachmentPath;
        }
      }
    });

    this.registerDomEvent(
      document,
      "mouseover",
      (event) => {
        if (!this.settings.quickCopyRenderedImages) return;
        const img = this.closestRenderedImage(event.target);
        if (!img) {
          if (!(event.target instanceof HTMLElement) || !event.target.closest(".base64-image-externalizer-copy-button")) {
            this.hideCopyButton();
          }
          return;
        }
        const attachmentPath = this.resolveImagePath(img);
        if (!attachmentPath) return;
        this.showCopyButton(img, attachmentPath);
      },
      { capture: true }
    );

    this.registerDomEvent(
      document,
      "contextmenu",
      (event) => {
        if (!this.settings.quickCopyRenderedImages) return;
        const img = this.closestRenderedImage(event.target);
        if (!img) return;
        const attachmentPath = this.resolveImagePath(img);
        if (!attachmentPath) return;

        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle("Copy image")
            .setIcon("copy")
            .onClick(async () => {
              await this.copyImageToClipboard(attachmentPath);
            });
        });
        menu.showAtMouseEvent(event);
      },
      { capture: true }
    );

    this.registerDomEvent(window, "scroll", () => this.repositionCopyButton(), true);
    this.registerDomEvent(window, "resize", () => this.hideCopyButton());
  }

  closestRenderedImage(target) {
    if (!(target instanceof HTMLElement)) return null;
    if (target.closest(".base64-image-externalizer-copy-button")) return null;
    const img = target.closest("img");
    if (!(img instanceof HTMLImageElement)) return null;
    if (!img.closest(".markdown-preview-view, .markdown-source-view, .markdown-rendered")) return null;
    return img;
  }

  showCopyButton(img, attachmentPath) {
    this.activeImageEl = img;
    this.copyButton.dataset.attachmentPath = attachmentPath;
    this.copyButton.show();
    this.repositionCopyButton();
  }

  repositionCopyButton() {
    const img = this.activeImageEl;
    if (!img || !this.copyButton || this.copyButton.hidden) return;
    if (!document.body.contains(img)) {
      this.hideCopyButton();
      return;
    }
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
      this.hideCopyButton();
      return;
    }
    const buttonSize = 30;
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - buttonSize - margin, rect.right - buttonSize - margin));
    const top = Math.max(margin, rect.top + margin);
    this.copyButton.style.left = `${left}px`;
    this.copyButton.style.top = `${top}px`;
  }

  hideCopyButton() {
    if (!this.copyButton) return;
    this.copyButton.hide();
    delete this.copyButton.dataset.attachmentPath;
    this.activeImageEl = null;
  }

  resolveImagePath(img, sourcePath) {
    const taggedPath = img.dataset.base64ImageExternalizerAttachment;
    if (taggedPath && this.app.vault.getAbstractFileByPath(taggedPath)) return taggedPath;

    const src = img.getAttribute("src") || "";
    const resolvedFromSrc = this.resolveImagePathFromSrc(src);
    if (resolvedFromSrc) return resolvedFromSrc;

    const attrPath = img.getAttribute("data-path") || img.getAttribute("alt") || "";
    const resolvedFromAttr = this.resolveLinkPath(attrPath, sourcePath);
    if (resolvedFromAttr) return resolvedFromAttr;

    return null;
  }

  resolveImagePathFromSrc(src) {
    if (!src || src.startsWith("data:") || /^https?:\/\//i.test(src)) return null;

    const candidates = new Set();
    candidates.add(src);

    try {
      const parsed = new URL(src);
      candidates.add(decodeURIComponent(parsed.pathname || ""));
      candidates.add(decodeURIComponent(`${parsed.hostname || ""}${parsed.pathname || ""}`));
    } catch (_error) {
      try {
        candidates.add(decodeURIComponent(src));
      } catch (_decodeError) {
        candidates.add(src);
      }
    }

    const basePath = this.getVaultBasePath();
    for (const candidate of candidates) {
      const normalizedCandidate = normalizePath(candidate.replace(/[?#].*$/, ""));
      if (basePath) {
        const normalizedBase = normalizePath(basePath);
        if (normalizedCandidate.startsWith(`${normalizedBase}/`)) {
          const relativePath = normalizedCandidate.slice(normalizedBase.length + 1);
          if (this.app.vault.getAbstractFileByPath(relativePath)) return relativePath;
        }
      }

      const outputFolder = normalizePath(this.settings.outputFolder);
      const folderIndex = normalizedCandidate.indexOf(`${outputFolder}/`);
      if (folderIndex >= 0) {
        const relativePath = normalizedCandidate.slice(folderIndex);
        if (this.app.vault.getAbstractFileByPath(relativePath)) return relativePath;
      }

      if (this.app.vault.getAbstractFileByPath(normalizedCandidate)) return normalizedCandidate;
    }

    return null;
  }

  resolveLinkPath(linkPath, sourcePath) {
    if (!linkPath) return null;
    const cleanLinkPath = linkPath.replace(/[|#].*$/, "").trim();
    if (!cleanLinkPath) return null;
    const file = this.app.metadataCache.getFirstLinkpathDest(cleanLinkPath, sourcePath || this.app.workspace.getActiveFile()?.path || "");
    return file ? file.path : null;
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath !== "function") return "";
    try {
      return adapter.getBasePath();
    } catch (_error) {
      return "";
    }
  }

  async copyImageToClipboard(attachmentPath) {
    const normalizedPath = normalizePath(attachmentPath);
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      new Notice("Image file not found.");
      return;
    }

    const fullPath = this.getFullAttachmentPath(normalizedPath);
    if (fullPath && this.copyImageWithElectron(fullPath)) {
      new Notice("Image copied.");
      return;
    }

    try {
      const binary = await this.app.vault.adapter.readBinary(normalizedPath);
      const mime = this.mimeFromPath(normalizedPath);
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("Image clipboard API is not available.");
      }
      const blob = new Blob([binary], { type: mime });
      await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      new Notice("Image copied.");
    } catch (error) {
      console.error("Failed to copy image", error);
      new Notice("Could not copy this image.");
    }
  }

  copyImageWithElectron(fullPath) {
    try {
      const electronRequire = window.require || require;
      const { clipboard, nativeImage } = electronRequire("electron");
      const image = nativeImage.createFromPath(fullPath);
      if (!image || image.isEmpty()) return false;
      clipboard.writeImage(image);
      return true;
    } catch (error) {
      console.debug("Electron image clipboard copy is unavailable", error);
      return false;
    }
  }

  getFullAttachmentPath(attachmentPath) {
    const basePath = this.getVaultBasePath();
    if (!basePath) return "";
    return `${basePath}/${attachmentPath}`;
  }

  mimeFromPath(path) {
    const lowerPath = path.toLowerCase();
    if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
    if (lowerPath.endsWith(".gif")) return "image/gif";
    if (lowerPath.endsWith(".webp")) return "image/webp";
    return "image/png";
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleFile(file) {
    if (!file || file.extension !== "md") return;
    if (this.pendingTimers.has(file.path)) {
      window.clearTimeout(this.pendingTimers.get(file.path));
    }
    const timer = window.setTimeout(async () => {
      this.pendingTimers.delete(file.path);
      await this.processFile(file, false);
    }, 1200);
    this.pendingTimers.set(file.path, timer);
  }

  async processAllFiles() {
    const files = this.app.vault.getMarkdownFiles();
    let converted = 0;
    let touched = 0;
    new Notice(`Scanning ${files.length} Markdown files for base64 images...`);

    for (const file of files) {
      const result = await this.processFile(file, false);
      converted += result.converted;
      if (result.changed) touched += 1;
    }

    new Notice(`Externalized ${converted} image${converted === 1 ? "" : "s"} in ${touched} file${touched === 1 ? "" : "s"}.`);
  }

  async processEditor(editor, file, notify) {
    if (!file) {
      if (notify) new Notice("No active Markdown file.");
      return { changed: false, converted: 0 };
    }
    const content = editor.getValue();
    const result = await this.externalizeContent(content, file.path);
    if (!result.changed) {
      if (notify) new Notice("No JPEG/PNG base64 images found.");
      return result;
    }
    editor.setValue(result.content);
    if (notify) {
      new Notice(`Externalized ${result.converted} base64 image${result.converted === 1 ? "" : "s"}.`);
    }
    return result;
  }

  async processFile(file, notify) {
    if (!file || file.extension !== "md") return { changed: false, converted: 0 };
    if (this.processing.has(file.path)) return { changed: false, converted: 0 };

    this.processing.add(file.path);
    try {
      const content = await this.app.vault.read(file);
      const result = await this.externalizeContent(content, file.path);
      if (!result.changed) return result;
      await this.app.vault.modify(file, result.content);
      if (notify) {
        new Notice(`Externalized ${result.converted} base64 image${result.converted === 1 ? "" : "s"} in ${file.path}.`);
      }
      return result;
    } finally {
      this.processing.delete(file.path);
    }
  }

  async externalizeContent(content, notePath) {
    const matches = Array.from(content.matchAll(DATA_URI_IMAGE));
    if (matches.length === 0) {
      DATA_URI_IMAGE.lastIndex = 0;
      return { changed: false, converted: 0, content };
    }

    await this.ensureFolder(this.settings.outputFolder);
    await this.ensureParentFolder(this.settings.indexPath);
    const index = await this.loadIndex();
    const newEntries = [];
    let converted = 0;

    const replacementByFullMatch = new Map();
    for (const match of matches) {
      const fullMatch = match[0];
      const altText = match[1] || "";
      const sourceMime = (match[2] || "").toLowerCase();
      const cleanBase64 = (match[3] || "").replace(/\s+/g, "");
      let binary;
      try {
        binary = base64ToArrayBuffer(cleanBase64);
      } catch (error) {
        console.warn("Skipping invalid base64 image data URI", error);
        continue;
      }

      const imageType = this.resolveImageType(sourceMime, binary);
      if (!imageType) continue;

      const { mime, extension, inferredFromMagic } = imageType;
      const sha256 = await this.sha256Hex(binary);
      const attachmentPath = normalizePath(`${this.settings.outputFolder}/img-${sha256.slice(0, 32)}.${extension}`);

      if (!(await this.app.vault.adapter.exists(attachmentPath))) {
        await this.app.vault.adapter.writeBinary(attachmentPath, binary);
      }

      const markdownPath = this.escapeMarkdownDestination(attachmentPath);
      replacementByFullMatch.set(fullMatch, `![${altText}](${markdownPath})`);
      newEntries.push({
        id: `${notePath}:${sha256}:${newEntries.length}`,
        notePath,
        attachmentPath,
        mime,
        sourceMime,
        extension,
        sha256,
        altText,
        inferredFromMagic,
        createdAt: new Date().toISOString(),
      });
      converted += 1;
    }

    let newContent = content;
    for (const [fullMatch, replacement] of replacementByFullMatch.entries()) {
      newContent = newContent.split(fullMatch).join(replacement);
    }

    if (newEntries.length > 0) {
      this.mergeIndexEntries(index, newEntries);
      await this.saveIndex(index);
    }
    return { changed: newContent !== content, converted, content: newContent };
  }

  async bakeEditor(editor, file) {
    if (!file) {
      new Notice("No active Markdown file.");
      return;
    }
    const index = await this.loadIndex();
    const entries = index.entries.filter((entry) => entry.notePath === file.path);
    if (entries.length === 0) {
      new Notice("No externalized images indexed for this file.");
      return;
    }

    let content = editor.getValue();
    let baked = 0;
    for (const entry of entries) {
      if (!(await this.app.vault.adapter.exists(entry.attachmentPath))) continue;
      const binary = await this.app.vault.adapter.readBinary(entry.attachmentPath);
      const base64 = this.arrayBufferToBase64(binary);
      const dataUri = `![${entry.altText || ""}](data:${entry.sourceMime || entry.mime};base64,${base64})`;
      const plainLink = `![${entry.altText || ""}](${entry.attachmentPath})`;
      const escapedLink = `![${entry.altText || ""}](${this.escapeMarkdownDestination(entry.attachmentPath)})`;
      const before = content;
      content = content.split(plainLink).join(dataUri);
      content = content.split(escapedLink).join(dataUri);
      if (content !== before) baked += 1;
    }

    if (baked === 0) {
      new Notice("No matching attachment links found to bake.");
      return;
    }
    editor.setValue(content);
    new Notice(`Baked ${baked} image${baked === 1 ? "" : "s"} back to base64. Search will include those base64 strings again.`);
  }

  async loadIndex() {
    try {
      if (!(await this.app.vault.adapter.exists(this.settings.indexPath))) {
        return this.emptyIndex();
      }
      const raw = await this.app.vault.adapter.read(this.settings.indexPath);
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return this.emptyIndex();
      parsed.version = INDEX_VERSION;
      parsed.entries = parsed.entries.filter((entry) => entry && entry.notePath && entry.attachmentPath && entry.mime && entry.sha256);
      return parsed;
    } catch (error) {
      console.error("Failed to load base64 image index", error);
      return this.emptyIndex();
    }
  }

  async saveIndex(index) {
    const cleanIndex = {
      version: INDEX_VERSION,
      generatedBy: "base64-image-externalizer",
      updatedAt: new Date().toISOString(),
      entries: index.entries,
    };
    await this.ensureParentFolder(this.settings.indexPath);
    await this.app.vault.adapter.write(this.settings.indexPath, `${JSON.stringify(cleanIndex, null, 2)}\n`);
  }

  emptyIndex() {
    return {
      version: INDEX_VERSION,
      generatedBy: "base64-image-externalizer",
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }

  mergeIndexEntries(index, newEntries) {
    const seen = new Set(index.entries.map((entry) => `${entry.notePath}\n${entry.attachmentPath}\n${entry.sha256}`));
    for (const entry of newEntries) {
      const key = `${entry.notePath}\n${entry.attachmentPath}\n${entry.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      index.entries.push(entry);
    }
  }

  async ensureParentFolder(path) {
    const folder = normalizePath(path).split("/").slice(0, -1).join("/");
    await this.ensureFolder(folder);
  }

  async ensureFolder(folder) {
    const normalized = normalizePath(folder || "");
    if (!normalized) return;
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  async sha256Hex(arrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  escapeMarkdownDestination(path) {
    return normalizePath(path).replace(/ /g, "%20");
  }

  resolveImageType(sourceMime, arrayBuffer) {
    if (sourceMime === "image/png") {
      return { mime: "image/png", extension: "png", inferredFromMagic: false };
    }
    if (sourceMime === "image/jpeg" || sourceMime === "image/jpg") {
      return { mime: "image/jpeg", extension: "jpg", inferredFromMagic: false };
    }
    if (sourceMime === "image/gif") {
      return { mime: "image/gif", extension: "gif", inferredFromMagic: false };
    }
    if (sourceMime === "image/webp") {
      return { mime: "image/webp", extension: "webp", inferredFromMagic: false };
    }
    if (sourceMime !== "application/octet-stream") return null;

    const bytes = new Uint8Array(arrayBuffer);
    if (this.hasJpegMagic(bytes)) {
      return { mime: "image/jpeg", extension: "jpg", inferredFromMagic: true };
    }
    if (this.hasPngMagic(bytes)) {
      return { mime: "image/png", extension: "png", inferredFromMagic: true };
    }
    if (this.hasGifMagic(bytes)) {
      return { mime: "image/gif", extension: "gif", inferredFromMagic: true };
    }
    if (this.hasWebpMagic(bytes)) {
      return { mime: "image/webp", extension: "webp", inferredFromMagic: true };
    }
    return null;
  }

  hasJpegMagic(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  hasPngMagic(bytes) {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }

  hasGifMagic(bytes) {
    return (
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    );
  }

  hasWebpMagic(bytes) {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
};

class Base64ImageExternalizerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "Extracts JPEG/PNG data URI images, including octet-stream data only when the bytes prove JPEG/PNG. It decodes base64 directly and does not transcode, compress, resize, or store base64 in the index.",
      cls: "base64-image-externalizer-setting-note",
    });

    new Setting(containerEl)
      .setName("Attachment folder")
      .setDesc("Folder where extracted image files are saved.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = normalizePath(value || DEFAULT_SETTINGS.outputFolder);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Index path")
      .setDesc("Non-Markdown JSON index used for optional reverse baking.")
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.indexPath)
          .setValue(this.plugin.settings.indexPath)
          .onChange(async (value) => {
            this.plugin.settings.indexPath = normalizePath(value || DEFAULT_SETTINGS.indexPath);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-process pasted content")
      .setDesc("After paste, scan the current note and externalize verified JPEG/PNG base64 images.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoProcessOnPaste)
          .onChange(async (value) => {
            this.plugin.settings.autoProcessOnPaste = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian to apply this event setting.");
          });
      });

    new Setting(containerEl)
      .setName("Auto-process file changes")
      .setDesc("When Markdown files are created or modified, scan them for imported verified JPEG/PNG base64 images.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoProcessOnFileChange)
          .onChange(async (value) => {
            this.plugin.settings.autoProcessOnFileChange = value;
            await this.plugin.saveSettings();
            new Notice("Reload Obsidian to apply this event setting.");
          });
      });

    new Setting(containerEl)
      .setName("Quick-copy rendered images")
      .setDesc("Show a small copy button on rendered note images and add Copy image to their right-click menu.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.quickCopyRenderedImages)
          .onChange(async (value) => {
            this.plugin.settings.quickCopyRenderedImages = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
