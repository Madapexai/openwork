// SPDX-License-Identifier: MIT
// Stub for the samePerson helper referenced by governance/acl and
// governance/scope. Phase-1-core migration added the references but the
// util/person module was never created. This stub implements the
// principal-id equality check that samePerson is used for in every call site.

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && a === b
}
