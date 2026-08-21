import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  parseInviteLinkInput,
  parseServerUrlInput,
} from "../src/react-app/domains/cloud/join-organization-input";

const dialogPath = fileURLToPath(
  new URL("../src/react-app/domains/cloud/join-organization-dialog.tsx", import.meta.url),
);
const welcomePagePath = fileURLToPath(
  new URL("../src/react-app/domains/onboarding/welcome-page.tsx", import.meta.url),
);
const welcomeRoutePath = fileURLToPath(
  new URL("../src/react-app/shell/welcome-route.tsx", import.meta.url),
);

describe("join organization input classification", () => {
  test("recognizes Den web invite links and keeps their origin", () => {
    const parsed = parseInviteLinkInput("https://den.acme.test/join-org?invite=inv_123 ");

    expect(parsed).toEqual({
      url: "https://den.acme.test/join-org?invite=inv_123",
      origin: "https://den.acme.test",
      host: "den.acme.test",
    });
  });

  test("rejects invite lookalikes without a token, wrong paths, and non-http schemes", () => {
    expect(parseInviteLinkInput("https://den.acme.test/join-org")).toBeNull();
    expect(parseInviteLinkInput("https://den.acme.test/join-org?invite=")).toBeNull();
    expect(parseInviteLinkInput("https://den.acme.test/install?token=abc")).toBeNull();
    expect(parseInviteLinkInput("openwork://den-auth?grant=abcdefghijkl")).toBeNull();
    expect(parseInviteLinkInput("not a url")).toBeNull();
  });

  test("recognizes plain server URLs but never raw grants or deep links", () => {
    expect(parseServerUrlInput(" https://openwork.acme.test/ ")).toEqual({
      url: "https://openwork.acme.test",
      host: "openwork.acme.test",
    });
    expect(parseServerUrlInput("http://localhost:3005")).toEqual({
      url: "http://localhost:3005",
      host: "localhost:3005",
    });
    expect(parseServerUrlInput("openwork://den-auth?grant=abcdefghijkl")).toBeNull();
    expect(parseServerUrlInput("den.acme.test")).toBeNull();
    expect(parseServerUrlInput("raw-sign-in-grant-value")).toBeNull();
  });
});

describe("welcome one-field contract", () => {
  test("the join dialog classifies install, invite, server URL, then sign-in code", () => {
    const source = readFileSync(dialogPath, "utf8");

    expect(source).toContain("if (await submitInstallLink(trimmedInput)) return;");
    expect(source).toContain("if (await submitInviteLink(trimmedInput)) return;");
    expect(source).toContain("if (await submitServerUrl(trimmedInput)) return;");
    expect(source).toContain("if (await submitManualAuth(trimmedInput)) return;");
    expect(source.indexOf("submitInstallLink(trimmedInput)")).toBeLessThan(
      source.indexOf("submitInviteLink(trimmedInput)"),
    );
    expect(source.indexOf("submitInviteLink(trimmedInput)")).toBeLessThan(
      source.indexOf("submitServerUrl(trimmedInput)"),
    );
    expect(source.indexOf("submitServerUrl(trimmedInput)")).toBeLessThan(
      source.indexOf("submitManualAuth(trimmedInput)"),
    );
    expect(source).toContain("setPendingInvite(parsed)");
    expect(source).toContain('data-testid="join-invite-confirm-dialog"');
    expect(source).toContain("saveControlPlaneUrl(invite.origin)");
    expect(source).toContain("platform.openLink(invite.url)");
    expect(source).toContain('setStatus({ phase: "invite-opened", host: invite.host });');
    expect(source).toContain('setStatus({ phase: "server-saved", host: hostFromUrl(persisted.baseUrl) });');
    expect(source).toContain('clearDenSession({ includeBaseUrls: false });');
  });

  test("the welcome page has one join door and no separate server-URL affordance", () => {
    const pageSource = readFileSync(welcomePagePath, "utf8");
    const routeSource = readFileSync(welcomeRoutePath, "utf8");

    expect(pageSource).toContain('data-testid="welcome-team-signin"');
    expect(pageSource).toContain('data-testid="welcome-use-without-cloud"');
    expect(pageSource).toContain('data-testid="welcome-join-org"');
    expect(pageSource).not.toContain("OrganizationServerAffordance");
    expect(pageSource).not.toContain("organizationServerUrl");
    expect(routeSource).not.toContain("OrganizationServerAffordance");
    expect(routeSource).not.toContain("handleOrganizationServerSave");
    expect(routeSource).toContain("<JoinOrganizationDialog");
  });
});
