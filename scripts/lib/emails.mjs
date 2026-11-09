// Guards the rule that no private email address ever lands in the repository: not in a file, not in a commit.
// The project has exactly one contact address; everything else must be a no-reply address or a documented placeholder.

export const CONTACT_ADDRESS = 'worldfoundry0@gmail.com';

// Addresses that may appear in files besides the contact address. Each one is test data, never a real mailbox.
export const ALLOWED_IN_FILES = new Set([
  CONTACT_ADDRESS,
  // userinfo of URLs in tests of the update download ("https://user:pw@github.com/..."), not an address
  'pw@github.com',
  // "user@pc.lan": a login name with a host in an installer test
  'user@pc.lan',
]);

// Domains that are placeholders by definition (RFC 2606, RFC 6761)
const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|invalid|test|localhost|example)$/i;

// Who may be named as author, committer or co-author of a commit
const NOREPLY = /^(?:[0-9]+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$|^noreply@anthropic\.com$/;

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// "@scope/package" and "name@1.2.3" are npm specifiers, and a file name such as "icon@2x.png" is no address either
const FILE_EXTENSION = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|cjs|ts|tsx|json|md|txt|ya?ml|sh|ps1|cmd)$/i;

export function findAddresses(text) {
  return [...text.matchAll(ADDRESS)].map((match) => match[0]).filter((address) => !FILE_EXTENSION.test(address));
}

export const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);

// The addresses of a file that must not be there
export function forbiddenInFile(text) {
  return findAddresses(text).filter((address) => !ALLOWED_IN_FILES.has(address) && !PLACEHOLDER_DOMAIN.test(domainOf(address)));
}

// The addresses of commit metadata (author, committer, message) that must not be there
export function forbiddenInCommit(text) {
  return findAddresses(text).filter((address) => address !== CONTACT_ADDRESS && !NOREPLY.test(address) && !PLACEHOLDER_DOMAIN.test(domainOf(address)));
}
