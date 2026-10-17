/** A `Ui` that collects what text mode prints on stdout, for renderer tests. */
import type { Ui } from '@arki/cli';

export function textUi(): { readonly ui: Ui; readonly text: () => string } {
  let written = '';
  const ui: Ui = {
    out: line => {
      written += line.endsWith('\n') ? line : `${line}\n`;
    },
    info: () => {
      // stderr is not under test
    },
    warn: () => {
      // stderr is not under test
    },
  };
  return { ui, text: () => written };
}
