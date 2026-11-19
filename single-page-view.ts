import { ItemView, WorkspaceLeaf, TFile, Notice, loadPdfJs } from "obsidian";
import {
  Annotation,
  AnnotationFile,
  AnnotationType,
  HighlightColor,
  PdfAnnotateSettings,
  newAnnotationId,
} from "../types";
import {
  JsPdfDocument,
  JsPdfPage,
  PdfJsLib,
  PDFViewer,
} from "./obsidian-pdf-types";
import { selectionToQuads } from "./geometry";
import { Highlighter } from "./highlighter";

export const SINGLE_PAGE_VIEW_TYPE = "pdf-annotate-single";

/**
 * 宿主回调：由主插件注入，复用已有的存储、设置、评论、侧边栏能力。
 */
export interface SinglePageHost {
  getSettings(): PdfAnnotateSettings;
  loadAnnotationData(file: TFile): Promise<AnnotationFile>;
  saveAnnotationData(file: TFile, data: AnnotationFile): Promise<void>;
  /** 打开评论弹窗（标注对象会被原地修改，保存/删除由视图回调处理） */
  hostOpenComment(
    annot: Annotation,
    isNew: boolean,
    onChanged: () => void
  ): void;
  /** 通知侧边栏刷新 */
  refreshSidebar(file: TFile | null, annotations: Annotation[]): void;
  /** 报告当前单页视图的上下文，供全局命令使用 */
  setActive(file: TFile | null, data: AnnotationFile | null): void;
  /** 注册/注销当前活动的单页视图实例（供标注路由定位阅读器） */
  registerSingleView(view: SinglePagePDFView | null): void;
}

/**
 * 自研单页 PDF 阅读视图。
 *
 * 与 Obsidian 原生 PDF 查看器完全独立：一次只渲染当前一页的 canvas + 文本层，
 * 翻页时销毁上一页资源，从根本上保证「只加载这一页」，不受原生查看器缩放重置影响。
 * 缩放通过重新渲染当前页实现，标注使用归一化坐标，天然贴合。
 */
export class SinglePagePDFView extends ItemView {
  private file: TFile | null = null;
  private data: AnnotationFile | null = null;
  private doc: JsPdfDocument | null = null;
  /** 已加载的内置 PDF.js 库实例（通过 loadPdfJs 获取，兼容按需加载）。 */
  private pdfjsLib: PdfJsLib | null = null;
  private currentPage = 1;
  private scale = 1;
  private renderSeq = 0;

  private pageEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private currentJsPage: JsPdfPage | null = null;
  private highlighter: Highlighter | null = null;

  private toolbarPageLabel: HTMLElement | null = null;
  private toolbarZoomLabel: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private host: SinglePageHost) {
    super(leaf);
  }

  getViewType(): string {
    return SINGLE_PAGE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? `单页 · ${this.file.basename}` : "单页 PDF";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    this.buildUi();
    this.host.registerSingleView(this);
  }

  async onClose(): Promise<void> {
    this.host.registerSingleView(null);
    this.host.setActive(null, null);
    this.releasePage();
    if (this.doc) {
      try { await this.doc.destroy(); } catch (_) { /* ignore */ }
      this.doc = null;
    }
    this.contentEl.empty();
  }

  /** 打开指定 PDF 文件。 */
  async openFile(file: TFile, page = 1, scale = 1): Promise<void> {
    this.file = file;
    this.scale = scale > 0 ? scale : 1;
    // 不在数据加载前调用 setActive(file, null)：那会被宿主当作「视图关闭」而清空引用。
    new Notice(`正在加载单页视图：${file.basename}`);

    try {
      // 关键（Obsidian 1.14+ / PDF.js 5.x）：PDF.js 已改为按需加载，
      // 必须通过官方 loadPdfJs() 获取，直接读 window.pdfjsLib 可能尚未初始化。
      let lib: PdfJsLib | null = null;
      try {
        // loadPdfJs 在较新版本返回 pdfjsLib；逐个探测以增强兼容性
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loaded = await (loadPdfJs as () => Promise<any>)();
        if (loaded?.getDocument) lib = loaded as PdfJsLib;
      } catch (e) {
        console.warn("[pdf-annotate] loadPdfJs() 不可用，回退 window.pdfjsLib", e);
      }
      if (!lib?.getDocument && window.pdfjsLib?.getDocument) {
        lib = window.pdfjsLib;
      }
      if (!lib) {
        new Notice(
          "当前 Obsidian 无法加载内置 PDF.js，请先在原生视图打开一次任意 PDF 后重试"
        );
        return;
      }
      this.pdfjsLib = lib;

      const buf = await this.app.vault.readBinary(file);
      this.doc = await lib.getDocument({ data: buf }).promise;
      this.data = await this.host.loadAnnotationData(file);
      this.host.setActive(file, this.data);

      const total = this.doc.numPages;
      this.currentPage = Math.max(1, Math.min(page, total));
      await this.renderCurrentPage();
      this.host.refreshSidebar(this.file, this.data.annotations);
    } catch (e) {
      console.error("[pdf-annotate] 单页视图加载失败", e);
      new Notice("PDF 加载失败，请查看控制台（Ctrl/⌘+Shift+I）");
    }
  }

  // ---------------- UI ----------------

  private buildUi(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pdfa-spv-root");
    // 让容器可聚焦，键盘翻页（←/→）才能生效
    root.setAttribute("tabindex", "0");

    const toolbar = root.createDiv({ cls: "pdfa-spv-toolbar" });

    const prevBtn = toolbar.createEl("button", { cls: "pdfa-spv-btn", attr: { title: "上一页 (←)" } });
    prevBtn.innerHTML = ICON.chevronLeft;
    prevBtn.addEventListener("click", () => void this.prevPage());

    this.toolbarPageLabel = toolbar.createSpan({ cls: "pdfa-spv-page-label", text: "— / —" });

    const nextBtn = toolbar.createEl("button", { cls: "pdfa-spv-btn", attr: { title: "下一页 (→)" } });
    nextBtn.innerHTML = ICON.chevronRight;
    nextBtn.addEventListener("click", () => void this.nextPage());

    toolbar.createDiv({ cls: "pdfa-spv-sep" });

    const zoomOutBtn = toolbar.createEl("button", { cls: "pdfa-spv-btn", attr: { title: "缩小" } });
    zoomOutBtn.innerHTML = ICON.minus;
    zoomOutBtn.addEventListener("click", () => void this.zoomBy(-0.25));

    this.toolbarZoomLabel = toolbar.createSpan({ cls: "pdfa-spv-zoom-label", text: "100%" });

    const zoomInBtn = toolbar.createEl("button", { cls: "pdfa-spv-btn", attr: { title: "放大" } });
    zoomInBtn.innerHTML = ICON.plus;
    zoomInBtn.addEventListener("click", () => void this.zoomBy(0.25));

    const fitBtn = toolbar.createEl("button", { cls: "pdfa-spv-btn", attr: { title: "适应宽度" } });
    fitBtn.innerHTML = ICON.fit;
    fitBtn.addEventListener("click", () => void this.fitWidth());

    // 滚动舞台。注意：不要加 pdf-viewer / .textLayer 等 Obsidian 原生 PDF 的
    // class —— 它们会命中 Obsidian 全局 CSS 的 user-select:none，导致文字无法选中。
    // 浮动调色板已改为识别 .pdfa-spv-root / .pdfa-spv-page，无需借用原生 class。
    this.stageEl = root.createDiv({ cls: "pdfa-spv-stage" });

    // 键盘翻页：仅当本视图获得焦点时生效
    this.registerDomEvent(root, "keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        void this.prevPage();
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        void this.nextPage();
      }
    });
  }

  // ---------------- 渲染核心 ----------------

  /** 只渲染当前页；渲染前销毁上一页资源。 */
  private async renderCurrentPage(): Promise<void> {
    if (!this.doc || !this.stageEl) return;
    const seq = ++this.renderSeq;
    const pageNum = this.currentPage;

    // 销毁上一页（关键：确保任何时刻只存在一页的渲染资源）
    this.releasePage();

    try {
      const page = await this.doc.getPage(pageNum);
      if (seq !== this.renderSeq) return; // 已被更新的渲染请求取代
      this.currentJsPage = page;

      const viewport = page.getViewport({ scale: this.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      // 页面容器（与原生结构一致：.page[data-page-number]），供选区与高亮复用
      const pageEl = document.createElement("div");
      pageEl.className = "page pdfa-spv-page";
      pageEl.setAttribute("data-page-number", String(pageNum));
      pageEl.style.width = `${viewport.width}px`;
      pageEl.style.height = `${viewport.height}px`;
      pageEl.style.position = "relative";
      // 【关键修复 · PDF.js 5.x】文本层 span 的字号用
      // calc(var(--total-scale-factor) * Npx) 定位，TextLayer 构造时还会调用
      // setLayerDimensions，用 round(down, calc(...), var(--scale-round-x)) 给
      // 文本层容器设宽高。原生查看器在 .pdfViewer .page 上定义这 5 个变量，
      // 自研容器不在该结构内，必须全部显式设置——尤其 --scale-round-x/y：
      // 缺失会让 round() 计算出无效值，导致文本层宽高为 0、文字无法选中。
      // 这正是「自动接管后无法划词标注」的根因。
      pageEl.style.setProperty("--scale-factor", String(this.scale));
      pageEl.style.setProperty("--user-unit", "1");
      pageEl.style.setProperty("--total-scale-factor", String(this.scale));
      pageEl.style.setProperty("--scale-round-x", "1px");
      pageEl.style.setProperty("--scale-round-y", "1px");
      this.pageEl = pageEl;

      // canvas
      const canvas = document.createElement("canvas");
      canvas.className = "pdfa-spv-canvas";
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      this.canvas = canvas;
      pageEl.appendChild(canvas);

      // 文本层（承载可选中的文字，供划词标注）
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer pdfa-spv-textlayer";
      // 【关键·实测确认】显式把动态缩放变量设到文本层自身：
      // PDF.js 5.x 用 calc(var(--total-scale-factor) * ...) 计算每个 span 的
      // left/top/字号，setLayerDimensions 也用它算文本层容器宽高。若只依赖从
      // pageEl 继承，一旦 CSS 里有同名兜底（即使是 1）就会就近覆盖，导致文本层
      // 停留在 1 倍、与缩放后的 canvas 错位 → 文字选不中、高亮对不上。
      // 直接设在 textLayer 上优先级最高，且与 pageEl 保持同一 scale。
      textLayer.style.setProperty("--scale-factor", String(this.scale));
      textLayer.style.setProperty("--user-unit", "1");
      textLayer.style.setProperty("--total-scale-factor", String(this.scale));
      textLayer.style.setProperty("--scale-round-x", "1px");
      textLayer.style.setProperty("--scale-round-y", "1px");
      // 强制文字可选中：覆盖 Obsidian 视图容器继承下来的 user-select:none，
      // 否则 Selection.toString() 为空，浮动工具条判定无选区而不弹出。
      textLayer.style.userSelect = "text";
      (textLayer.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = "text";
      pageEl.appendChild(textLayer);

      this.stageEl.appendChild(pageEl);
      // 翻页后滚动容器回到顶部
      this.stageEl.scrollTop = 0;
      this.stageEl.scrollLeft = 0;

      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("无法创建 canvas 上下文");

      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;

      // 生成文本层（不同 PDF.js 版本 API 不同，做兼容）
      const textTask = this.renderTextLayer(page, textLayer, viewport);

      await Promise.all([renderTask, textTask]);
      if (seq !== this.renderSeq) return;

      // 诊断：输出文本层状态，便于排查各版本 PDF.js 的文本层兼容性
      const spanCount = textLayer.querySelectorAll("span").length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ver = (this.pdfjsLib as any)?.version ?? "unknown";
      console.log(
        `[pdf-annotate] 单页渲染完成: page=${pageNum}, scale=${this.scale}, ` +
        `canvas=${canvas.width}x${canvas.height}, pdfjs=${ver}, textSpans=${spanCount}`
      );
      if (spanCount === 0) {
        console.warn(
          "[pdf-annotate] 文本层没有生成任何文字 span —— 该 PDF 可能是扫描件，或内置 PDF.js 文本层不兼容，划词标注将不可用"
        );
      }

      this.updateToolbar();
      this.renderHighlights();
      this.saveReadingState();
    } catch (e) {
      console.error("[pdf-annotate] 单页渲染失败", e);
      new Notice("页面渲染失败，请查看控制台");
    }
  }

  /** 生成文本层，兼容 PDF.js v5 / v4 的 TextLayer 类。 */
  private async renderTextLayer(
    page: JsPdfPage,
    container: HTMLElement,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewport: any
  ): Promise<void> {
    const lib = this.pdfjsLib ?? window.pdfjsLib;
    if (!lib?.TextLayer) {
      console.warn("[pdf-annotate] 内置 PDF.js 未提供 TextLayer，划词标注不可用");
      return;
    }
    try {
      // PDF.js v5.x：new pdfjsLib.TextLayer({ textContentSource, container, viewport })
      // 用官方 viewer 的参数，保证 includeChars / 归一化行为与原生一致。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const source = (page as any).streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      });
      const tl = new lib.TextLayer({
        textContentSource: source,
        container,
        viewport,
      });
      await tl.render();
      // 官方会追加 endOfContent 以改善跨行选择；这里补上，避免选区跳到层尾
      if (!container.querySelector(".endOfContent")) {
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.appendChild(end);
      }
    } catch (e) {
      console.error("[pdf-annotate] 文本层渲染失败", e);
      new Notice("文本层渲染失败，划词标注可能不可用");
    }
  }

  /** 释放当前页渲染资源。 */
  private releasePage(): void {
    this.highlighter?.clearAll();
    this.highlighter = null;
    try { this.currentJsPage?.cleanup(); } catch (_) { /* ignore */ }
    this.currentJsPage = null;
    this.pageEl?.remove();
    this.pageEl = null;
    this.canvas = null;
  }

  // ---------------- 高亮 ----------------

  /** 在当前页渲染标注（复用 Highlighter 的合并/定位/点击逻辑）。 */
  renderHighlights(): void {
    if (!this.pageEl || !this.data) return;
    if (!this.highlighter) {
      // Highlighter 只需一个带 _pages 的 viewer；用 getter 动态构造最小替身，
      // 保证翻页后拿到的是当前页的 pageEl（与新版 Highlighter 的 getter 接口一致）。
      this.highlighter = new Highlighter(() =>
        this.pageEl
          ? ({ _pages: [{ id: this.currentPage, div: this.pageEl }] } as unknown as PDFViewer)
          : null
      );
      this.highlighter.onMarkClick = (id) => {
        const annot = this.data?.annotations.find((a) => a.id === id);
        if (annot) this.host.hostOpenComment(annot, false, () => this.renderHighlights());
      };
    }
    const settings = this.host.getSettings();
    this.highlighter.setStyle(settings.highlightOpacity, settings.resolvedBehavior);
    const annots = this.data.annotations.filter((a) => a.page === this.currentPage);
    this.highlighter.renderAll(annots);
  }

  /** 由浮动调色板调用：基于当前选区在当前页创建标注。 */
  createAnnotationFromSelection(type: AnnotationType, color: HighlightColor): void {
    if (!this.data || !this.file || !this.pageEl) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const groups = selectionToQuads(sel, this.pageEl);
    // 只取当前页的矩形
    const mine = groups.filter((g) => g.page === this.currentPage);
    if (mine.length === 0) {
      new Notice("无法识别选区位置，请重新选择文本");
      return;
    }
    const quote = sel.toString().replace(/\s+/g, " ").trim();
    const now = new Date().toISOString();
    const created: Annotation[] = mine.map((g) => ({
      id: newAnnotationId(),
      type, color,
      page: g.page,
      quads: g.quads,
      quote,
      comment: "",
      status: "open",
      tags: [],
      createdAt: now,
      updatedAt: now,
    }));
    for (const a of created) this.data.annotations.push(a);
    void this.host.saveAnnotationData(this.file, this.data).then(() => {
      this.renderHighlights();
      this.host.refreshSidebar(this.file, this.data!.annotations);
    });
    sel.removeAllRanges();

    const settings = this.host.getSettings();
    if (settings.openCommentOnHighlight && created[0]) {
      this.host.hostOpenComment(created[0], true, () => {
        this.renderHighlights();
        this.host.refreshSidebar(this.file, this.data!.annotations);
      });
    }
  }

  /** 判断选区是否落在本视图页面内（供主插件路由调色板动作）。 */
  isSelectionInside(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !this.pageEl) return false;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
    return !!el && this.pageEl.contains(el);
  }

  /** 外部（评论保存/删除/侧边栏）修改数据后刷新。 */
  reloadData(data: AnnotationFile): void {
    this.data = data;
    this.host.setActive(this.file, this.data);
    this.renderHighlights();
    this.host.refreshSidebar(this.file, this.data.annotations);
  }

  goToPage(page: number): void {
    if (!this.doc) return;
    const target = Math.max(1, Math.min(page, this.doc.numPages));
    if (target === this.currentPage) return;
    this.currentPage = target;
    void this.renderCurrentPage();
  }

  // ---------------- 翻页 / 缩放 ----------------

  private async prevPage(): Promise<void> { this.goToPage(this.currentPage - 1); }
  private async nextPage(): Promise<void> { this.goToPage(this.currentPage + 1); }

  private async zoomBy(delta: number): Promise<void> {
    const next = Math.max(0.5, Math.min(4, Math.round((this.scale + delta) * 100) / 100));
    if (next === this.scale) return;
    this.scale = next;
    await this.renderCurrentPage();
  }

  private async fitWidth(): Promise<void> {
    if (!this.doc || !this.stageEl) return;
    try {
      const page = await this.doc.getPage(this.currentPage);
      const baseWidth = page.getViewport({ scale: 1 }).width;
      const avail = this.stageEl.clientWidth - 32;
      if (baseWidth > 0 && avail > 0) {
        this.scale = Math.max(0.5, Math.min(4, avail / baseWidth));
        await this.renderCurrentPage();
      }
    } catch (_) { /* ignore */ }
  }

  private updateToolbar(): void {
    const total = this.doc?.numPages ?? 1;
    if (this.toolbarPageLabel) this.toolbarPageLabel.setText(`${this.currentPage} / ${total}`);
    if (this.toolbarZoomLabel) this.toolbarZoomLabel.setText(`${Math.round(this.scale * 100)}%`);
  }

  private saveReadingState(): void {
    if (!this.data || !this.file) return;
    this.data.readingState = {
      layout: "single-page",
      lastPage: this.currentPage,
      zoom: this.scale,
      updatedAt: new Date().toISOString(),
    };
    void this.host.saveAnnotationData(this.file, this.data);
  }

  getFile(): TFile | null {
    return this.file;
  }

  getData(): AnnotationFile | null {
    return this.data;
  }

  /**
   * Obsidian 视图状态持久化：让本视图像原生 PDF 视图一样记住当前文件/页码/缩放。
   * 这样切换标签、重启 Obsidian 后都能自动恢复到同一 PDF 同一页。
   */
  getState(): Record<string, unknown> {
    return {
      file: this.file?.path ?? null,
      page: this.currentPage,
      scale: this.scale,
    };
  }

  async setState(state: Record<string, unknown>, _result: unknown): Promise<void> {
    const path = typeof state?.file === "string" ? (state.file as string) : null;
    const page = typeof state?.page === "number" ? (state.page as number) : 1;
    const scale = typeof state?.scale === "number" ? (state.scale as number) : 1;
    if (path) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.openFile(file, page, scale);
      }
    }
  }
}

const ICON = {
  chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  fit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
};
