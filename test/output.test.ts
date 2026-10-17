import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCbmData } from "../src/cbm/normalize.js";
import { OutputService } from "../src/domain/output.js";
import { renderResult } from "../src/pi-tools/render.js";

const FIXTURE_DIR = new URL("./fixtures/cbm-0.12.1/", import.meta.url);

function normalizedFixture(name: string): unknown {
  const envelope = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as {
    content: Array<{ type: string; text: string }>;
  };
  return normalizeCbmData(JSON.parse(envelope.content[0]!.text));
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

describe("compact search_graph output on cbm 0.12 paging", () => {
  it("keeps locations, drops 0.12 extras, and hints at the next page", async () => {
    const result = await new OutputService().buildCompactableToolResult(
      "Graph search results",
      normalizedFixture("search_graph.label"),
      {},
      { tool: "search_graph" },
    );

    const text = result.content[0]!.text;
    expect(text).toContain('"qualified_name": "tmp-cbm-fixture-repo.src.domain.index-coordinator.IndexCoordinator.abortAll"');
    expect(text).toMatch(/src\/domain\/index-coordinator\.ts",\s*"start_line": 315,\s*"end_line": 317/);
    expect(text).not.toContain("qn_rule");

    const data = result.details.data as Record<string, unknown>;
    expect(data.total).toBe(61);
    expect(data.returned).toBe(3);
    expect(data.has_more).toBe(true);
    expect(data.truncated).toBe(true);
    expect(String(data.pagination_hint)).toContain("offset=3");
  });

  it("renders total with a returned/truncated fallback", () => {
    const withTotal = renderResult("search_graph")({ details: { data: { total: 61, has_more: true } } }, undefined, theme);
    expect(withTotal.render(200).join(" ")).toContain("total=61");

    const withFallback = renderResult("search_graph")({ details: { data: { returned: 3, truncated: true } } }, undefined, theme);
    const line = withFallback.render(200).join(" ");
    expect(line).toContain("returned=3");
    expect(line).toContain("has_more");
  });
});
