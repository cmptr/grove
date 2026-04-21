/**
 * Magic link email delivery.
 *
 * Uses Resend API when RESEND_API_KEY is set, otherwise logs to console (dev mode).
 */

export async function sendMagicLinkEmail(email: string, verifyUrl: string, opts?: { welcome?: boolean; trailName?: string; ownerHandle?: string; ownerDisplayName?: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const welcome = opts?.welcome ?? false;
  const ownerHandle = opts?.ownerHandle;
  const ownerDisplayName = opts?.ownerDisplayName ?? (ownerHandle ? `@${ownerHandle}` : "Someone");
  const trailName = opts?.trailName ?? "a knowledge trail";

  const subject = welcome
    ? (ownerHandle ? `@${ownerHandle} invited you to Grove` : "You've been invited to Grove")
    : "Sign in to Grove";
  const welcomeIntro = ownerHandle
    ? `${ownerDisplayName} (@${ownerHandle}) shared the '${trailName}' trail with you.`
    : `You've been invited to access <strong>${trailName}</strong> on Grove.`;
  const html = welcome
    ? `<p>${welcomeIntro}</p><p><a href="${verifyUrl}">Sign in</a></p><p>This link expires in 15 minutes.</p>`
    : `<p>Click the link below to sign in to Grove:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 15 minutes.</p>`;

  if (!apiKey) {
    console.log(`[auth] ${welcome ? "Invite" : "Magic"} link for ${email}:\n  ${verifyUrl}`);
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
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[auth] Resend API error: ${res.status} ${body}`);
  }
}
