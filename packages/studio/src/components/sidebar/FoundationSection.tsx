import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { SidebarCard } from "./SidebarCard";
import { loadArtifactContent, prefetchArtifactContents } from "./artifact-content-cache";

const FOUNDATION_FILES: ReadonlyArray<{ file: string; label: string }> = [
  { file: "outline/story_frame.md", label: "世界观设定" },
  { file: "outline/volume_map.md", label: "卷纲规划" },
  { file: "book_rules.md", label: "叙事规则" },
  { file: "current_state.md", label: "状态卡" },
  { file: "pending_hooks.md", label: "伏笔池" },
  { file: "particle_ledger.md", label: "资源账本" },
  { file: "chapter_summaries.md", label: "章节摘要" },
  { file: "subplot_board.md", label: "支线进度" },
  { file: "emotional_arcs.md", label: "感情线" },
  { file: "character_matrix.md", label: "角色矩阵" },
];

interface TruthFileInfo {
  name: string;
  size: number;
}

const truthFilesCache = new Map<string, ReadonlyArray<TruthFileInfo>>();

export function invalidateFoundationFilesCache(bookId: string): void {
  truthFilesCache.delete(bookId);
}

interface FoundationSectionProps {
  readonly bookId: string;
}

export function FoundationSection({ bookId }: FoundationSectionProps) {
  const [files, setFiles] = useState<ReadonlyArray<TruthFileInfo>>(
    () => truthFilesCache.get(bookId) ?? [],
  );
  const openArtifact = useChatStore((s) => s.openArtifact);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);

  useEffect(() => {
    let ignore = false;
    const cached = truthFilesCache.get(bookId);
    if (cached) {
      setFiles(cached);
    }

    fetchJson<{ files: TruthFileInfo[] }>(`/books/${bookId}/truth`)
      .then((data) => {
        if (ignore) return;
        const nextFiles = data.files ?? [];
        truthFilesCache.set(bookId, nextFiles);
        setFiles(nextFiles);
        prefetchArtifactContents(
          bookId,
          FOUNDATION_FILES
            .filter((file) => nextFiles.some((truthFile) => truthFile.name === file.file))
            .map((file) => ({ type: "truth", file: file.file })),
        );
      })
      .catch(() => {
        if (!ignore && !truthFilesCache.has(bookId)) {
          setFiles([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, [bookId, bookDataVersion]);

  const available = FOUNDATION_FILES.filter((f) =>
    files.some((tf) => tf.name === f.file),
  );

  if (available.length === 0) return null;

  return (
    <SidebarCard title="核心文件" stateKey={`${bookId}:foundation`}>
      <ul className="space-y-1">
        {available.map((item) => (
          <li key={item.file}>
            <button
              onClick={() => openArtifact(item.file)}
              onFocus={() => void loadArtifactContent(bookId, { type: "truth", file: item.file })}
              onMouseEnter={() => void loadArtifactContent(bookId, { type: "truth", file: item.file })}
              onPointerDown={() => void loadArtifactContent(bookId, { type: "truth", file: item.file })}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors font-['SimSun','Songti_SC','STSong',serif]"
            >
              <FileText size={14} className="shrink-0 text-muted-foreground/60" />
              <span className="truncate">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </SidebarCard>
  );
}
