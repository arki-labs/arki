/** The part of `navigator.clipboard` that copying needs. */
type TextClipboard = Pick<Clipboard, 'writeText'>;

/**
 * Writes text to the clipboard and says what happened. A refused write (permission denied, page not
 * focused, insecure page with no clipboard) is `'failed'`, never a rejection.
 */
export async function copyText(
  text: string,
  clipboard: TextClipboard | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard,
): Promise<'copied' | 'failed'> {
  if (clipboard === undefined) return 'failed';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
