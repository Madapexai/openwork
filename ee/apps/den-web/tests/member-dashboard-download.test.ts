import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  buildInstallDownloadHref,
  detectedInstallPlatform,
  downloadCtaLabel,
} from "../app/(den)/_lib/install-download";

const memberDashboardPath = fileURLToPath(
  new URL("../app/(den)/dashboard/_components/member-dashboard-screen.tsx", import.meta.url),
);

function readMemberDashboardSource() {
  return readFileSync(memberDashboardPath, "utf8");
}

describe("member dashboard direct download contract", () => {
  test("downloads the detected-OS installer instead of opening the install page", () => {
    const source = readMemberDashboardSource();

    expect(source).toContain("downloadCtaLabel(detected?.os ?? null)");
    expect(source).toContain("buildInstallDownloadHref");
    expect(source).toContain("detectedInstallPlatform");
    expect(source).toContain("installTokenFromPageUrl");
    expect(source).toContain("installerApiUrlFromConfig");
    expect(source).toContain("startInstallerDownload");
    expect(source).toContain("/v1/install-config?token=");
    expect(source).toContain('data-download-href={downloadHref ?? undefined}');
    expect(source).toContain('link.setAttribute("data-testid", "member-download-link")');
    expect(source).not.toContain("window.open(await mintInstallLink()");
    expect(source).not.toContain(">Download OpenWork<");
  });

  test("keeps the copy-install-link fallback for other machines", () => {
    const source = readMemberDashboardSource();

    expect(source).toContain('data-testid="member-copy-install-link"');
    expect(source).toContain("Copy install link instead");
    expect(source).toContain("navigator.clipboard.writeText(await mintInstallLink())");
  });

  test("builds the same org-served installer href as the join success screen", () => {
    const platform = detectedInstallPlatform({ os: "windows", arch: "x64" }) ?? "mac-arm64";
    const href = buildInstallDownloadHref("https://api.example.test/den", platform, "member-token");

    expect(downloadCtaLabel("windows")).toBe("Download for Windows");
    expect(href).toBe("https://api.example.test/den/v1/install/win-x64?token=member-token");
    expect(href).not.toContain("/install?");
  });
});
