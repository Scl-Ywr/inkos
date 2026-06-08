import { describe, expect, it } from "vitest";
import { formatChapterForReading, makeTxtFilename, splitLongParagraphs } from "./chapter-text";

describe("chapter text formatting", () => {
  it("splits long Chinese paragraphs at sentence boundaries", () => {
    const paragraph = [
      "卷帘门外传来最后一辆电动车驶过减速带的闷响。",
      "苏川荔站在三号包间的磨砂玻璃隔断前，指尖搭在黄铜把手上。",
      "她盯着隔断上映出的自己，制服领口的纽扣扣到了最上面一粒。",
      "空气里浮着消毒水气息，混合在一起，黏在鼻腔深处散不开。",
    ].join("");

    const result = splitLongParagraphs(paragraph, 70);

    expect(result.length).toBeGreaterThan(1);
    expect(result.every((item) => item.length <= 90)).toBe(true);
    expect(result.join("")).toBe(paragraph);
  });

  it("builds TXT-ready plain text with title and readable paragraphs", () => {
    const content = [
      "# 第3章 刻度与盲区",
      "",
      "她把抹布叠成整齐的方块，放在茶台左上角。第三排靠窗的位置缺了一个青瓷杯盖，她拉开抽屉核对损耗单，铅笔尖在纸面上划出细长的划痕。墙上的挂钟指针划过八点四十，秒针走得比平时重，每跳一格都像是敲在耳膜上。",
    ].join("\n");

    const formatted = formatChapterForReading(content, 3, { maxParagraphChars: 52 });

    expect(formatted.title).toBe("第3章 刻度与盲区");
    expect(formatted.paragraphs.length).toBeGreaterThan(1);
    expect(formatted.paragraphs.every((paragraph) => paragraph.startsWith("　　"))).toBe(true);
    expect(formatted.plainText).toContain("第3章 刻度与盲区\n\n");
    expect(formatted.plainText).toMatch(/\n\n　　/);
  });

  it("creates a safe txt filename", () => {
    expect(makeTxtFilename("绝恋情殇", 3, "第3章 刻度/盲区")).toBe("绝恋情殇-chapter-0003-刻度-盲区.txt");
  });
});
