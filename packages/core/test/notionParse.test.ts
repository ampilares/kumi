import { describe, expect, it } from "vitest";
import {
  inferColumn,
  inferSchema,
  parseCsv,
  parseDateValue,
  parseInline,
  parseNotionMarkdown,
  parseNumber,
  type ParsedBlock,
} from "../src";

function plain(block: ParsedBlock | undefined): string {
  const spans = block?.payload.richText;
  if (!Array.isArray(spans)) return "";
  return spans
    .map((span) =>
      span.type === "text" ? span.text : span.type === "equation" ? `$${span.expression}$` : "",
    )
    .join("");
}

function parse(text: string): ParsedBlock[] {
  return parseNotionMarkdown(text).blocks;
}

describe("parseNotionMarkdown: structure", () => {
  it("takes the leading H1 as the page title, not a block", () => {
    const result = parseNotionMarkdown("# Weekly Notes\n\nHello world\n");
    expect(result.title).toBe("Weekly Notes");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.type).toBe("paragraph");
    expect(plain(result.blocks[0])).toBe("Hello world");
  });

  it("maps headings, dividers and quotes", () => {
    const blocks = parse("# T\n\n## Two\n\n### Three\n\n---\n\n> quoted\n");
    expect(blocks.map((block) => block.type)).toEqual([
      "heading2",
      "heading3",
      "divider",
      "quote",
    ]);
    expect(plain(blocks[3])).toBe("quoted");
  });

  it("flattens headings deeper than 3 and reports the loss", () => {
    const result = parseNotionMarkdown("#### Deep\n");
    expect(result.blocks[0]?.type).toBe("heading3");
    expect(result.losses.map((loss) => loss.kind)).toContain("heading_depth");
  });

  it("nests bullets by indentation", () => {
    const blocks = parse("- one\n    - one a\n        - one a i\n- two\n");
    expect(blocks).toHaveLength(2);
    expect(plain(blocks[0])).toBe("one");
    const child = blocks[0]?.children[0];
    expect(plain(child)).toBe("one a");
    expect(plain(child?.children[0])).toBe("one a i");
    expect(plain(blocks[1])).toBe("two");
  });

  it("reads checkboxes and numbered lists", () => {
    const blocks = parse("- [ ] open\n- [x] done\n\n1. first\n2. second\n");
    expect(blocks[0]).toMatchObject({ type: "to_do", payload: { checked: false } });
    expect(blocks[1]).toMatchObject({ type: "to_do", payload: { checked: true } });
    expect(blocks[2]?.type).toBe("numbered_list_item");
    expect(plain(blocks[3])).toBe("second");
  });

  it("keeps code fences verbatim with their language", () => {
    const blocks = parse("```ts\nconst a = 1;\n  // *not* markdown\n```\n");
    expect(blocks[0]?.type).toBe("code");
    expect(blocks[0]?.payload.language).toBe("ts");
    expect(plain(blocks[0])).toBe("const a = 1;\n  // *not* markdown");
  });

  it("reads block and inline equations", () => {
    const blocks = parse("$$\nE = mc^2\n$$\n\nmass is $m$ here\n");
    expect(blocks[0]).toMatchObject({ type: "equation", payload: { expression: "E = mc^2" } });
    const spans = blocks[1]?.payload.richText ?? [];
    expect(spans[1]).toEqual({ type: "equation", expression: "m" });
  });

  it("maps a blockquote whose first line starts with an emoji to a callout", () => {
    const blocks = parse("> 💡 Remember the milk\n");
    expect(blocks[0]?.type).toBe("callout");
    expect(blocks[0]?.payload.icon).toBe("💡");
    expect(plain(blocks[0])).toBe("Remember the milk");
  });

  it("keeps a plain blockquote a quote", () => {
    const blocks = parse("> just a quote\n> second line\n");
    expect(blocks[0]?.type).toBe("quote");
    expect(plain(blocks[0])).toBe("just a quote\nsecond line");
  });

  it("reads GFM tables as a table with table_row children", () => {
    const blocks = parse("| Name | Qty |\n| --- | --- |\n| Bolt | 3 |\n| Nut | 4 |\n");
    expect(blocks[0]?.type).toBe("table");
    expect(blocks[0]?.payload.hasColumnHeader).toBe(true);
    expect(blocks[0]?.children).toHaveLength(3);
    const cells = blocks[0]?.children[2]?.payload.cells ?? [];
    expect(cells).toHaveLength(2);
  });

  it("turns a standalone local image into an image block with an asset ref", () => {
    const blocks = parse("![a diagram](Page%20abc/diagram.png)\n");
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[0]?.assetRef).toBe("Page abc/diagram.png");
    expect(blocks[0]?.assetName).toBe("diagram.png");
  });

  it("picks the media block type from the extension", () => {
    expect(parse("![](clip.mp4)\n")[0]?.type).toBe("video");
    expect(parse("![](voice.mp3)\n")[0]?.type).toBe("audio");
    expect(parse("![](sheet.xlsx)\n")[0]?.type).toBe("file");
  });

  it("turns an external image into a bookmark and reports external_image", () => {
    const result = parseNotionMarkdown("![alt](https://example.com/a.png)\n");
    expect(result.blocks[0]).toMatchObject({
      type: "bookmark",
      payload: { url: "https://example.com/a.png" },
    });
    expect(result.losses.map((loss) => loss.kind)).toContain("external_image");
  });

  it("strips a row page's `Key: value` property lines when asked", () => {
    const text = "# Task one\n\nStatus: Done\nDue: August 19, 2026\n\nReal content\n";
    const stripped = parseNotionMarkdown(text, { stripProperties: true });
    expect(stripped.blocks).toHaveLength(1);
    expect(plain(stripped.blocks[0])).toBe("Real content");
    const kept = parseNotionMarkdown(text);
    expect(kept.blocks).toHaveLength(2);
  });
});

describe("parseNotionMarkdown: inline", () => {
  it("reads bold, italic, strike and code", () => {
    const spans = parseInline("**b** *i* ~~s~~ `c`");
    expect(spans[0]).toMatchObject({ text: "b", annotations: { bold: true } });
    expect(spans[2]).toMatchObject({ text: "i", annotations: { italic: true } });
    expect(spans[4]).toMatchObject({ text: "s", annotations: { strikethrough: true } });
    expect(spans[6]).toMatchObject({ text: "c", annotations: { code: true } });
  });

  it("nests marks", () => {
    const spans = parseInline("**bold and *both* **");
    expect(spans[1]).toMatchObject({ text: "both", annotations: { bold: true, italic: true } });
  });

  it("keeps markup literal inside code spans", () => {
    const spans = parseInline("`**not bold**`");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ text: "**not bold**", annotations: { code: true } });
  });

  it("honours backslash escapes", () => {
    const spans = parseInline("a \\*literal\\* star");
    expect(spans.map((span) => (span.type === "text" ? span.text : ""))).toEqual([
      "a *literal* star",
    ]);
  });

  it("decodes URL-encoded internal link targets", () => {
    const spans = parseInline("see [Other Page](Other%20Page%20abc123.md)");
    expect(spans[1]).toMatchObject({ href: "notion-rel:Other Page abc123.md" });
  });

  it("keeps external links as-is", () => {
    const spans = parseInline("[site](https://example.com/x?a=1)");
    expect(spans[0]).toMatchObject({ href: "https://example.com/x?a=1" });
  });

  it("reads an empty-label Notion link as its target", () => {
    const spans = parseInline("[](Untitled%20999.md)");
    expect(spans[0]).toMatchObject({ text: "Untitled%20999.md", href: "notion-rel:Untitled 999.md" });
  });

  it("degrades a mid-paragraph image to a link and reports it", () => {
    const result = parseNotionMarkdown("text with ![alt](pic.png) inline\n");
    expect(result.losses.map((loss) => loss.kind)).toContain("inline_image");
    expect(plain(result.blocks[0])).toBe("text with alt inline");
  });

  it("handles unicode and emoji titles and targets", () => {
    const spans = parseInline("[日本語 🎉](%E6%97%A5%E6%9C%AC%E8%AA%9E%20abc.md)");
    expect(spans[0]).toMatchObject({ text: "日本語 🎉", href: "notion-rel:日本語 abc.md" });
  });
});

describe("parseCsv", () => {
  it("reads quoted fields with commas, newlines and doubled quotes", () => {
    const table = parseCsv('Name,Note\n"a, b","line1\nline2"\n"say ""hi""",plain\n');
    expect(table.header).toEqual(["Name", "Note"]);
    expect(table.rows).toEqual([
      ["a, b", "line1\nline2"],
      ['say "hi"', "plain"],
    ]);
  });

  it("pads short rows and drops the trailing blank record", () => {
    const table = parseCsv("A,B,C\r\n1,2\r\n");
    expect(table.rows).toEqual([["1", "2", ""]]);
  });
});

describe("type inference", () => {
  const infer = (values: string[]): ReturnType<typeof inferColumn> =>
    inferColumn("Col", values, values.length);

  it("infers number only when every value is numeric", () => {
    expect(infer(["1", "2.5", "1,200"]).type).toBe("number");
    expect(infer(["1", "2 kg"]).type).toBe("text");
  });

  it("infers dates in ISO and Notion long form, including ranges", () => {
    expect(infer(["2026-08-19", "August 19, 2026"]).type).toBe("date");
    expect(infer(["August 19, 2026 → August 20, 2026"]).type).toBe("date");
    expect(parseDateValue("August 19, 2026 10:30 AM")?.start).toBe("2026-08-19T10:30:00");
    expect(parseDateValue("2026-08-19 → 2026-08-20")?.end).toBe("2026-08-20");
  });

  it("infers checkbox only from Yes/No-style values", () => {
    expect(infer(["Yes", "No", "Yes"]).type).toBe("checkbox");
    expect(infer(["Yes", "Maybe"]).type).toBe("text");
  });

  it("infers url when every value is an http(s) URL", () => {
    expect(infer(["https://a.test", "http://b.test/x"]).type).toBe("url");
    expect(infer(["https://a.test", "not a url"]).type).toBe("text");
  });

  it("infers select for a few repeated short tokens", () => {
    const column = infer(["Done", "Open", "Done", "Open", "Done", "Open"]);
    expect(column.type).toBe("select");
    expect(column.options).toEqual(["Done", "Open"]);
  });

  it("infers multi_select when values carry several tokens", () => {
    const column = infer(["a, b", "b", "a", "a, b", "b", "a"]);
    expect(column.type).toBe("multi_select");
    expect(column.options.sort()).toEqual(["a", "b"]);
  });

  it("falls back to text for free prose and explains why", () => {
    const values = [
      "a long sentence about something entirely unrepeated here",
      "another completely different sentence with other words",
      "and a third one, quite unlike the others as well",
    ];
    const column = infer(values);
    expect(column.type).toBe("text");
  });

  it("warns when a column ALMOST parsed as a number", () => {
    const column = inferColumn("Cost", ["10", "20", "about 30"], 3);
    expect(column.type).toBe("text");
    expect(column.warning).toContain("1 of 3");
    expect(column.warning).toContain("number");
  });

  it("treats the first column as the title property", () => {
    const table = parseCsv("Name,Count\nA,1\nB,2\n");
    const schema = inferSchema(table);
    expect(schema[0]).toMatchObject({ name: "Name", type: "title" });
    expect(schema[1]?.type).toBe("number");
  });

  it("keeps an all-empty column as text", () => {
    expect(infer(["", "", ""]).type).toBe("text");
  });

  it("rejects thousands-separated nonsense as a number", () => {
    expect(parseNumber("1,20")).toBeNull();
    expect(parseNumber("12")).toBe(12);
  });
});
