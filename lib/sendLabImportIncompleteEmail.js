/**
 * Notify sender to complete Lab data when attachment failed strict validation.
 */

function completionBodyHe(missing, filename) {
  const lines = (Array.isArray(missing) ? missing : []).map((m) => `• ${m}`);
  return (
    'שלום,\n\n' +
    'קיבלנו את המצורף לייבוא Lab, אך הנתונים אינם מלאים ולכן לא נשמר קובץ בפרויקט ולא נכנס למאגר מסמכים (RAG).\n\n' +
    `קובץ: ${filename || '(ללא שם)'}\n\n` +
    'מה חסר:\n' +
    (lines.length ? lines.join('\n') : '• פירוט לא זוהה') +
    '\n\n' +
    'אנא השלימו את הטבלה (מזהה ניסוי, שורות נתונים, עמודות חומרים/אחוזים) ושלחו מחדש.\n\n' +
    'בברכה,\n' +
    'המערכת (הודעה אוטומטית)'
  );
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey - RESEND_API_KEY
 * @param {string} opts.fromEmail
 * @param {string} opts.toEmail
 * @param {string|null} opts.replyTo
 * @param {string[]} opts.missing
 * @param {string} opts.filename
 * @returns {Promise<{ sent: boolean, resendError?: string }>}
 */
export async function sendLabImportIncompleteEmail(opts) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) return { sent: false, resendError: 'no_api_key' };
  const to = String(opts.toEmail || '').trim();
  if (!to) return { sent: false, resendError: 'no_recipient' };

  const subject = 'נדרש השלמת נתונים — ייבוא Lab מהמייל';
  const text = completionBodyHe(opts.missing, opts.filename);
  const body = {
    from: opts.fromEmail,
    to: [to],
    subject,
    text
  };
  if (opts.replyTo) body.reply_to = [opts.replyTo];

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { sent: false, resendError: typeof data.message === 'string' ? data.message : `http_${r.status}` };
  }
  return { sent: true };
}
