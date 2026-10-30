const KNOWN_FORMATS = [
  [/\b[sr]k_live_[0-9a-zA-Z]{16,}/, 'Stripe live key'],
  [/\bsk-(?:proj-|ant-)?[\w-]{20,}/, 'AI provider API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_\w{30,}/, 'GitHub token'],
  [/\bglpat-[\w-]{20,}/, 'GitLab token'],
  [/\bxox[abprs]-[\w-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bAIza[\w-]{35}\b/, 'Google API key'],
  [/\bSG\.[\w-]{16,}\.[\w-]{16,}/, 'SendGrid key'],
  [/\bnpm_[A-Za-z0-9]{30,}/, 'npm token'],
  [/\bwhsec_[A-Za-z0-9+/=]{16,}/, 'webhook signing secret'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/, 'JSON Web Token'],
];

const PLACEHOLDER =
  /your|example|change|replace|placeholder|generate|openssl|xxxx|todo|dummy|sample|<.+>|\.\.\.|^\*+$|^test|test$/i;
const WEAK_PASSWORD = /^(pass(word)?|pwd|secret|root|admin)$/i;
const SENSITIVE_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_?KEY|ACCESS_KEY|AUTH_KEY/i;
const URL_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@([^\s/:?]+)/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal)$/i;

function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Returns why a value looks like a real secret, or null. */
export function detectSecret(name, value) {
  if (!value || PLACEHOLDER.test(value)) return null;

  for (const [pattern, label] of KNOWN_FORMATS) {
    if (pattern.test(value)) return label;
  }

  const url = URL_CREDENTIALS.exec(value);
  if (url) {
    const [, password, host] = url;
    // Hosts without a dot are docker-compose service names, so still local.
    const isLocal = LOCAL_HOST.test(host) || !host.includes('.');
    return isLocal || WEAK_PASSWORD.test(password) ? null : 'URL with embedded password';
  }

  if (
    SENSITIVE_NAME.test(name) &&
    value.length >= 16 &&
    !value.includes('://') &&
    !/\s/.test(value) &&
    entropy(value) >= 3.5
  ) {
    return 'high-entropy value in a sensitive variable';
  }

  return null;
}
