/**
 * Last-line-of-defense scan over the sandbox's final answer before it is
 * returned to a peer. This is defense-in-depth, not the primary boundary —
 * the primary boundaries are tool scoping and the deny rules. On any hit the
 * whole answer is blocked and the owner is notified via the audit log.
 */

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    name: "generic-secret-assignment",
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\b["'\s]*[:=]\s*["']?[A-Za-z0-9_\-/+]{16,}/i,
  },
];

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function findCardNumbers(text: string): boolean {
  const candidates = text.match(/(?:\d[ -]?){13,19}/g) ?? [];
  for (const candidate of candidates) {
    const digits = candidate.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
  }
  return false;
}

export function scanSensitive(text: string, extraPatterns: string[] = []): { hits: string[] } {
  const hits: string[] = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  if (findCardNumbers(text)) hits.push("card-number");
  for (const raw of extraPatterns) {
    try {
      if (new RegExp(raw, "i").test(text)) hits.push(`custom:${raw.slice(0, 30)}`);
    } catch {
      /* invalid user regex — ignore */
    }
  }
  return { hits };
}
