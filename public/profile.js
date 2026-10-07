export const PROFILE_UI_VERSION = "nickname-v1";
export const NICKNAME_MAX_LENGTH = 20;

/** A nickname is display text, never identity, markup, or an availability command. */
export function normalizeNickname(value) {
  if (typeof value !== "string" || value.length > 160) throw new Error("invalid_nickname");
  // Reject control/bidi-spoofing characters. Preserve ordinary Unicode, including Korean.
  if (/[\p{Cc}\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(value)) {
    throw new Error("invalid_nickname");
  }
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (Array.from(name).length > NICKNAME_MAX_LENGTH) throw new Error("nickname_too_long");
  return name;
}
