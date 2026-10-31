export function newSecret(): string {
  return crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );

  return new Uint8Array(digest).toHex();
}
