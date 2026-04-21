import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("sendMagicLinkEmail", () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESEND_API_KEY;
  });

  it("logs to console in dev mode (no RESEND_API_KEY)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendMagicLinkEmail } = await import("../src/email.js");

    await sendMagicLinkEmail("test@example.com", "https://api.grove.md/auth/verify?token=abc");

    expect(logSpy).toHaveBeenCalledOnce();
    const loggedMessage = logSpy.mock.calls[0]![0] as string;
    expect(loggedMessage).toContain("test@example.com");
  });

  it("calls Resend API with correct payload in prod mode", async () => {
    process.env.RESEND_API_KEY = "re_test_123";

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    // Re-import to pick up env change
    const { sendMagicLinkEmail } = await import("../src/email.js");

    await sendMagicLinkEmail("user@example.com", "https://api.grove.md/auth/verify?token=abc");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("Bearer re_test_123");

    const body = JSON.parse(options.body);
    expect(body.to).toBe("user@example.com");
    expect(body.subject).toBe("Sign in to Grove");
    expect(body.html).toContain("https://api.grove.md/auth/verify?token=abc");
  });

  it("welcome email names the resident via @handle (P16-4)", async () => {
    process.env.RESEND_API_KEY = "re_test_123";
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const { sendMagicLinkEmail } = await import("../src/email.js");

    await sendMagicLinkEmail(
      "invitee@example.com",
      "https://api.grove.md/auth/verify?token=xyz",
      { welcome: true, trailName: "Weekly Reads", ownerHandle: "jm", ownerDisplayName: "John Milinovich" },
    );

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
    expect(body.subject).toBe("@jm invited you to Grove");
    expect(body.html).toContain("@jm");
    expect(body.html).toContain("John Milinovich");
    expect(body.html).toContain("Weekly Reads");
    expect(body.html).toContain("Sign in");
  });
});
