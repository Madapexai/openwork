import { expect, test } from "bun:test";
import { buildInstallDownloadHref, cloudInstallerFileName, detectedInstallPlatform, downloadCtaLabel, installerApiUrlFromConfig, installerFileName, installTokenFromPageUrl } from "../app/(den)/_lib/install-download";

test("organization installer downloads preserve a prefixed public API path", () => {
  expect(buildInstallDownloadHref(
    "https://on-prem.example.test/api/den/",
    "win-x64",
    "opaque/token value",
  )).toBe("https://on-prem.example.test/api/den/v1/install/win-x64?token=opaque%2Ftoken%20value");
});

test("enterprise download filenames match release artifacts", () => {
  expect(installerFileName("mac-arm64", "0.18.3")).toBe(
    "openwork-enterprise-mac-arm64-0.18.3.dmg",
  );
  expect(installerFileName("win-x64", "0.18.3")).toBe(
    "openwork-enterprise-win-x64-0.18.3.exe",
  );
  expect(installerFileName("linux-x64", "0.18.3")).toBe(
    "openwork-enterprise-linux-x86_64-0.18.3.AppImage",
  );
});

test("organization installer downloads still support a root API origin", () => {
  expect(buildInstallDownloadHref(
    "https://api.openwork.example.test",
    "mac-arm64",
    "opaque-token",
  )).toBe("https://api.openwork.example.test/v1/install/mac-arm64?token=opaque-token");
});

test("Cloud installer filenames match release artifacts without a hardcoded version", () => {
  expect(cloudInstallerFileName("mac-arm64", "0.18.4")).toBe(
    "openwork-cloud-mac-arm64-0.18.4.dmg",
  );
});

test("join success reads the install token from the minted page URL", () => {
  expect(installTokenFromPageUrl("https://den.example.test/install?token=opaque-token")).toBe("opaque-token");
  expect(installTokenFromPageUrl("https://den.example.test/install")).toBeNull();
  expect(installTokenFromPageUrl("not a url")).toBeNull();
});

test("join success labels the download for the detected OS and keeps people off /install", () => {
  expect(downloadCtaLabel("macos")).toBe("Download for macOS");
  expect(downloadCtaLabel("windows")).toBe("Download for Windows");
  expect(downloadCtaLabel("linux")).toBe("Download for Linux");
  expect(detectedInstallPlatform({ os: "macos", arch: "arm64" })).toBe("mac-arm64");
  expect(detectedInstallPlatform({ os: "windows", arch: "x64" })).toBe("win-x64");
  expect(installerApiUrlFromConfig({ apiUrl: "https://api.example.test/den/" })).toBe("https://api.example.test/den/");
  expect(installerApiUrlFromConfig({ apiUrl: "not a url" })).toBeNull();
});
