/** Inbound email → project UUID resolution (Resend / generic webhooks). */

export const UUID_IN_TEXT_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

/** Parse "Name <email@x.com>" or "email@x.com" → email@x.com */
export function parseEmailOnly(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

/** Find project UUID embedded in any recipient (e.g. ec9e94e5-...@inbound.domain.com). */
export function extractProjectIdFromAddresses(addresses) {
  if (!Array.isArray(addresses)) return null;
  for (const a of addresses) {
    const email = parseEmailOnly(String(a)).toLowerCase();
    const hit = email.match(UUID_IN_TEXT_RE);
    if (hit) return hit[1];
    const local = email.split('@')[0] || '';
    const hit2 = local.match(UUID_IN_TEXT_RE);
    if (hit2) return hit2[1];
  }
  return null;
}

/** Resolve project UUID from inbound email: webhook ?project_id=..., To/Cc/Bcc, headers, or subject. */
export function extractProjectIdFromInboundPayload(full, query) {
  const rawQ = query && query.project_id != null ? String(query.project_id).trim() : '';
  if (rawQ) {
    const m = rawQ.match(UUID_IN_TEXT_RE);
    if (m) return m[1].toLowerCase();
  }
  const toList = [];
  const push = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) toList.push(typeof x === 'string' ? x : (x && String(x)));
  };
  push(full.to);
  push(full.cc);
  push(full.bcc);
  let pid = extractProjectIdFromAddresses(toList);
  if (pid) return pid.toLowerCase();
  const headers = full.headers;
  if (headers && typeof headers === 'object') {
    try {
      const blob = JSON.stringify(headers);
      const m = blob.match(UUID_IN_TEXT_RE);
      if (m) return m[1].toLowerCase();
    } catch (_) {}
  }
  const subj = String(full.subject || '');
  const m2 = subj.match(UUID_IN_TEXT_RE);
  if (m2) return m2[1].toLowerCase();
  return null;
}
