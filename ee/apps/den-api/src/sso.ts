import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { XMLParser } from "fast-xml-parser"
import { z } from "zod"
import { auth } from "./auth.js"
import { db } from "./db.js"
import { isOrganizationSsoReady } from "./sso-readiness.js"
import { env } from "./env.js"
import { isMicrosoftEntraManagedDomain } from "./sso-entra-domain.js"
import { SSO_IDENTITY_EXTRA_FIELDS } from "./sso-jit.js"
import { ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED } from "./sso-saml-policy.js"

const SSO_PROVIDER_PREFIX = env.ssoProviderPrefix ?? "sso"

type SsoConnection = typeof SsoConnectionTable.$inferSelect
type OrganizationId = SsoConnection["organizationId"]
type SsoTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type SamlRegistrationInput = {
  kind: "saml"
  issuer: string
  domain: string
  entryPoint: string
  cert: string
  audience?: string | null
}

type OidcRegistrationInput = {
  kind: "oidc"
  issuer: string
  domain: string
  clientId: string
  clientSecret: string
  scopes?: string[] | null
  skipDiscovery?: boolean | null
  authorizationEndpoint?: string | null
  tokenEndpoint?: string | null
  jwksEndpoint?: string | null
  userInfoEndpoint?: string | null
  tokenEndpointAuthentication?: "client_secret_basic" | "client_secret_post" | null
}

export type OrganizationSsoRegistrationInput = (SamlRegistrationInput | OidcRegistrationInput) & {
  organizationId: OrganizationId
  organizationSlug: string
  headers: Headers
}

const oidcDiscoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
})

export function buildOrganizationSsoProviderId(organizationId: OrganizationId, customPrefix?: string) {
  const prefix = customPrefix?.trim() || SSO_PROVIDER_PREFIX
  return `${prefix}-${organizationId}`
}

export function getSsoAcsUrl(providerId: string, customDomain?: string | null) {
  const baseUrl = customDomain?.trim() ? customDomain.replace(/\/+$/, "") : env.betterAuthUrl
  return `${baseUrl}/api/auth/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`
}

export function getSsoMetadataUrl(providerId: string, customDomain?: string | null) {
  const baseUrl = customDomain?.trim() ? customDomain.replace(/\/+$/, "") : env.betterAuthUrl
  return `${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`
}

export function getSsoOidcRedirectUrl(providerId: string, customDomain?: string | null) {
  const baseUrl = customDomain?.trim() ? customDomain.replace(/\/+$/, "") : env.betterAuthUrl
  return `${baseUrl}/api/auth/sso/callback/${encodeURIComponent(providerId)}`
}

export function getOrganizationSsoSignInPath(organizationSlug: string) {
  return `/sso/${encodeURIComponent(organizationSlug)}`
}

function isDevLoopbackIssuer(issuer: string) {
  if (!env.devMode) return false
  try {
    const url = new URL(issuer)
    return url.hostname === "127.0.0.1" || url.hostname === "localhost"
  } catch {
    return false
  }
}

function getOidcDiscoveryUrl(issuer: string) {
  return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
}

function normalizeIssuer(value: string) {
  return value.replace(/\/$/, "")
}

async function resolveOidcEndpoints(input: OidcRegistrationInput) {
  if (input.skipDiscovery) {
    if (!input.authorizationEndpoint || !input.tokenEndpoint || !input.jwksEndpoint) {
      throw new Error("Manual OIDC configuration requires authorization, token, and JWKS endpoints.")
    }

    return {
      skipDiscovery: true,
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      jwksEndpoint: input.jwksEndpoint,
      userInfoEndpoint: input.userInfoEndpoint ?? undefined,
      tokenEndpointAuthentication: input.tokenEndpointAuthentication ?? undefined,
    }
  }

  const response = await fetch(getOidcDiscoveryUrl(input.issuer), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery failed with ${response.status}. Enter manual OIDC endpoints or enable skip discovery.`)
  }

  const parsed = oidcDiscoverySchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error("OIDC discovery document is missing required endpoints.")
  }
  if (normalizeIssuer(parsed.data.issuer) !== normalizeIssuer(input.issuer)) {
    throw new Error("OIDC discovery issuer does not match the configured issuer.")
  }

  return {
    skipDiscovery: true,
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    jwksEndpoint: parsed.data.jwks_uri,
    userInfoEndpoint: parsed.data.userinfo_endpoint,
    tokenEndpointAuthentication: input.tokenEndpointAuthentication ?? undefined,
  }
}

async function getSsoProviderByProviderId(providerId: string) {
  const rows = await db
    .select()
    .from(SsoProviderTable)
    .where(eq(SsoProviderTable.providerId, providerId))
    .limit(1)

  return rows[0] ?? null
}

async function registerBetterAuthSsoProvider(input: OrganizationSsoRegistrationInput, providerId: string) {
  if (input.kind === "saml") {
    const audience = input.audience || env.betterAuthUrl
    return auth.api.registerSSOProvider({
      body: {
        providerId,
        issuer: audience,
        domain: input.domain,
        organizationId: input.organizationId,
        samlConfig: {
          entryPoint: input.entryPoint,
          cert: input.cert,
          audience,
          idpMetadata: {
            entityID: input.issuer,
          },
          wantAssertionsSigned: ORGANIZATION_SAML_WANT_ASSERTIONS_SIGNED,
          spMetadata: {
            entityID: audience,
          },
          mapping: {
            id: "nameID",
            email: "email",
            name: "displayName",
            extraFields: SSO_IDENTITY_EXTRA_FIELDS,
          },
        },
      },
      headers: input.headers,
    })
  }

  const oidcEndpoints = await resolveOidcEndpoints(input)
  return auth.api.registerSSOProvider({
    body: {
      providerId,
      issuer: input.issuer,
      domain: input.domain,
      organizationId: input.organizationId,
      oidcConfig: {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        ...oidcEndpoints,
        scopes: input.scopes ?? ["openid", "email", "profile"],
        pkce: true,
        mapping: {
          id: "sub",
          email: "email",
          emailVerified: "email_verified",
          name: "name",
          image: "picture",
          extraFields: SSO_IDENTITY_EXTRA_FIELDS,
        },
      },
    },
    headers: input.headers,
  })
}

export async function getOrganizationSsoConnection(organizationId: OrganizationId) {
  const rows = await db
    .select()
    .from(SsoConnectionTable)
    .where(eq(SsoConnectionTable.organizationId, organizationId))
    .limit(1)

  return rows[0] ?? null
}

async function cleanupExternalIdentitiesForDeletedSsoConnection(
  tx: SsoTransaction,
  connection: SsoConnection,
) {
  await tx
    .update(ExternalIdentityTable)
    .set({
      source: "scim",
      ssoProviderId: null,
      remoteId: null,
      attributesJson: null,
      lastSsoLoginAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.ssoProviderId, connection.providerId),
      isNotNull(ExternalIdentityTable.scimProviderId),
    ))

  await tx
    .update(ExternalIdentityTable)
    .set({
      active: false,
      ssoProviderId: null,
      remoteId: null,
      attributesJson: null,
      lastSsoLoginAt: null,
    })
    .where(and(
      eq(ExternalIdentityTable.organizationId, connection.organizationId),
      eq(ExternalIdentityTable.ssoProviderId, connection.providerId),
      isNull(ExternalIdentityTable.scimProviderId),
    ))

  await tx
    .delete(AuthAccountTable)
    .where(eq(AuthAccountTable.providerId, connection.providerId))
}

async function cleanupLegacySsoProvider(
  tx: SsoTransaction,
  connection: SsoConnection,
  canonicalProviderId: string,
) {
  if (connection.providerId === canonicalProviderId) {
    return
  }

  await cleanupExternalIdentitiesForDeletedSsoConnection(tx, connection)
  await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
}

export async function deleteOrganizationSsoConnection(organizationId: OrganizationId) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) {
    return false
  }

  await db.transaction(async (tx) => {
    await cleanupExternalIdentitiesForDeletedSsoConnection(tx, connection)
    await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.id, connection.id))
    await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.providerId, connection.providerId))
  })
  return true
}

export async function registerOrganizationSsoConnection(input: OrganizationSsoRegistrationInput) {
  const providerId = buildOrganizationSsoProviderId(input.organizationId)
  const existing = await getOrganizationSsoConnection(input.organizationId)
  const domainVerified = isDevLoopbackIssuer(input.issuer) || isMicrosoftEntraManagedDomain({
    domain: input.domain,
    issuer: input.issuer,
    entryPoint: input.kind === "saml" ? input.entryPoint : null,
  })

  if (existing) {
    const existingProvider = await getSsoProviderByProviderId(providerId)
    if (!existingProvider) {
      await registerBetterAuthSsoProvider(input, providerId)
      if (domainVerified) {
        await db
          .update(SsoProviderTable)
          .set({ domainVerified: true })
          .where(eq(SsoProviderTable.providerId, providerId))
      }
      await db.transaction(async (tx) => {
        await cleanupLegacySsoProvider(tx, existing, providerId)
        await tx
          .update(SsoConnectionTable)
          .set({
            providerId,
            kind: input.kind,
            issuer: input.issuer,
            domain: input.domain,
            status: "enabled",
            signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
            lastTestedAt: new Date(),
            lastError: null,
          })
          .where(eq(SsoConnectionTable.id, existing.id))
      })

      const connection = await getOrganizationSsoConnection(input.organizationId)
      if (!connection) {
        throw new Error("SSO connection was updated, but could not be loaded.")
      }

      return connection
    }

    const draftProviderId = `${providerId}-draft-${createDenTypeId("ssoConnection")}`
    await registerBetterAuthSsoProvider(input, draftProviderId)

    const draftProvider = await getSsoProviderByProviderId(draftProviderId)
    if (!draftProvider) {
      throw new Error("Draft SSO provider was not created.")
    }

    await db.transaction(async (tx) => {
      await tx
        .update(SsoProviderTable)
        .set({
          issuer: draftProvider.issuer,
          domain: draftProvider.domain,
          oidcConfig: draftProvider.oidcConfig,
          samlConfig: draftProvider.samlConfig,
          domainVerified,
        })
        .where(eq(SsoProviderTable.providerId, providerId))

      await cleanupLegacySsoProvider(tx, existing, providerId)
      await tx
        .update(SsoConnectionTable)
        .set({
          providerId,
          kind: input.kind,
          issuer: input.issuer,
          domain: input.domain,
          status: "enabled",
          signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
          lastTestedAt: new Date(),
          lastError: null,
        })
        .where(eq(SsoConnectionTable.id, existing.id))

      await tx
        .delete(SsoProviderTable)
        .where(eq(SsoProviderTable.providerId, draftProviderId))
    })

    const connection = await getOrganizationSsoConnection(input.organizationId)
    if (!connection) {
      throw new Error("SSO connection was updated, but could not be loaded.")
    }

    return connection
  }

  await registerBetterAuthSsoProvider(input, providerId)
  if (domainVerified) {
    await db
      .update(SsoProviderTable)
      .set({ domainVerified: true })
      .where(eq(SsoProviderTable.providerId, providerId))
  }

  await db.insert(SsoConnectionTable).values({
    id: createDenTypeId("ssoConnection"),
    organizationId: input.organizationId,
    providerId,
    kind: input.kind,
    issuer: input.issuer,
    domain: input.domain,
    status: "enabled",
    signInPath: getOrganizationSsoSignInPath(input.organizationSlug),
    lastTestedAt: new Date(),
    lastError: null,
  })

  const connection = await getOrganizationSsoConnection(input.organizationId)
  if (!connection) {
    throw new Error("SSO connection was created, but could not be loaded.")
  }

  return connection
}

export async function startOrganizationSsoSignIn(input: {
  organizationSlug: string
  callbackURL: string
  loginHint?: string | null
}) {
  return auth.api.signInSSO({
    body: {
      organizationSlug: input.organizationSlug,
      callbackURL: input.callbackURL,
      loginHint: input.loginHint || undefined,
    },
  })
}

export async function getSsoProviderForConnection(connection: SsoConnection) {
  const rows = await db
    .select()
    .from(SsoProviderTable)
    .where(and(
      eq(SsoProviderTable.providerId, connection.providerId),
      eq(SsoProviderTable.organizationId, connection.organizationId),
    ))
    .limit(1)

  return rows[0] ?? null
}

export async function hasEnabledOrganizationSsoConnection(organizationId: OrganizationId) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) {
    return false
  }

  const provider = await getSsoProviderForConnection(connection)
  return isOrganizationSsoReady({ connection, providerExists: Boolean(provider) })
}

const samlMetadataResponseSchema = z.object({
  entityID: z.string().url().or(z.string()),
  idpSsoBinding: z.object({
    redirect: z.string().url().optional(),
    post: z.string().url().optional(),
  }),
  idpSloBinding: z.object({
    redirect: z.string().url().optional(),
    post: z.string().url().optional(),
  }).optional(),
  certificate: z.string().min(1),
  wantAuthnRequestsSigned: z.boolean().optional(),
  nameIdFormat: z.array(z.string()).optional(),
})

export type ParsedSamlMetadata = z.infer<typeof samlMetadataResponseSchema>

export async function parseSamlMetadataFromUrl(metadataUrl: string): Promise<ParsedSamlMetadata> {
  const response = await fetch(metadataUrl, {
    headers: { accept: "application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch SAML metadata from ${metadataUrl} (${response.status})`)
  }
  const xmlText = await response.text()
  return parseSamlMetadataXml(xmlText)
}

export function parseSamlMetadataXml(xmlText: string): ParsedSamlMetadata {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
  })
  const parsed = parser.parse(xmlText)

  const entityDescriptor = parsed?.["md:EntityDescriptor"]
  if (!entityDescriptor) {
    throw new Error("SAML metadata must be an EntityDescriptor document.")
  }

  const entityID = entityDescriptor["@_entityID"] ?? ""

  const idpSsoDescriptor = entityDescriptor["md:IDPSSODescriptor"] ?? {}
  const wantAuthnRequestsSigned = idpSsoDescriptor["@_WantAuthnRequestsSigned"] === "true"

  const singleSignOnServices = idpSsoDescriptor["md:SingleSignOnService"]
  const ssoServices = Array.isArray(singleSignOnServices)
    ? singleSignOnServices
    : singleSignOnServices
      ? [singleSignOnServices]
      : []

  const idpSsoRedirect = ssoServices.find(
    (svc: Record<string, unknown>) =>
      svc["@_Binding"] === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  )
  const idpSsoPost = ssoServices.find(
    (svc: Record<string, unknown>) =>
      svc["@_Binding"] === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
  )

  const singleLogoutServices = idpSsoDescriptor["md:SingleLogoutService"]
  const sloServices = Array.isArray(singleLogoutServices)
    ? singleLogoutServices
    : singleLogoutServices
      ? [singleLogoutServices]
      : []

  const idpSloRedirect = sloServices.find(
    (svc: Record<string, unknown>) =>
      svc["@_Binding"] === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  )
  const idpSloPost = sloServices.find(
    (svc: Record<string, unknown>) =>
      svc["@_Binding"] === "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
  )

  const keyDescriptors = idpSsoDescriptor["md:KeyDescriptor"]
  const keyDescs = Array.isArray(keyDescriptors)
    ? keyDescriptors
    : keyDescriptors
      ? [keyDescriptors]
      : []

  const signingKey = keyDescs.find(
    (kd: Record<string, unknown>) => kd["@_use"] === "signing",
  )
  const encryptionKey = keyDescs.find(
    (kd: Record<string, unknown>) => kd["@_use"] === "encryption",
  )
  const fallbackKey = keyDescs[0]

  const certElement =
    signingKey?.["ds:X509Certificate"] ??
    encryptionKey?.["ds:X509Certificate"] ??
    fallbackKey?.["ds:X509Certificate"]

  const nameIdFormats = idpSsoDescriptor["md:NameIDFormat"]
  const nameIds = Array.isArray(nameIdFormats)
    ? nameIdFormats.map((f: string) => f?.trim() ?? "").filter(Boolean)
    : nameIdFormats
      ? [nameIdFormats]
      : []

  const result: ParsedSamlMetadata = {
    entityID,
    idpSsoBinding: {
      redirect: idpSsoRedirect?.["@_Location"] as string | undefined,
      post: idpSsoPost?.["@_Location"] as string | undefined,
    },
    idpSloBinding:
      idpSloRedirect || idpSloPost
        ? {
            redirect: idpSloRedirect?.["@_Location"] as string | undefined,
            post: idpSloPost?.["@_Location"] as string | undefined,
          }
        : undefined,
    certificate: (certElement as string | undefined)?.trim().replace(/\s+/g, "") ?? "",
    wantAuthnRequestsSigned: wantAuthnRequestsSigned,
    nameIdFormat: nameIds,
  }

  if (!result.entityID) throw new Error("SAML metadata is missing the entityID.")
  if (!result.certificate) throw new Error("SAML metadata is missing an X.509 certificate.")
  if (!result.idpSsoBinding.redirect && !result.idpSsoBinding.post) {
    throw new Error("SAML metadata is missing an SSO service URL.")
  }

  return samlMetadataResponseSchema.parse(result)
}

const oidcMetadataResponseSchema = z.object({
  issuer: z.string().url(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  jwksUri: z.string().url(),
  userinfoEndpoint: z.string().url().optional(),
  scopesSupported: z.array(z.string()).optional(),
  responseTypesSupported: z.array(z.string()).optional(),
  grantTypesSupported: z.array(z.string()).optional(),
  subjectTypesSupported: z.array(z.string()).optional(),
})

export type ParsedOidcMetadata = z.infer<typeof oidcMetadataResponseSchema>

export async function parseOidcMetadataFromUrl(issuerUrl: string): Promise<ParsedOidcMetadata> {
  const discoveryUrl = getOidcDiscoveryUrl(issuerUrl)
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`OIDC discovery failed at ${discoveryUrl} (${response.status})`)
  }
  const data = await response.json()
  return oidcMetadataResponseSchema.parse({
    issuer: data.issuer,
    authorizationEndpoint: data.authorization_endpoint,
    tokenEndpoint: data.token_endpoint,
    jwksUri: data.jwks_uri,
    userinfoEndpoint: data.userinfo_endpoint,
    scopesSupported: data.scopes_supported,
    responseTypesSupported: data.response_types_supported,
    grantTypesSupported: data.grant_types_supported,
    subjectTypesSupported: data.subject_types_supported,
  })
}

export async function testSsoConnection(input: {
  kind: "saml" | "oidc"
  issuer: string
  entryPoint?: string
  cert?: string
  clientId?: string
  skipDiscovery?: boolean
  authorizationEndpoint?: string
  tokenEndpoint?: string
  jwksEndpoint?: string
}) {
  const errors: string[] = []

  try {
    if (input.kind === "saml") {
      if (input.entryPoint) {
        const response = await fetch(input.entryPoint, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok && response.status !== 405) {
          errors.push(`SAML entry point returned HTTP ${response.status}`)
        }
      }
      if (!input.cert) {
        errors.push("SAML certificate is required for testing.")
      }
    } else {
      if (input.skipDiscovery && input.authorizationEndpoint) {
        const response = await fetch(input.authorizationEndpoint, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) {
          errors.push(`OIDC authorization endpoint returned HTTP ${response.status}`)
        }
      } else {
        const parsed = await parseOidcMetadataFromUrl(input.issuer)
        if (!parsed) {
          errors.push("OIDC discovery returned invalid metadata.")
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : "Connection test failed.")
  }

  return {
    ok: errors.length === 0,
    errors,
    timestamp: new Date().toISOString(),
  }
}

export async function getOrganizationSsoCustomDomain(organizationId: OrganizationId) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) return null
  const provider = await getSsoProviderForConnection(connection)
  return provider?.customDomain ?? null
}

export async function updateOrganizationSsoCustomDomain(
  organizationId: OrganizationId,
  customDomain: string | null,
) {
  const connection = await getOrganizationSsoConnection(organizationId)
  if (!connection) return null

  await db.transaction(async (tx) => {
    await tx
      .update(SsoProviderTable)
      .set({ customDomain })
      .where(eq(SsoProviderTable.providerId, connection.providerId))
  })

  return getSsoProviderForConnection(connection)
}
