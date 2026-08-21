import { expect } from "vitest";
import { denFetch, evalIn, signIn, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

const requirements: NeedsSpec = {
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `join success download skipped — needs: ${missingRequirements.join(", ")}`
  : "joining a workspace downloads the detected OS installer without opening /install";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);

  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Acme Robotics ${runId}`;
  const invitee = {
    email: `maya+${runId}@openwork.test`,
    name: "Maya Chen",
    password: "OpenWorkEval123!",
  };

  await using den = await server({
    place,
    org: {
      name: orgName,
      admin: { name: "Jordan Chen" },
    },
  });

  const invitation = await denFetch(den.ref, "/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ email: invitee.email, role: "member" }),
  });
  const inviteToken = stringField(invitation.body, "inviteToken");
  if (!invitation.response.ok || !inviteToken) {
    throw new Error(`Invitation failed: HTTP ${invitation.response.status} ${invitation.text.slice(0, 500)}`);
  }

  const signUp = await denFetch(den.ref, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify(invitee),
  });
  if (!signUp.response.ok) {
    throw new Error(`Invitee sign-up failed: HTTP ${signUp.response.status} ${signUp.text.slice(0, 500)}`);
  }
  const member = await signIn(den.ref, { email: invitee.email, password: invitee.password });

  await using browser = await chrome({
    name: "join-org-success-download",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before invitee auth token handoff",
  });

  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(tokenStored).toBe(true);

  const inviteUrl = `${den.ref.webUrl}/join-org?invite=${encodeURIComponent(inviteToken)}`;
  await navigate(browser.client, inviteUrl);
  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="join-org-invitation-details"]'))
      && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !button.disabled)`,
    { timeoutMs: 45_000, label: "signed-in invite accept step" },
  );

  const joined = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(joined).toBe(true);

  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="join-org-success"]'))
      && Boolean(document.querySelector('[data-testid="join-org-get-app"]'))
      && !(document.querySelector('[data-testid="join-org-get-app"]') instanceof HTMLButtonElement
        && document.querySelector('[data-testid="join-org-get-app"]').disabled)`,
    { timeoutMs: 45_000, label: "join success download CTA" },
  );

  const success = await evalIn(browser, `(() => {
    const cta = document.querySelector('[data-testid="join-org-get-app"]');
    const openApp = document.querySelector('[data-testid="join-org-open-app"]');
    return {
      pathname: location.pathname,
      cta: (cta?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      openApp: (openApp?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      connected: Boolean(document.querySelector('[data-testid="join-org-connected"]')),
    };
  })()`);
  if (!isRecord(success) || typeof success.pathname !== "string" || typeof success.cta !== "string" || typeof success.openApp !== "string") {
    throw new Error(`Join success facts had an unexpected shape: ${JSON.stringify(success)}`);
  }

  expect(success.pathname).not.toBe("/install");
  expect(success.cta.startsWith("Download for")).toBe(true);
  expect(success.cta).not.toContain("Get the desktop app");
  expect(success.openApp).toBe("Already have OpenWork? Open it.");
  expect(success.connected).toBe(true);
  evidence.fact(
    "You're in offers Download for this computer instead of Get the desktop app",
    `pathname=${success.pathname}; cta=${success.cta}; openApp=${success.openApp}`,
    success.pathname !== "/install" && success.cta.startsWith("Download for") && success.openApp === "Already have OpenWork? Open it.",
  );

  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The heading says You're in",
      "The primary button starts with Download for",
      "A secondary action says Already have OpenWork? Open it.",
      "The page does not say Get the desktop app",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await evalIn(browser, `(() => {
    const hrefs = [];
    window.__joinInstallerHrefs = hrefs;
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedInstallerClick() {
      const href = this.getAttribute("href") || this.href || "";
      if (href.includes("/v1/install/")) {
        hrefs.push(href);
        return;
      }
      return original.call(this);
    };
    return true;
  })()`);

  const startedDownload = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="join-org-get-app"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(startedDownload).toBe(true);

  const downloadHref = await waitFor(
    browser,
    `document.querySelector('[data-testid="join-org-get-app"]')?.getAttribute("data-download-href") || ""`,
    { timeoutMs: 30_000, label: "org-served installer href on the join CTA" },
  );
  if (typeof downloadHref !== "string" || downloadHref.length === 0) {
    throw new Error(`Join success did not write an installer href: ${JSON.stringify(downloadHref)}`);
  }

  const afterDownload = await evalIn(browser, `({
    pathname: location.pathname,
    captured: Array.isArray(window.__joinInstallerHrefs) ? window.__joinInstallerHrefs.slice() : [],
  })`);
  if (!isRecord(afterDownload) || typeof afterDownload.pathname !== "string" || !Array.isArray(afterDownload.captured)) {
    throw new Error(`Download facts had an unexpected shape: ${JSON.stringify(afterDownload)}`);
  }
  const capturedHref = afterDownload.captured.find((entry) => typeof entry === "string") ?? "";

  expect(afterDownload.pathname).not.toBe("/install");
  expect(downloadHref).toContain("/v1/install/");
  expect(downloadHref).toContain("token=");
  expect(downloadHref.includes("/install?")).toBe(false);
  expect(capturedHref).toBe(downloadHref);
  evidence.fact(
    "The join CTA starts the org-served installer and stays on You're in",
    `pathname=${afterDownload.pathname}; href=${downloadHref}`,
    afterDownload.pathname !== "/install"
      && downloadHref.includes("/v1/install/")
      && downloadHref.includes("token=")
      && !downloadHref.includes("/install?")
      && capturedHref === downloadHref,
  );
});
