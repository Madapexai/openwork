import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  buildInstallDownloadHref,
  detectedInstallPlatform,
  downloadCtaLabel,
  installerApiUrlFromConfig,
  installTokenFromPageUrl,
} from "../../ee/apps/den-web/app/(den)/_lib/install-download";

const joinOrgSuccessPath = fileURLToPath(
  new URL("../../ee/apps/den-web/app/(den)/_components/join-org-success.tsx", import.meta.url),
);

test("You're in downloads for the detected OS instead of opening /install", async ({ evidence }) => {
  const source = readFileSync(joinOrgSuccessPath, "utf8");
  const minted = "https://den.example.test/install?token=invite-success-token";
  const href = buildInstallDownloadHref(
    installerApiUrlFromConfig({ apiUrl: "https://api.example.test/den" }) ?? "",
    detectedInstallPlatform({ os: "macos", arch: "arm64" }) ?? "mac-arm64",
    installTokenFromPageUrl(minted) ?? "",
  );

  expect(downloadCtaLabel("macos")).toBe("Download for macOS");
  expect(downloadCtaLabel("windows")).toBe("Download for Windows");
  expect(downloadCtaLabel("linux")).toBe("Download for Linux");
  expect(href).toBe("https://api.example.test/den/v1/install/mac-arm64?token=invite-success-token");
  expect(href).not.toContain("/install?");
  expect(source).toContain("downloadCtaLabel");
  expect(source).toContain("startInstallerDownload");
  expect(source).toContain('data-download-href={downloadHref ?? undefined}');
  expect(source).toContain("Already have OpenWork? Open it.");
  expect(source).toContain('data-testid="join-org-open-app"');
  expect(source).not.toContain("Get the desktop app");
  expect(source).not.toContain("window.location.assign(await createOrganizationInstallLink");
  expect(installTokenFromPageUrl("https://den.example.test/join-org")).toBeNull();

  evidence.fact(
    "The joined welcome screen starts the OS installer instead of opening /install",
    "You're in labels Download for the detected OS, writes the org-served /v1/install href onto the CTA, and never assigns the guided /install page.",
    true,
  );
});
