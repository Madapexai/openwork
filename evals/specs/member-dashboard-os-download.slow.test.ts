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
  ? `member dashboard download skipped — needs: ${missingRequirements.join(", ")}`
  : "the member dashboard downloads the detected OS installer without opening /install";

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
  const invitationId = stringField(invitation.body, "invitationId");
  if (!invitation.response.ok || !invitationId) {
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

  const accepted = await denFetch(den.ref, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ id: invitationId }),
  });
  if (!accepted.response.ok) {
    throw new Error(`Invitation accept failed: HTTP ${accepted.response.status} ${accepted.text.slice(0, 500)}`);
  }

  await using browser = await chrome({
    name: "member-dashboard-os-download",
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
    label: "Den Web origin before member auth token handoff",
  });

  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard`);
  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="member-dashboard"]'))
      && Boolean(document.querySelector('[data-testid="member-download-app"]'))
      && !(document.querySelector('[data-testid="member-download-app"]') instanceof HTMLButtonElement
        && document.querySelector('[data-testid="member-download-app"]').disabled)`,
    { timeoutMs: 60_000, label: "member dashboard download CTA" },
  );

  const dashboard = await evalIn(browser, `(() => {
    const cta = document.querySelector('[data-testid="member-download-app"]');
    return {
      pathname: location.pathname,
      cta: (cta?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      copyLink: Boolean(document.querySelector('[data-testid="member-copy-install-link"]')),
    };
  })()`);
  if (!isRecord(dashboard) || typeof dashboard.pathname !== "string" || typeof dashboard.cta !== "string") {
    throw new Error(`Member dashboard facts had an unexpected shape: ${JSON.stringify(dashboard)}`);
  }

  expect(dashboard.pathname).toBe("/dashboard");
  expect(dashboard.cta.startsWith("Download for")).toBe(true);
  expect(dashboard.cta).not.toContain("Download OpenWork");
  expect(dashboard.copyLink).toBe(true);
  evidence.fact(
    "The member dashboard offers Download for this computer instead of Download OpenWork",
    `pathname=${dashboard.pathname}; cta=${dashboard.cta}; copyLink=${String(dashboard.copyLink)}`,
    dashboard.pathname === "/dashboard" && dashboard.cta.startsWith("Download for") && dashboard.copyLink === true,
  );

  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The heading says the workspace is set up for you",
      "The primary button starts with Download for",
      "A smaller action offers to copy the install link instead",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await evalIn(browser, `(() => {
    const hrefs = [];
    window.__memberInstallerHrefs = hrefs;
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
    const button = document.querySelector('[data-testid="member-download-app"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(startedDownload).toBe(true);

  const downloadHref = await waitFor(
    browser,
    `document.querySelector('[data-testid="member-download-app"]')?.getAttribute("data-download-href") || ""`,
    { timeoutMs: 30_000, label: "org-served installer href on the member CTA" },
  );
  if (typeof downloadHref !== "string" || downloadHref.length === 0) {
    throw new Error(`Member dashboard did not write an installer href: ${JSON.stringify(downloadHref)}`);
  }

  const afterDownload = await evalIn(browser, `({
    pathname: location.pathname,
    captured: Array.isArray(window.__memberInstallerHrefs) ? window.__memberInstallerHrefs.slice() : [],
  })`);
  if (!isRecord(afterDownload) || typeof afterDownload.pathname !== "string" || !Array.isArray(afterDownload.captured)) {
    throw new Error(`Download facts had an unexpected shape: ${JSON.stringify(afterDownload)}`);
  }
  const capturedHref = afterDownload.captured.find((entry) => typeof entry === "string") ?? "";

  expect(afterDownload.pathname).toBe("/dashboard");
  expect(downloadHref).toContain("/v1/install/");
  expect(downloadHref).toContain("token=");
  expect(downloadHref.includes("/install?")).toBe(false);
  expect(capturedHref).toBe(downloadHref);
  evidence.fact(
    "The member CTA starts the org-served installer and stays on the dashboard",
    `pathname=${afterDownload.pathname}; href=${downloadHref}`,
    afterDownload.pathname === "/dashboard"
      && downloadHref.includes("/v1/install/")
      && downloadHref.includes("token=")
      && !downloadHref.includes("/install?")
      && capturedHref === downloadHref,
  );
});
