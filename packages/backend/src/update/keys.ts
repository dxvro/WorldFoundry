// Public keys that may sign releases (Ed25519, SPKI PEM). The matching private key lives only in the
// GitHub Actions secret UPDATE_SIGNING_KEY of the project owner.
//
// Key rotation: first publish a release that lists the NEW key here in addition to the old one (signed with the
// old key), wait until installations have taken it over, then sign with the new key and finally remove the old one.
export interface TrustedKey {
  id: string;
  publicKey: string;
}

export const TRUSTED_UPDATE_KEYS: readonly TrustedKey[] = [
  {
    id: 'release-2026-11',
    publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARTlSHboo++bWLdJkFW/LhrrF7fkQ+M0deN+fgIbnGyE=
-----END PUBLIC KEY-----
`,
  },
];
