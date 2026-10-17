import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCbmVersion, parseCbmVersion, SUPPORTED_CBM_VERSION_RANGE } from "../src/cbm/version.js";

function versionFixture(version: string): string {
  return readFileSync(new URL(`./fixtures/cbm-${version}/version.long-flag.json`, import.meta.url), "utf8");
}

describe("cbm version gate", () => {
  it("parses the captured 0.12.1 --version output", () => {
    expect(parseCbmVersion(versionFixture("0.12.1"))).toEqual({ major: 0, minor: 12, patch: 1 });
  });

  it("parses the captured 0.9.0 --version output", () => {
    expect(parseCbmVersion(versionFixture("0.9.0"))).toEqual({ major: 0, minor: 9, patch: 0 });
  });

  it("accepts 0.12.x", () => {
    expect(evaluateCbmVersion({ major: 0, minor: 12, patch: 1 })).toEqual({ status: "ok", version: "0.12.1" });
  });

  it("rejects 0.9.0 with the version and reinstall guidance", () => {
    const check = evaluateCbmVersion(parseCbmVersion(versionFixture("0.9.0")));
    expect(check.status).toBe("too-old");
    expect(check.message).toContain("0.9.0");
    expect(check.message).toContain(SUPPORTED_CBM_VERSION_RANGE);
    expect(check.message).toContain("reinstall npm:pi-cbm@1.2.1");
  });

  it("warns but allows a newer 0.13.0", () => {
    const check = evaluateCbmVersion({ major: 0, minor: 13, patch: 0 });
    expect(check.status).toBe("untested-newer");
    expect(check.warning).toContain(SUPPORTED_CBM_VERSION_RANGE);
  });

  it("treats unparseable output as unknown and allowed", () => {
    const check = evaluateCbmVersion(parseCbmVersion("not a version"));
    expect(check.status).toBe("unknown");
    expect(check.warning).toBeTruthy();
  });
});
