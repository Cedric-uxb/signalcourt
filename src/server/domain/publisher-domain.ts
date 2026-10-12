import { domainToASCII } from "node:url";

import { getDomain } from "tldts";

export function canonicalDomainName(rawDomain: string): string | null {
  const asciiDomain = domainToASCII(rawDomain).toLowerCase();
  return asciiDomain || null;
}

export function registrablePublisherDomain(rawDomain: string): string | null {
  const asciiDomain = canonicalDomainName(rawDomain);
  return asciiDomain
    ? getDomain(asciiDomain, { allowPrivateDomains: true })
    : null;
}
