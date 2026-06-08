import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecentTaskHistory, type OperationHistoryItem } from "./Dashboard";

describe("RecentTaskHistory", () => {
  it("renders persisted task history with status, duration, and error details", () => {
    const items: OperationHistoryItem[] = [
      {
        key: "audit:demo-book:3",
        type: "audit",
        bookId: "demo-book",
        status: "error",
        label: "章节审计",
        message: "审计失败",
        startedAt: 1,
        updatedAt: 66_000,
        completedAt: 66_000,
        durationMs: 65_000,
        chapter: 3,
        error: "API 400",
      },
    ];

    const html = renderToStaticMarkup(createElement(RecentTaskHistory, { items }));

    expect(html).toContain("最近任务");
    expect(html).toContain("章节审计");
    expect(html).toContain("失败");
    expect(html).toContain("demo-book");
    expect(html).toContain("第 3 章");
    expect(html).toContain("1m 5s");
    expect(html).toContain("API 400");
  });
});
