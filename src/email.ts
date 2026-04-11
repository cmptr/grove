/**
 * Magic link email delivery.
 *
 * Uses Resend API when RESEND_API_KEY is set, otherwise logs to console (dev mode).
 */

export async function sendMagicLinkEmail(email: string, verifyUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(`[auth] Magic link for ${email}:\n  ${verifyUrl}`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.GROVE_FROM_EMAIL ?? "Grove <noreply@grove.md>",
      to: email,
      subject: "Sign in to Grove",
      html: `<p>Click the link below to sign in to Grove:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[auth] Resend API error: ${res.status} ${body}`);
  }
}
