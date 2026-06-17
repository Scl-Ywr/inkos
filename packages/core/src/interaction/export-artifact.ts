import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPub } from "epub-gen-memory";

// Dynamic import for PDF generation (optional dependency)
let _PDFDocument: typeof import("pdfkit") | null = null;
let _pdfkitLoaded = false;

async function getPDFDocument(): Promise<typeof import("pdfkit")> {
  if (!_pdfkitLoaded) {
    _pdfkitLoaded = true;
    try {
      const pdfkit = await import("pdfkit");
      _PDFDocument = pdfkit.default ?? pdfkit;
    } catch {
      // pdfkit not installed
    }
  }
  if (!_PDFDocument) throw new Error("pdfkit is not installed. Run: pnpm add pdfkit");
  return _PDFDocument;
}

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string; readonly paywallAfterChapter?: number }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: "txt" | "md" | "epub" | "pdf";
  readonly contentType: string;
  readonly payload: string | Buffer;
}

function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownToSimpleHtml(markdown: string): { title: string; html: string } {
  const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "Untitled Chapter";
  const html = markdown
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
  return { title, html };
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "pdf";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
    readonly splitPaywall?: boolean;
  },
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : index;

  if (chapters.length === 0) {
    throw new Error("No chapters to export.");
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const projectRoot = dirname(dirname(bookDir));
  const outputPath = options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`);
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  if (format === "epub") {
    const epubChapters: Array<{ title: string; content: string }> = [];
    for (const chapter of chapters) {
      const match = chapterFiles.get(chapter.number);
      if (!match) continue;
      const markdown = await readFile(join(chaptersDir, match), "utf-8");
      const { title, html } = markdownToSimpleHtml(markdown);
      epubChapters.push({ title, content: html });
    }
    const epubInstance = new EPub(
      { title: book.title, lang: book.language === "en" ? "en" : "zh-CN" },
      epubChapters,
    );
    return {
      outputPath,
      fileName: `${bookId}.epub`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await epubInstance.genEpub(),
    };
  }

  const parts: string[] = [];
  parts.push(format === "md" ? `# ${book.title}\n\n---\n` : `${book.title}\n\n`);
  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) continue;
    parts.push(await readFile(join(chaptersDir, match), "utf-8"));
    parts.push("\n\n");
  }

  // PDF format
  if (format === "pdf") {
    const PDFDocument = await getPDFDocument();
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    const pdfBuffer = await new Promise<Buffer>(async (resolve, reject) => {
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      try {
        // Title page
        doc.fontSize(24).text(book.title, { align: "center" });
        doc.moveDown(2);

        // Chapters
        for (const chapter of chapters) {
          const match = chapterFiles.get(chapter.number);
          if (!match) continue;

          const content = await readFile(join(chaptersDir, match), "utf-8");
          const lines = content.split("\n");
          const titleLine = lines.find((l: string) => l.startsWith("# ")) ?? "";
          const title = titleLine.replace(/^#\s*/, "") ?? `Chapter ${chapter.number}`;
          const body = lines.filter((l: string) => l !== titleLine).join("\n").trim();

          // Page break before each chapter (except first)
          if (chapter.number > chapters[0]?.number) {
            doc.addPage();
          }

          // Chapter title
          doc.fontSize(18).text(title, { underline: true });
          doc.moveDown(0.5);

          // Chapter content
          doc.fontSize(12);
          const paragraphs = body.split(/\n\n+/).filter(Boolean);
          for (const para of paragraphs) {
            if (para.startsWith("#")) continue; // skip headers
            doc.text(para, { align: "justify", lineGap: 4 });
            doc.moveDown(0.5);
          }
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });

    return {
      outputPath,
      fileName: `${bookId}.pdf`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/pdf",
      payload: pdfBuffer,
    };
  }

  return {
    outputPath,
    fileName: `${bookId}.${format}`,
    chaptersExported: chapters.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: parts.join(format === "md" ? "\n---\n\n" : "\n"),
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "pdf";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
  };
}

export interface VolumeExportResult {
  readonly volumeNumber: number;
  readonly volumeTitle: string;
  readonly chaptersIncluded: number;
  readonly startChapter: number;
  readonly endChapter: number;
  readonly totalWords: number;
  readonly artifact: ExportArtifact;
}

export async function buildVolumeExportArtifacts(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "pdf";
    readonly approvedOnly?: boolean;
    readonly chaptersPerVolume?: number;
    readonly volumeNames?: ReadonlyArray<string>;
  },
): Promise<ReadonlyArray<VolumeExportResult>> {
  const chaptersPerVolume = options.chaptersPerVolume ?? 30;
  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : index;

  if (chapters.length === 0) {
    throw new Error("No chapters to export.");
  }

  // Group chapters into volumes
  const volumes: Array<typeof chapters> = [];
  for (let i = 0; i < chapters.length; i += chaptersPerVolume) {
    volumes.push(chapters.slice(i, i + chaptersPerVolume));
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const projectRoot = dirname(dirname(bookDir));
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  const format = options.format ?? "txt";

  const results: VolumeExportResult[] = [];

  for (let volIndex = 0; volIndex < volumes.length; volIndex++) {
    const volumeChapters = volumes[volIndex];
    const volumeNumber = volIndex + 1;
    const volumeTitle = options.volumeNames?.[volIndex] ?? `第${volumeNumber}卷`;
    const startChapter = volumeChapters[0].number;
    const endChapter = volumeChapters[volumeChapters.length - 1].number;
    const totalWords = volumeChapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    const outputPath = join(projectRoot, `${bookId}_${volumeTitle}.${format}`);

    // Build content for this volume
    if (format === "epub") {
      const epubChapters: Array<{ title: string; content: string }> = [];
      for (const chapter of volumeChapters) {
        const match = chapterFiles.get(chapter.number);
        if (!match) continue;
        const markdown = await readFile(join(chaptersDir, match), "utf-8");
        const { title, html } = markdownToSimpleHtml(markdown);
        epubChapters.push({ title, content: html });
      }
      const epubInstance = new EPub(
        { title: `${book.title} - ${volumeTitle}`, lang: book.language === "en" ? "en" : "zh-CN" },
        epubChapters,
      );
      const artifact: ExportArtifact = {
        outputPath,
        fileName: `${bookId}_${volumeTitle}.epub`,
        chaptersExported: volumeChapters.length,
        totalWords,
        format,
        contentType: "application/epub+zip",
        payload: await epubInstance.genEpub(),
      };
      results.push({
        volumeNumber,
        volumeTitle,
        chaptersIncluded: volumeChapters.length,
        startChapter,
        endChapter,
        totalWords,
        artifact,
      });
    } else {
      const parts: string[] = [];
      parts.push(format === "md" ? `# ${book.title} - ${volumeTitle}\n\n---\n` : `${book.title} - ${volumeTitle}\n\n`);
      for (const chapter of volumeChapters) {
        const match = chapterFiles.get(chapter.number);
        if (!match) continue;
        parts.push(await readFile(join(chaptersDir, match), "utf-8"));
        parts.push("\n\n");
      }

      const artifact: ExportArtifact = {
        outputPath,
        fileName: `${bookId}_${volumeTitle}.${format}`,
        chaptersExported: volumeChapters.length,
        totalWords,
        format,
        contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
        payload: parts.join(format === "md" ? "\n---\n\n" : "\n"),
      };
      results.push({
        volumeNumber,
        volumeTitle,
        chaptersIncluded: volumeChapters.length,
        startChapter,
        endChapter,
        totalWords,
        artifact,
      });
    }
  }

  return results;
}

export async function writeVolumeExportArtifacts(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "pdf";
    readonly approvedOnly?: boolean;
    readonly chaptersPerVolume?: number;
    readonly volumeNames?: ReadonlyArray<string>;
    readonly outputDir?: string;
  },
): Promise<ReadonlyArray<Omit<VolumeExportResult, "artifact"> & { readonly outputPath: string }>> {
  const results = await buildVolumeExportArtifacts(state, bookId, options);
  const outputResults: Array<Omit<VolumeExportResult, "artifact"> & { readonly outputPath: string }> = [];

  for (const result of results) {
    const outputDir = options.outputDir ?? dirname(result.artifact.outputPath);
    const outputPath = join(outputDir, result.artifact.fileName);
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPath, result.artifact.payload);
    outputResults.push({
      volumeNumber: result.volumeNumber,
      volumeTitle: result.volumeTitle,
      chaptersIncluded: result.chaptersIncluded,
      startChapter: result.startChapter,
      endChapter: result.endChapter,
      totalWords: result.totalWords,
      outputPath,
    });
  }

  return outputResults;
}
